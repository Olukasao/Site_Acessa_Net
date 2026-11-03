import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { hashPassword, sha256 } from "../src/security/hash.js";
import { isValidCpf } from "../src/auth/cpf.js";

/** CPFs com digito verificador valido. */
const CPF_A = "52998224725"; // cliente COM e-mail
const CPF_B = "11144477735"; // cliente SEM e-mail
const CPF_C = "39053344705"; // cliente COM e-mail (outra pessoa)

type Person = { name: string; email: string; contractId: number };
const PEOPLE: Record<string, Person> = {
  [CPF_A]: { name: "Ana Teste", email: "ana.teste@example.com", contractId: 1001 },
  [CPF_B]: { name: "Bruno Sem Email", email: "", contractId: 1002 },
  [CPF_C]: { name: "Carla Teste", email: "carla.teste@example.com", contractId: 1003 }
};

let sgpCalls = 0;

/** SGP simulado: so responde a busca por documento (clientes/consultacliente). Conta TODA chamada. */
function stubSgp() {
  sgpCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      sgpCalls += 1;
      const params = new URLSearchParams(init?.body ?? "");
      const doc = [...params.values()].map((value) => value.replace(/\D/g, "")).find((value) => PEOPLE[value]);
      const person = doc ? PEOPLE[doc] : undefined;
      const body = person
        ? {
            clientes: [
              {
                id: 1,
                nome: person.name,
                email: person.email,
                contratos: [{ id: person.contractId, cpfcnpj: doc, status: 1, endereco_cidade: "X", endereco_uf: "SP", email: person.email }]
              }
            ]
          }
        : {};
      return { ok: true, status: 200, json: async () => body };
    })
  );
}

function makeContainer(sqlitePath = ":memory:") {
  const container = createContainer({ env: "test", sqlitePath, sgp: { app: "t", token: "t" } });
  const sent: Array<{ to: string; code: string }> = [];
  // Mailer de teste (o container usa UnconfiguredMailer sem SMTP).
  (container.passwordResetService as unknown as { mailer: unknown }).mailer = {
    sendOtpEmail: async (input: { to: string; code: string }) => {
      sent.push({ to: input.to, code: input.code });
    },
    verifyConnection: async () => ({ ok: true })
  };
  return { container, sent };
}

async function post(app: Awaited<ReturnType<typeof buildApp>>, url: string, payload: unknown, ip = "198.51.100.10") {
  return app.inject({
    method: "POST",
    url,
    payload: payload as Record<string, unknown>,
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": ip }
  });
}

/** Gera CPFs validos distintos (nenhum cadastrado no SGP simulado). */
function fakeCpfs(count: number) {
  const out: string[] = [];
  for (let seed = 100000000; out.length < count; seed += 7919) {
    const base = String(seed).slice(0, 9).padStart(9, "0");
    const digit = (digits: number[]) => {
      const sum = digits.reduce((acc, value, index) => acc + value * (digits.length + 1 - index), 0);
      const mod = (sum * 10) % 11;
      return mod === 10 ? 0 : mod;
    };
    const nums = base.split("").map(Number);
    const d1 = digit(nums);
    const d2 = digit([...nums, d1]);
    const cpf = `${base}${d1}${d2}`;
    if (isValidCpf(cpf) && !PEOPLE[cpf]) out.push(cpf);
  }
  return out;
}

beforeEach(() => stubSgp());
afterEach(() => vi.unstubAllGlobals());

