import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SgpUraClient } from "../src/integrations/sgp/sgpClient.js";
import { DEFAULT_PRODUCTION_CORS_ORIGINS, loadConfig, type AppConfig } from "../src/config.js";
import { validateNewPassword } from "../src/auth/passwordPolicy.js";
import { COMMON_PASSWORD_COUNT } from "../src/auth/commonPasswords.js";
import { deriveCustomerId, hmacCustomerId, legacyCustomerId, mapSgpCustomer } from "../src/integrations/sgp/sgpMapper.js";
import { OwnershipService } from "../src/security/ownership.js";
import { InMemoryStore } from "../src/repositories/inMemoryStore.js";

function sgpConfig(extra: Partial<AppConfig["sgp"]> = {}): AppConfig["sgp"] {
  return {
    enabled: true,
    baseUrl: "https://sgp.test",
    app: "noc",
    token: "test-token",
    basicUsername: undefined,
    basicPassword: undefined,
    timeoutMs: 8000,
    cpfSearchFields: ["cpfcnpj", "cpf_cnpj", "cpfCnpj", "cpf"],
    chamado: { app: undefined, token: undefined, timeoutMs: 15000, semOs: undefined, mapping: {}, documents: { ocorrenciaTipo: "10013", motivoOs: "2125", setor: "3" } },
    sign: { enabled: false, app: undefined, token: undefined, timeoutMs: 10000 },
    ...extra
  };
}

const okEmpty = { ok: true, status: 200, json: async () => ({}) };

describe("SgpUraClient - fan-out, cache, teto e circuit breaker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okEmpty);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("documento inexistente: no maximo 4 chamadas (antes 16) e a repeticao vem do cache negativo", async () => {
    const client = new SgpUraClient(sgpConfig());
    expect(await client.consultCustomerByDocument("52998224725")).toEqual([]);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    const after = fetchMock.mock.calls.length;
    await client.consultCustomerByDocument("529.982.247-25");
    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it("campo de busca rejeitado (400) passa para o proximo campo; 200 vazio NAO varre os outros campos", async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = new URLSearchParams(init.body);
      if (body.has("cpfcnpj")) return { ok: false, status: 400, json: async () => ({}) };
      return okEmpty;
    });
    const client = new SgpUraClient(sgpConfig());
    await client.consultCustomerByDocument("52998224725");
    const fieldsTried = new Set(fetchMock.mock.calls.map((call) => [...new URLSearchParams((call[1] as { body: string }).body).keys()].find((k) => k.startsWith("cpf"))));
    expect(fieldsTried.has("cpfcnpj")).toBe(true);
    expect(fieldsTried.has("cpf_cnpj")).toBe(true);
    expect(fieldsTried.has("cpfCnpj")).toBe(false); // cpf_cnpj respondeu 200 vazio: os demais sao redundantes
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("acha o cliente: devolve os contratos e aprende endpoint/campo/formato (proximo documento usa so ele)", async () => {
    fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
      const body = new URLSearchParams(init.body);
      const value = body.get("cpfcnpj") ?? "";
      if (url.endsWith("/api/ura/clientes/") && value === "529.982.247-25") {
        return { ok: true, status: 200, json: async () => ({ clientes: [{ id: 1, contratos: [{ id: 9 }] }] }) };
      }
      return okEmpty;
    });
    const client = new SgpUraClient(sgpConfig());
    expect(await client.consultCustomerByDocument("52998224725")).toHaveLength(1);
    fetchMock.mockClear();
    await client.consultCustomerByDocument("11144477735"); // outro CPF, ja com o formato aprendido
    // 1 chamada em /clientes/ (so o formato aprendido) + 2 em /consultacliente/ (ainda nao aprendido)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("sem Basic Auth o token vai direto no corpo (antes: 1a chamada sem credencial e 2a repetida com token)", async () => {
    const client = new SgpUraClient(sgpConfig({ cpfSearchFields: ["cpfcnpj"] }));
    await client.consultCustomerByContract("5989");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.get("token")).toBe("test-token");
    expect(body.get("app")).toBe("noc");
  });

  it("teto de buscas por documento por minuto: acima dele responde 503 SGP_BUSY sem chamar o SGP", async () => {
    const client = new SgpUraClient(sgpConfig({ maxLookupCallsPerMinute: 8 }));
    const docs = ["52998224725", "11144477735", "39053344705", "12345678909"];
    const results = await Promise.allSettled(docs.map((doc) => client.consultCustomerByDocument(doc)));
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.length).toBeGreaterThan(0);
    expect((rejected[0]!.reason as { code: string }).code).toBe("SGP_BUSY");
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("circuit breaker: apos N falhas de infraestrutura consecutivas o SGP nao e mais chamado por um tempo", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const client = new SgpUraClient(sgpConfig({ circuitFailureThreshold: 3, circuitOpenMs: 60_000, cpfSearchFields: ["cpfcnpj"] }));
    for (let i = 0; i < 3; i += 1) await expect(client.consultCustomerByContract(`c${i}`)).rejects.toMatchObject({ code: "SGP_REQUEST_FAILED" });
    const callsBefore = fetchMock.mock.calls.length;
    await expect(client.consultCustomerByContract("c99")).rejects.toMatchObject({ code: "SGP_CIRCUIT_OPEN" });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("teto global de chamadas por minuto", async () => {
    const client = new SgpUraClient(sgpConfig({ maxCallsPerMinute: 3 }));
    for (let i = 0; i < 3; i += 1) await client.consultCustomerByContract(`g${i}`);
    await expect(client.consultCustomerByContract("g9")).rejects.toMatchObject({ code: "SGP_BUSY" });
  });
});

