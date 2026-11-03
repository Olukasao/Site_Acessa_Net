import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { hashPassword } from "../src/security/hash.js";
import { crashSignature, crashTitle, scrubCrashText } from "../src/support/crashSanitizer.js";
import { groupCrashes } from "../src/support/crashReport.js";

let ipCounter = 0;
const freshIp = () => `10.11.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function setup() {
  const container = createContainer({ env: "test", sqlitePath: ":memory:", sgp: { basicUsername: "t", basicPassword: "t" } } as never);
  const app = await buildApp(container);
  return { container, app };
}

const crash = (over: Record<string, unknown> = {}) => ({
  kind: "native",
  message: "java.lang.NullPointerException: Attempt to invoke virtual method on a null object",
  stack: "java.lang.NullPointerException\n\tat br.com.acessanet.portal.Push.register(Push.java:42)\n\tat android.os.Handler.handleCallback(Handler.java:938)",
  appVersion: "1.0.11",
  deviceId: "dev-aaaaaaaa-1111",
  deviceModel: "Pixel 7",
  androidVersion: "14",
  ...over
});

describe("filtro de dados sensiveis", () => {
  it("tira e-mail, CPF, numeros longos, tokens e query string", () => {
    const text = scrubCrashText(
      "erro para joao@exemplo.com cpf 395.813.238-30 tel 11999990000 Bearer abc.def.ghi https://x.com.br/api?cpf=39581323830&t=1 eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMe linha 42"
    );
    expect(text).not.toMatch(/joao@|395\.813|11999990000|39581323830|eyJhbGci|abc\.def/);
    expect(text).toContain("[email]");
    expect(text).toContain("linha 42");
  });

  it("assinatura ignora numeros de linha e dados variaveis, mas separa erros diferentes", () => {
    const stackA = "Error\n\tat Push.register (Push.java:42)\n\tat Handler.run (Handler.java:10)";
    const stackB = "Error\n\tat Push.register (Push.java:57)\n\tat Handler.run (Handler.java:11)";
    expect(crashSignature("js", "Falha no contrato 3005", stackA)).toBe(crashSignature("js", "Falha no contrato 9999", stackB));
    expect(crashSignature("js", "Falha", stackA)).not.toBe(crashSignature("native", "Falha", stackA));
    expect(crashSignature("js", "Falha", stackA)).not.toBe(crashSignature("js", "Outra falha", stackA));
    expect(crashTitle("primeira\nsegunda")).toBe("primeira");
  });
});

describe("POST /v1/app-crashes", () => {
  const send = (app: Awaited<ReturnType<typeof setup>>["app"], payload: unknown, ip = freshIp()) =>
    app.inject({ method: "POST", url: "/v1/app-crashes", payload: payload as never, remoteAddress: ip });

  it("aceita sem login, filtra o texto e agrupa o mesmo erro", async () => {
    const { app, container } = await setup();
    const res = await send(app, crash({ message: "falha para maria@x.com", stack: "Error\n\tat a (b.js:1:2)\nhttps://x.br/p?token=segredo123" }));
    expect(res.statusCode).toBe(202);
    await send(app, crash({ deviceId: "dev-bbbbbbbb-2222", appVersion: "1.0.10" }));
    await send(app, crash({ deviceId: "dev-cccccccc-3333" }));
    const rows = await container.appCrashes.listInRange(new Date(0), new Date(Date.now() + 1000), 100);
    expect(rows).toHaveLength(3);
    const stored = (await container.appCrashes.listBySignature(rows[2]!.signature, 5))[0]!;
    expect(JSON.stringify(stored)).not.toMatch(/maria@|segredo123/);
    const groups = groupCrashes(rows, new Map());
    expect(groups.find((g) => g.count === 2)).toMatchObject({ devices: 2, versions: ["1.0.11", "1.0.10"], status: "novo" });
    await app.close();
  });

  it("aceita o relatorio do SITE (versao 'site', navegador e sistema) e agrupa o mesmo erro entre deploys", async () => {
    const { app, container } = await setup();
    const site = (stack: string, deviceId: string) =>
      crash({ kind: "js", message: "TypeError: Cannot read properties of undefined (reading 'x')", stack, appVersion: "site", deviceId, deviceModel: "Chrome 130", androidVersion: "Windows" });

    // O navegador ja tira dominio e hash do arquivo (errorReporter.js): o mesmo erro em deploys diferentes chega igual.
    expect((await send(app, site("TypeError: x\n    at f (/assets/ClienteArea.js:10:20)\n    at g (/assets/index.js:3:4)", "dev-site0001-aaaa"))).statusCode).toBe(202);
    expect((await send(app, site("TypeError: x\n    at f (/assets/ClienteArea.js:99:7)\n    at g (/assets/index.js:8:1)", "dev-site0002-bbbb"))).statusCode).toBe(202);

    const rows = await container.appCrashes.listInRange(new Date(0), new Date(Date.now() + 1000), 100);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ appVersion: "site", deviceModel: "Chrome 130", androidVersion: "Windows" });
    const groups = groupCrashes(rows, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 2, devices: 2, versions: ["site"] });
    await app.close();
  });

  it("valida o formato e o tamanho", async () => {
    const { app } = await setup();
    for (const bad of [crash({ kind: "x" }), crash({ deviceId: "curto" }), crash({ stack: "x".repeat(13000) }), crash({ appVersion: "" }), {}]) {
      expect((await send(app, bad)).statusCode).toBe(400);
    }
    await app.close();
  });

  it("limita envios por aparelho", async () => {
    const { app } = await setup();
    let blocked = 0;
    for (let i = 0; i < 25; i += 1) if ((await send(app, crash({ message: `erro ${i}` }))).statusCode === 429) blocked += 1;
    expect(blocked).toBeGreaterThan(0);
    await app.close();
  });

  it("data de ocorrencia futura ou muito antiga vira agora", async () => {
    const { app, container } = await setup();
    await send(app, crash({ occurredAt: "2020-01-01T00:00:00.000Z" }));
    const rows = await container.appCrashes.listInRange(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), 10);
    expect(rows).toHaveLength(1);
    await app.close();
  });
});

describe("retencao e Admin", () => {
  it("apaga ocorrencias antigas e o status que ficou sem ocorrencia", async () => {
    const { container, app } = await setup();
    const base = { signature: "a".repeat(32), kind: "js" as const, title: "t", stack: "s", appVersion: "1", deviceId: "d", deviceModel: "m", androidVersion: "14" };
    await container.appCrashes.insert({ ...base, createdAt: new Date(Date.now() - 100 * 86_400_000) });
    await container.appCrashes.insert({ ...base, signature: "b".repeat(32), createdAt: new Date() });
    await container.appCrashes.setStatus("a".repeat(32), "corrigido", null, new Date());
    expect(await container.appCrashes.purgeOlderThan(new Date(Date.now() - 90 * 86_400_000))).toBe(1);
    expect((await container.appCrashes.getStatuses(["a".repeat(32)])).size).toBe(0);
    await app.close();
  });

  it("admin lista, ve o detalhe e muda o status; vendedor e barrado", async () => {
    const { container, app } = await setup();
    const login = async (role: "admin" | "vendedor") => {
      const email = `${role}@acessanet.test`;
      await container.adminUsers.create({ id: `adm_${role}`, email, name: role, passwordHash: await hashPassword("Senha-de-teste-123"), role });
      const res = await app.inject({ method: "POST", url: "/admin/api/auth/login", payload: { email, password: "Senha-de-teste-123" }, remoteAddress: freshIp() });
      return `Bearer ${res.json().accessToken as string}`;
    };
    await app.inject({ method: "POST", url: "/v1/app-crashes", payload: crash() as never, remoteAddress: freshIp() });
    const admin = await login("admin");
    const seller = await login("vendedor");

    expect((await app.inject({ method: "GET", url: "/admin/api/erros-app", remoteAddress: freshIp() })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin/api/erros-app", headers: { authorization: seller }, remoteAddress: freshIp() })).statusCode).toBe(403);

    const list = await app.inject({ method: "GET", url: "/admin/api/erros-app?period=7d", headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(list.statusCode).toBe(200);
    expect(list.json().summary).toMatchObject({ errors: 1, occurrences: 1, open: 1 });
    const signature = list.json().items[0].signature as string;

    const detail = await app.inject({ method: "GET", url: `/admin/api/erros-app/${signature}`, headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(detail.json()).toMatchObject({ group: { count: 1, kind: "native" } });
    expect(detail.json().stack).toContain("Push.register");

    const patch = await app.inject({ method: "PATCH", url: `/admin/api/erros-app/${signature}`, headers: { authorization: admin }, payload: { status: "corrigido", adminNotes: "feito na 1.0.12" }, remoteAddress: freshIp() });
    expect(patch.statusCode).toBe(200);
    const filtered = await app.inject({ method: "GET", url: "/admin/api/erros-app?period=7d&status=novo", headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(filtered.json().items).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: `/admin/api/erros-app/${"f".repeat(32)}`, headers: { authorization: admin }, remoteAddress: freshIp() })).statusCode).toBe(404);
    await app.close();
  });
});