describe("A1 - primeiro acesso com prova de posse", () => {
  it("setup sem token de verificacao e recusado e nao devolve sessao (cliente antigo / atacante so com o CPF)", async () => {
    const { container } = makeContainer();
    const app = await buildApp(container);
    const response = await post(app, "/api/auth/local/setup", { cpf: CPF_A, newPassword: "Tulipa-Roxa-47", confirmPassword: "Tulipa-Roxa-47" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("SETUP_TOKEN_REQUIRED");
    expect(response.json().accessToken).toBeUndefined();
    const profile = await container.authProfiles.findByCpfHash(
      (container.localPasswordAuthService as unknown as { cpfHash: (d: string) => string }).cpfHash(CPF_A)
    );
    expect(profile?.passwordHash ?? null).toBeNull();
    await app.close();
  });

  it("token inventado ou de outro CPF e recusado", async () => {
    const { container, sent } = makeContainer();
    const app = await buildApp(container);
    expect((await post(app, "/api/auth/local/setup", { cpf: CPF_A, setupToken: "x".repeat(43), newPassword: "Tulipa-Roxa-47" })).json().error.code).toBe(
      "SETUP_TOKEN_INVALID"
    );

    // Token legitimo da vitima A nao serve para o CPF C.
    await post(app, "/api/auth/local/first-access/request", { cpf: CPF_A });
    const verify = await post(app, "/api/auth/local/verify-reset-code", { cpf: CPF_A, code: sent[0]!.code });
    const token = verify.json().resetToken as string;
    const wrongCpf = await post(app, "/api/auth/local/setup", { cpf: CPF_C, setupToken: token, newPassword: "Tulipa-Roxa-47" });
    expect(wrongCpf.json().error.code).toBe("SETUP_TOKEN_INVALID");
    await app.close();
  });

  it("fluxo completo: OTP por e-mail -> token -> senha (sem sessao) -> login normal; token e de uso unico", async () => {
    const { container, sent } = makeContainer();
    const app = await buildApp(container);

    const check = await post(app, "/api/auth/local/check", { cpf: CPF_A });
    expect(check.json()).toEqual({ hasPassword: false });

    const req = await post(app, "/api/auth/local/first-access/request", { cpf: CPF_A });
    expect(req.json()).toMatchObject({ status: "sent", maskedEmail: expect.stringContaining("***") });
    expect(JSON.stringify(req.json())).not.toContain("ana.teste@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ana.teste@example.com");

    // codigo errado nao entrega token
    expect((await post(app, "/api/auth/local/verify-reset-code", { cpf: CPF_A, code: "000000" })).statusCode).toBe(400);
    const verify = await post(app, "/api/auth/local/verify-reset-code", { cpf: CPF_A, code: sent[0]!.code });
    expect(verify.statusCode).toBe(200);
    const token = verify.json().resetToken as string;

    // senha comum e recusada SEM queimar o token
    const weak = await post(app, "/api/auth/local/setup", { cpf: CPF_A, setupToken: token, newPassword: "senha1234", confirmPassword: "senha1234" });
    expect(weak.json().error.code).toBe("PASSWORD_POLICY_REJECTED");

    const ok = await post(app, "/api/auth/local/setup", { cpf: CPF_A, setupToken: token, newPassword: "Tulipa-Roxa-47", confirmPassword: "Tulipa-Roxa-47" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(ok.json().accessToken).toBeUndefined();

    expect((await post(app, "/api/auth/local/check", { cpf: CPF_A })).json()).toEqual({ hasPassword: true });
    const login = await post(app, "/api/auth/local/login", { cpf: CPF_A, password: "Tulipa-Roxa-47" });
    expect(login.statusCode).toBe(200);
    expect(login.json().accessToken).toBeTruthy();

    // reuso do token
    const again = await post(app, "/api/auth/local/setup", { cpf: CPF_A, setupToken: token, newPassword: "Outra-Senha-91x" });
    expect(["SETUP_TOKEN_INVALID", "PASSWORD_ALREADY_SET"]).toContain(again.json().error.code);
    await app.close();
  });

  it("cliente SEM e-mail e CPF inexistente recebem a MESMA resposta (suporte), sem e-mail enviado", async () => {
    const { container, sent } = makeContainer();
    const app = await buildApp(container);
    const noEmail = await post(app, "/api/auth/local/first-access/request", { cpf: CPF_B });
    const unknown = await post(app, "/api/auth/local/first-access/request", { cpf: fakeCpfs(1)[0] });
    expect(noEmail.json()).toEqual(unknown.json());
    expect(noEmail.json().status).toBe("unavailable");
    expect(noEmail.json().message).toMatch(/suporte|WhatsApp/i);
    expect(sent).toHaveLength(0);
    await app.close();
  });

  it("/check nao consulta o SGP e responde igual para CPF inexistente", async () => {
    const { container } = makeContainer();
    const app = await buildApp(container);
    const unknown = await post(app, "/api/auth/local/check", { cpf: fakeCpfs(1)[0] });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ hasPassword: false });
    expect(sgpCalls).toBe(0);
    await app.close();
  });
});

describe("A2/A3 - rate limit e amplificacao no SGP", () => {
  it("60 requisicoes a masked-email com CPFs inexistentes: 429 apos o limite e pouquissimas chamadas ao SGP", async () => {
    const { container } = makeContainer();
    const app = await buildApp(container);
    const cpfs = fakeCpfs(60);
    const statuses: number[] = [];
    for (const cpf of cpfs) {
      statuses.push((await post(app, "/api/auth/local/forgot-password/masked-email", { cpf }, "203.0.113.50")).statusCode);
    }
    const ok = statuses.filter((status) => status === 404).length;
    const limited = statuses.filter((status) => status === 429).length;
    expect(ok).toBe(6);
    expect(limited).toBe(54);
    // 6 consultas x no maximo 4 chamadas (2 endpoints x 2 formatos), nunca as 16 de antes.
    expect(sgpCalls).toBeLessThanOrEqual(24);
    await app.close();
  });

  it("o mesmo CPF inexistente 60x gera no maximo 1 consulta ao SGP (cache negativo) e 429 apos o limite por CPF", async () => {
    const { container } = makeContainer();
    const app = await buildApp(container);
    const cpf = fakeCpfs(1)[0];
    const codes: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      // IPs diferentes: so o limite POR CPF pode barrar.
      codes.push((await post(app, "/api/auth/local/forgot-password/masked-email", { cpf }, `203.0.113.${i + 1}`)).statusCode);
    }
    expect(codes.filter((code) => code === 429).length).toBe(55);
    expect(sgpCalls).toBeLessThanOrEqual(4);
    await app.close();
  });

  it("o limite por CPF e PERSISTIDO: sobrevive a reinicio (novo container, mesmo banco)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acessanet-rl-"));
    const dbPath = path.join(dir, "auth.sqlite");
    try {
      const first = makeContainer(dbPath);
      const app1 = await buildApp(first.container);
      const cpf = fakeCpfs(1)[0];
      for (let i = 0; i < 5; i += 1) {
        expect((await post(app1, "/api/auth/local/forgot-password/masked-email", { cpf }, `203.0.113.${i + 1}`)).statusCode).toBe(404);
      }
      expect((await post(app1, "/api/auth/local/forgot-password/masked-email", { cpf }, "203.0.113.99")).statusCode).toBe(429);
      await app1.close();

      // "reinicio": memoria zerada, mesmo arquivo
      const second = makeContainer(dbPath);
      const app2 = await buildApp(second.container);
      expect((await post(app2, "/api/auth/local/forgot-password/masked-email", { cpf }, "203.0.113.150")).statusCode).toBe(429);
      await app2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/forgot-password: mais de 5 pedidos por CPF/hora nao enviam mais e-mail (resposta continua generica)", async () => {
    const { container, sent } = makeContainer();
    const app = await buildApp(container);
    for (let i = 0; i < 8; i += 1) {
      const res = await post(app, "/api/auth/local/forgot-password", { cpf: CPF_C }, `203.0.113.${i + 1}`);
      expect(res.statusCode).toBe(200);
    }
    // cooldown de 60s ja limita a 1; o teto por CPF garante que, passando o cooldown, nao passa de 5.
    expect(sent.length).toBeLessThanOrEqual(5);
    await app.close();
  });

  it("falhas de login por CPF (20/h) valem de QUALQUER IP: apos 20, nem a senha certa entra (429)", async () => {
    const { container } = makeContainer();
    const app = await buildApp(container);
    const cpfHash = (container.localPasswordAuthService as unknown as { cpfHash: (d: string) => string }).cpfHash(CPF_A);
    await container.authProfiles.getOrCreate({ cpfHash, cpfLastDigits: "4725", sgpCustomerId: null });
    await container.authProfiles.setPasswordHash(cpfHash, await hashPassword("Tulipa-Roxa-47"), new Date());

    for (let i = 0; i < 20; i += 1) {
      const res = await post(app, "/api/auth/local/login", { cpf: CPF_A, password: "errada-" + i }, `198.51.100.${i + 1}`);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await post(app, "/api/auth/local/login", { cpf: CPF_A, password: "Tulipa-Roxa-47" }, "198.51.100.200");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
    await app.close();
  }, 30_000);
});