describe("M3 - politica de senha", () => {
  const options = { initialPassword: "acessanet" };
  it("bloqueia senhas comuns (embutidas), inclusive variacoes simples", () => {
    expect(COMMON_PASSWORD_COUNT).toBeGreaterThanOrEqual(1000);
    for (const weak of ["senha1234", "Senha123", "qwerty123", "Brasil2024", "flamengo1", "S3nh@123", "acessanet123", "password1", "abc12345"]) {
      expect(() => validateNewPassword(weak, options), weak).toThrow(/comum|inicial/i);
    }
  });
  it("aceita senha forte e mantem as regras antigas", () => {
    expect(() => validateNewPassword("Tulipa-Roxa-47", options)).not.toThrow();
    expect(() => validateNewPassword("curta1", options)).toThrow();
    expect(() => validateNewPassword("semnumeroaqui", options)).toThrow();
    expect(() => validateNewPassword("12345678901", options)).toThrow();
  });
  it("nao pode conter o proprio CPF", () => {
    expect(() => validateNewPassword("x52998224725y", { ...options, documentDigits: "52998224725" })).toThrow(/CPF/);
  });
});

describe("M4 - customerId por HMAC", () => {
  it("por padrao continua legado (contratos em cache/sessoes antigas intactos); com segredo vira HMAC e nao e reversivel por sha256", () => {
    const contracts = [{ id: 1, cpfcnpj: "52998224725" }];
    const legacy = mapSgpCustomer("52998224725", contracts);
    expect(legacy?.customer.id).toBe(legacyCustomerId("52998224725"));
    const hmac = mapSgpCustomer("52998224725", contracts, { hmacSecret: "segredo-de-teste-com-mais-de-32-caracteres" });
    expect(hmac?.customer.id).toBe(hmacCustomerId("52998224725", "segredo-de-teste-com-mais-de-32-caracteres"));
    expect(hmac?.customer.id).not.toBe(legacy?.customer.id);
    expect(hmac?.customer.id.startsWith("customer_h1_")).toBe(true);
    expect(deriveCustomerId("52998224725", { hmacSecret: "outro-segredo-qualquer-com-32-caracteres" })).not.toBe(hmac?.customer.id);
  });

  it("ownership reverifica no SGP e aceita tanto o id legado quanto o HMAC do MESMO cliente (migracao), nunca de outro", async () => {
    const secret = "segredo-de-teste-com-mais-de-32-caracteres";
    const sgp = {
      customerIdSecret: secret,
      consultCustomerByContract: async () => [{ id: 777, cpfcnpj: "52998224725", status: 1 }]
    } as unknown as SgpUraClient;
    const ownership = new OwnershipService(new InMemoryStore(), sgp);
    await expect(ownership.assertContract(legacyCustomerId("52998224725"), "777")).resolves.toBeTruthy();
    await expect(ownership.assertContract(hmacCustomerId("52998224725", secret), "777")).resolves.toBeTruthy();
    await expect(ownership.assertContract(hmacCustomerId("11144477735", secret), "777")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    // sem o segredo (flag desligada) o HMAC nao e reconhecido
    const off = new OwnershipService(new InMemoryStore(), { ...sgp, customerIdSecret: undefined, consultCustomerByContract: sgp.consultCustomerByContract } as unknown as SgpUraClient);
    await expect(off.assertContract(hmacCustomerId("52998224725", secret), "777")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

describe("M1/B3 + CORS - config", () => {
  const strongEnv = () => {
    vi.stubEnv("JWT_SECRET", "j".repeat(40));
    vi.stubEnv("CPF_HASH_SECRET", "c".repeat(40));
    vi.stubEnv("OTP_HASH_SECRET", "o".repeat(40));
    vi.stubEnv("ADMIN_JWT_SECRET", "a".repeat(40));
  };
  afterEach(() => vi.unstubAllEnvs());

  it("sem NODE_ENV e sem STRICT_ENV NAO falha (producao de hoje reporta 'development'): so avisa alto", () => {
    vi.stubEnv("NODE_ENV", undefined as unknown as string);
    vi.stubEnv("STRICT_ENV", undefined as unknown as string);
    vi.stubEnv("CORS_ORIGINS", undefined as unknown as string);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = loadConfig();
    expect(config.env).toBe("development");
    expect(config.corsOrigins).toBe(true); // fora de producao reflete (inalterado)
    expect(warn.mock.calls.flat().join(" ")).toMatch(/NODE_ENV nao esta definido/);
    warn.mockRestore();
  });

  it("STRICT_ENV=1 sem NODE_ENV=production falha na subida", () => {
    vi.stubEnv("NODE_ENV", undefined as unknown as string);
    vi.stubEnv("STRICT_ENV", "1");
    strongEnv();
    expect(() => loadConfig()).toThrow(/STRICT_ENV=1 exige NODE_ENV=production/);
  });

  it("STRICT_ENV=1 + NODE_ENV=production sem segredos fortes falha; com segredos sobe e usa CORS fixo", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STRICT_ENV", "1");
    vi.stubEnv("CORS_ORIGINS", undefined as unknown as string);
    vi.stubEnv("JWT_SECRET", "curto");
    expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    strongEnv();
    const config = loadConfig();
    expect(config.corsOrigins).toEqual(DEFAULT_PRODUCTION_CORS_ORIGINS);
    expect(config.corsOrigins).toEqual(["https://acessanet.com.br", "https://localhost", "capacitor://localhost"]);
  });

  it("NODE_ENV=production sem CORS_ORIGINS nunca usa 'true'; CORS_ORIGINS='*' em producao cai na lista fixa", () => {
    vi.stubEnv("NODE_ENV", "production");
    strongEnv();
    vi.stubEnv("CORS_ORIGINS", undefined as unknown as string);
    expect(loadConfig().corsOrigins).toEqual(DEFAULT_PRODUCTION_CORS_ORIGINS);
    vi.stubEnv("CORS_ORIGINS", "*");
    expect(loadConfig().corsOrigins).toEqual(DEFAULT_PRODUCTION_CORS_ORIGINS);
    vi.stubEnv("CORS_ORIGINS", "https://a.example, https://b.example");
    expect(loadConfig().corsOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  it("STRICT_ENV=1 desliga o mock de assinatura e a rota de debug da OLT por padrao", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STRICT_ENV", "1");
    vi.stubEnv("SGP_SIGN_MOCK_ENABLED", "true");
    vi.stubEnv("OLTCLOUD_DEBUG_ENABLED", undefined as unknown as string);
    strongEnv();
    const config = loadConfig();
    expect(config.sgpSignMock.enabled).toBe(false);
    expect(config.oltCloud.debug.enabled).toBe(false);
  });
});