describe("B1 - reuso de refresh token", () => {
  it("reapresentar um refresh token ja rotacionado (fora da janela de corrida) revoga a sessao inteira", async () => {
    const { container } = makeContainer();
    const app = await buildApp(container);
    const cpfHash = (container.localPasswordAuthService as unknown as { cpfHash: (d: string) => string }).cpfHash(CPF_A);
    await container.authProfiles.getOrCreate({ cpfHash, cpfLastDigits: "4725", sgpCustomerId: null });
    await container.authProfiles.setPasswordHash(cpfHash, await hashPassword("Tulipa-Roxa-47"), new Date());
    const login = (await post(app, "/api/auth/local/login", { cpf: CPF_A, password: "Tulipa-Roxa-47" })).json();

    const rotated = await post(app, "/v1/auth/refresh", { refreshToken: login.refreshToken });
    expect(rotated.statusCode).toBe(200);
    const fresh = rotated.json();

    // Corrida benigna (<30s): 401, mas a sessao continua viva com o token novo.
    expect((await post(app, "/v1/auth/refresh", { refreshToken: login.refreshToken })).statusCode).toBe(401);
    expect((await post(app, "/v1/auth/refresh", { refreshToken: fresh.refreshToken })).statusCode).toBe(200);

    // Reuso real (depois de 31s): revoga a sessao -- ate o refresh token mais novo deixa de valer.
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 31_000);
    const reuse = await post(app, "/v1/auth/refresh", { refreshToken: login.refreshToken });
    expect(reuse.statusCode).toBe(401);
    spy.mockRestore();
    const afterReuse = await post(app, "/v1/auth/refresh", { refreshToken: fresh.refreshToken });
    expect(afterReuse.statusCode).toBe(401);
    await app.close();
  });
});

describe("M5 - OTP", () => {
  it("incremento de tentativas e atomico e limitado (UPDATE ... WHERE otp_attempts < max)", async () => {
    const { container } = makeContainer();
    const repo = container.passwordResets;
    const record = await repo.createRequest({ id: "r1", cpfHash: "h", otpHash: "x", otpExpiresAt: new Date(Date.now() + 60_000) });
    const results = await Promise.all(Array.from({ length: 12 }, () => repo.incrementOtpAttempts(record.id, 5)));
    expect(results.filter((value) => value !== null)).toHaveLength(5);
    expect((await repo.findActiveByCpfHash("h"))?.otpAttempts).toBe(5);
    expect(await repo.incrementOtpAttempts(record.id, 5)).toBeNull();
  });

  it("claimResetToken so funciona uma vez", async () => {
    const { container } = makeContainer();
    const repo = container.passwordResets;
    const record = await repo.createRequest({ id: "r2", cpfHash: "h2", otpHash: "x", otpExpiresAt: new Date(Date.now() + 60_000) });
    await repo.setResetToken(record.id, sha256("t"), new Date(Date.now() + 60_000));
    const [a, b] = await Promise.all([repo.claimResetToken(record.id, new Date()), repo.claimResetToken(record.id, new Date())]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("B5/B8", () => {
  it("metadata de /v1/central/activity: muitas chaves ou JSON grande -> 400", async () => {
    const { container } = makeContainer();
    const app = await buildApp(container);
    const cpfHash = (container.localPasswordAuthService as unknown as { cpfHash: (d: string) => string }).cpfHash(CPF_A);
    await container.authProfiles.getOrCreate({ cpfHash, cpfLastDigits: "4725", sgpCustomerId: null });
    await container.authProfiles.setPasswordHash(cpfHash, await hashPassword("Tulipa-Roxa-47"), new Date());
    const login = (await post(app, "/api/auth/local/login", { cpf: CPF_A, password: "Tulipa-Roxa-47" })).json();
    const headers = { authorization: `Bearer ${login.accessToken}` };
    const send = (metadata: unknown) =>
      app.inject({ method: "POST", url: "/v1/central/activity", headers, payload: { eventType: "VIEW_HOME", page: "home", metadata } as never });

    expect((await send({ a: 1 })).statusCode).toBe(200);
    const manyKeys = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect((await send(manyKeys)).statusCode).toBe(400);
    expect((await send({ big: "x".repeat(3000) })).statusCode).toBe(400);
    expect((await send({ ["k".repeat(61)]: 1 })).statusCode).toBe(400);
    await app.close();
  });

  it("curriculo: o limite por IP conta ANTES do parse do corpo (corpo invalido tambem consome)", async () => {
    const { container } = makeContainer();
    const app = await buildApp(container);
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/careers/applications",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.77" },
        remoteAddress: "127.0.0.1",
        payload: "{ isto nao e json"
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 3).every((code) => code === 400)).toBe(true);
    expect(codes[3]).toBe(429);
    await app.close();
  });
});
