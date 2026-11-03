import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer, type AppContainer } from "../src/container.js";
import { sha256 } from "../src/security/hash.js";
import { AppointmentNotifier, buildAppointmentBody, PUSH_TITLE } from "../src/push/appointmentNotifier.js";
import { createFcmClient, maskToken, type PushMessage, type PushSendResult } from "../src/push/fcmClient.js";

const TOKEN_A = "tokenA_" + "a".repeat(40);
const TOKEN_B = "tokenB_" + "b".repeat(40);
const NOW = new Date("2026-10-29T15:00:00Z"); // 12:00 em Sao Paulo

let ipCounter = 0;
const freshIp = () => `10.7.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function setup() {
  const container = createContainer({ env: "test", sqlitePath: ":memory:", sgp: { basicUsername: "t", basicPassword: "t" } } as never);
  // Nenhuma consulta real ao SGP: reverificacao de posse sempre falha.
  vi.spyOn(container.sgpClient, "consultCustomerByContract").mockRejectedValue(new Error("sem rede nos testes"));
  const app = await buildApp(container);
  const customers: Record<string, { id: string; auth: string }> = {};
  for (const [name, contractId] of [["A", "1001"], ["B", "2002"]] as const) {
    const id = `customer_${name}`;
    container.store.upsertCustomer({ id, name, cpf: name === "A" ? "39581323830" : "41882797884", phone: "11999990000" });
    container.store.upsertContract({ id: contractId, customerId: id, addressLine: "x", city: "c", state: "SP", planName: "p", status: "ACTIVE" });
    const sessionId = `sess_${name}`;
    await container.authSessions.create({ id: sessionId, sessionTokenHash: "h", customerId: id, cpfHash: sha256(name), expiresAt: new Date(Date.now() + 3600_000) });
    customers[name] = { id, auth: `Bearer ${container.localPasswordAuthService.tokens.issueAccessToken(id, sessionId)}` };
  }
  return { container, app, customers };
}

const post = (app: Awaited<ReturnType<typeof setup>>["app"], auth: string, payload: unknown, ip = freshIp()) =>
  app.inject({ method: "POST", url: "/v1/push/devices", payload: payload as never, headers: { authorization: auth }, remoteAddress: ip });
const del = (app: Awaited<ReturnType<typeof setup>>["app"], auth: string, payload: unknown, ip = freshIp()) =>
  app.inject({ method: "DELETE", url: "/v1/push/devices", payload: payload as never, headers: { authorization: auth }, remoteAddress: ip });

function occurrence(numero: string, opts: { status?: string; agendamento?: string } = {}) {
  return {
    numero,
    status: opts.status ?? "Aberta",
    data_cadastro: "2026-10-20",
    hora_cadastro: "08:15",
    tipo: "Sem internet",
    ordens_servicos: opts.agendamento ? [{ status: opts.status ?? "Aberta", os_data_agendamento: opts.agendamento }] : []
  };
}

function fakeTickets(map: Record<string, unknown[] | Error>) {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      async listOccurrencesByContract(contractId: string) {
        calls.push(contractId);
        const entry = map[contractId];
        if (entry instanceof Error) throw entry;
        return (entry ?? []).map((raw) => ({ id: String((raw as { numero: string }).numero), contractId, raw })) as never;
      }
    }
  };
}

function notifier(container: AppContainer, tickets: ReturnType<typeof fakeTickets>, send: (m: PushMessage) => Promise<PushSendResult>, extra: object = {}) {
  return new AppointmentNotifier({ repo: container.pushDevices, tickets: tickets.provider, enabled: true, send, now: () => NOW, ...extra });
}

describe("rotas /v1/push/devices", () => {
  it("exige autenticacao", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/v1/push/devices", payload: { token: TOKEN_A, platform: "android" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("registra, faz upsert por token e nao ecoa o token", async () => {
    const { app, container, customers } = await setup();
    const res = await post(app, customers.A!.auth, { token: TOKEN_A, platform: "android", appVersion: "1.0", contractIds: ["1001"] });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN_A);
    await post(app, customers.A!.auth, { token: TOKEN_A, platform: "android", appVersion: "1.1", contractIds: ["1001"] });
    const devices = await container.pushDevices.listActiveDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ customerId: "customer_A", appVersion: "1.1", contractIds: ["1001"] });
    await app.close();
  });

  it("token existente de outro cliente e transferido para o atual", async () => {
    const { app, container, customers } = await setup();
    await post(app, customers.A!.auth, { token: TOKEN_A, platform: "android", contractIds: ["1001"] });
    await post(app, customers.B!.auth, { token: TOKEN_A, platform: "android", contractIds: ["2002"] });
    const devices = await container.pushDevices.listActiveDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ customerId: "customer_B", contractIds: ["2002"] });
    await app.close();
  });

  it("ignora contratos de outro cliente", async () => {
    const { app, container, customers } = await setup();
    const res = await post(app, customers.A!.auth, { token: TOKEN_A, platform: "android", contractIds: ["1001", "2002", "9999"] });
    expect(res.statusCode).toBe(200);
    expect((await container.pushDevices.listActiveDevices())[0]!.contractIds).toEqual(["1001"]);
    await app.close();
  });

  it("valida token e plataforma", async () => {
    const { app, customers } = await setup();
    for (const payload of [
      { token: "curto", platform: "android" },
      { token: "com espaco " + "x".repeat(30), platform: "android" },
      { token: "x".repeat(4097), platform: "android" },
      { token: TOKEN_A, platform: "ios" },
      {}
    ]) {
      const res = await post(app, customers.A!.auth, payload);
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("aplica rate limit por cliente", async () => {
    const { app, customers } = await setup();
    let last = 200;
    for (let i = 0; i < 25; i++) {
      last = (await post(app, customers.A!.auth, { token: TOKEN_A, platform: "android" })).statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });

  it("remocao desativa so o token do proprio cliente e e idempotente", async () => {
    const { app, container, customers } = await setup();
    await post(app, customers.A!.auth, { token: TOKEN_A, platform: "android", contractIds: ["1001"] });
    const other = await del(app, customers.B!.auth, { token: TOKEN_A });
    expect(other.statusCode).toBe(200);
    expect(await container.pushDevices.listActiveDevices()).toHaveLength(1);
    expect((await del(app, customers.A!.auth, { token: TOKEN_A })).statusCode).toBe(200);
    expect(await container.pushDevices.listActiveDevices()).toHaveLength(0);
    const again = await del(app, customers.A!.auth, { token: TOKEN_A });
    expect(again.statusCode).toBe(200);
    expect((await del(app, customers.A!.auth, { token: "z".repeat(30) })).json()).toEqual(again.json());
    await app.close();
  });
});

describe("AppointmentNotifier", () => {
  async function withDevice() {
    const ctx = await setup();
    await post(ctx.app, ctx.customers.A!.auth, { token: TOKEN_A, platform: "android", contractIds: ["1001"] });
    return ctx;
  }

  it("primeiro agendamento notifica uma vez, com data e hora; ciclo repetido nao duplica", async () => {
    const { container } = await withDevice();
    const tickets = fakeTickets({ "1001": [occurrence("555", { agendamento: "2026-10-30 14:30:00" })] });
    const sent: PushMessage[] = [];
    const n = notifier(container, tickets, async (m) => (sent.push(m), "ok"));
    await n.runCycle();
    await n.runCycle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ token: TOKEN_A, title: PUSH_TITLE, data: { route: "/cliente/chamados", protocol: "555" }, channelId: "chamados", body: "Seu atendimento foi agendado para 30/10/2026, turno da tarde." });
    // reinicio: novo notificador, mesmo banco
    await notifier(container, tickets, async (m) => (sent.push(m), "ok")).runCycle();
    expect(sent).toHaveLength(1);
  });

  it("reagendamento notifica com o texto de mudanca", async () => {
    const { container } = await withDevice();
    const map: Record<string, unknown[]> = { "1001": [occurrence("555", { agendamento: "2026-10-30 14:30:00" })] };
    const tickets = fakeTickets(map);
    const sent: PushMessage[] = [];
    const n = notifier(container, tickets, async (m) => (sent.push(m), "ok"));
    await n.runCycle();
    map["1001"] = [occurrence("555", { agendamento: "2026-10-31 16:00:00" })];
    await n.runCycle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toBe("O horário da visita mudou: 31/10/2026, turno da tarde.");
  });

  it("turno vem da hora agendada no SGP: mudar a hora no mesmo turno nao avisa; mudar o turno avisa", async () => {
    const { container } = await withDevice();
    // A preferencia do cliente (Noite) nao manda: vale a hora que a equipe agendou.
    const at = (agendamento: string) => ({ ...occurrence("556", { agendamento }), conteudo: "Horario preferencial de atendimento: Noite" });
    const map: Record<string, unknown[]> = { "1001": [at("2026-10-30 08:00:00")] };
    const sent: PushMessage[] = [];
    const n = notifier(container, fakeTickets(map), async (m) => (sent.push(m), "ok"));
    await n.runCycle();
    expect(sent[0]!.body).toBe("Seu atendimento foi agendado para 30/10/2026, turno da manhã.");
    map["1001"] = [at("2026-10-30 10:30:00")];
    await n.runCycle();
    expect(sent).toHaveLength(1);
    map["1001"] = [at("2026-10-30 14:00:00")];
    await n.runCycle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toBe("O horário da visita mudou: 30/10/2026, turno da tarde.");
  });

  it("chamado encerrado e agendamento no passado nao notificam", async () => {
    const { container } = await withDevice();
    const tickets = fakeTickets({
      "1001": [
        occurrence("1", { status: "Encerrada", agendamento: "2026-10-30 10:00:00" }),
        occurrence("2", { agendamento: "2026-10-28 10:00:00" }),
        occurrence("3")
      ]
    });
    const send = vi.fn(async () => "ok" as const);
    await notifier(container, tickets, send).runCycle();
    expect(send).not.toHaveBeenCalled();
  });

  it("token invalido e desativado", async () => {
    const { container } = await withDevice();
    const tickets = fakeTickets({ "1001": [occurrence("555", { agendamento: "2026-10-30 14:30:00" })] });
    await notifier(container, tickets, async () => "invalid_token").runCycle();
    expect(await container.pushDevices.listActiveDevices()).toHaveLength(0);
    expect(await container.pushDevices.getAppointmentState("customer_A", "555")).toBeNull();
  });

  it("falha retry nao grava estado e tenta no ciclo seguinte", async () => {
    const { container } = await withDevice();
    const tickets = fakeTickets({ "1001": [occurrence("555", { agendamento: "2026-10-30 14:30:00" })] });
    let result: PushSendResult = "retry";
    const send = vi.fn(async () => result);
    const n = notifier(container, tickets, send);
    await n.runCycle();
    expect(await container.pushDevices.getAppointmentState("customer_A", "555")).toBeNull();
    expect(await container.pushDevices.listActiveDevices()).toHaveLength(1);
    result = "ok";
    await n.runCycle();
    expect(send).toHaveBeenCalledTimes(2);
    expect((await container.pushDevices.getAppointmentState("customer_A", "555"))?.appointmentKey).toBe("2026-10-30 P:período da tarde");
  });

  it("erro do SGP pula o contrato sem falhar", async () => {
    const { container } = await withDevice();
    const tickets = fakeTickets({ "1001": new Error("SGP_BUSY") });
    const send = vi.fn(async () => "ok" as const);
    await expect(notifier(container, tickets, send).runCycle()).resolves.toMatchObject({ contracts: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("limita contratos por ciclo e rotaciona", async () => {
    const { container, app, customers } = await withDevice();
    await post(app, customers.B!.auth, { token: TOKEN_B, platform: "android", contractIds: ["2002"] });
    const tickets = fakeTickets({});
    const n = notifier(container, tickets, async () => "ok", { maxContractsPerCycle: 1 });
    await n.runCycle();
    await n.runCycle();
    expect(tickets.calls.sort()).toEqual(["1001", "2002"]);
  });

  it("sem credencial (desligado) nao consulta o SGP nem envia", async () => {
    const { container } = await withDevice();
    const tickets = fakeTickets({ "1001": [occurrence("555", { agendamento: "2026-10-30 14:30:00" })] });
    const warn = vi.fn();
    const fcm = createFcmClient({ env: {}, log: { info: vi.fn(), warn } });
    expect(fcm.enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const n = notifier(container, tickets, fcm.send, { enabled: fcm.enabled });
    expect(await n.runCycle()).toMatchObject({ skipped: "disabled" });
    expect(tickets.calls).toHaveLength(0);
  });

  it("formata data/hora em pt-BR", () => {
    expect(buildAppointmentBody("2026-10-30", "14:30", false)).toBe("Seu atendimento foi agendado para 30/10/2026, turno da tarde.");
    expect(buildAppointmentBody("2026-10-30", "09:53", false)).toBe("Seu atendimento foi agendado para 30/10/2026, turno da manhã.");
    expect(buildAppointmentBody("2026-10-30", "19:00", true)).toBe("O horário da visita mudou: 30/10/2026, turno da noite.");
    expect(buildAppointmentBody("2026-10-30", null, false)).toBe("Seu atendimento foi agendado para 30/10/2026.");
    expect(buildAppointmentBody("2026-10-30", null, true)).toBe("O horário da visita mudou: 30/10/2026.");
  });
});

describe("fcmClient", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const sa = JSON.stringify({ project_id: "proj-x", client_email: "svc@proj-x.iam.gserviceaccount.com", private_key: privateKey });
  const msg: PushMessage = { token: TOKEN_A, title: "t", body: "b", data: { route: "/cliente/chamados", protocol: "9" }, channelId: "chamados" };

  function fakeFetch(sendResponse: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }), { status: 200 });
      return sendResponse();
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it("assina JWT RS256, cacheia o access token e envia o payload esperado", async () => {
    const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = createFcmClient({ env: { FCM_SERVICE_ACCOUNT_JSON: sa }, fetchImpl: fn });
    expect(client.enabled).toBe(true);
    expect(await client.send(msg)).toBe("ok");
    expect(await client.send(msg)).toBe("ok");
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
    const assertion = new URLSearchParams(String(calls[0]!.init.body)).get("assertion")!;
    const [h, c, s] = assertion.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(c!, "base64url").toString()).scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    const sendCall = calls.find((x) => x.url.includes("fcm.googleapis.com"))!;
    expect(sendCall.url).toBe("https://fcm.googleapis.com/v1/projects/proj-x/messages:send");
    expect(JSON.parse(String(sendCall.init.body)).message).toMatchObject({
      token: TOKEN_A,
      data: { route: "/cliente/chamados", protocol: "9" },
      android: { priority: "HIGH", notification: { channel_id: "chamados" } }
    });
  });

  it("classifica erros e nunca loga o token completo", async () => {
    const warn = vi.fn();
    const cases: Array<[Response, PushSendResult]> = [
      [new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 }), "invalid_token"],
      [new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }), { status: 400 }), "invalid_token"],
      [new Response("{}", { status: 429 }), "retry"],
      [new Response("{}", { status: 503 }), "retry"]
    ];
    for (const [response, expected] of cases) {
      const { fn } = fakeFetch(() => response);
      const client = createFcmClient({ env: { FCM_SERVICE_ACCOUNT_JSON: sa }, fetchImpl: fn, log: { info: vi.fn(), warn } });
      expect(await client.send(msg)).toBe(expected);
    }
    const networkDown = createFcmClient({ env: { FCM_SERVICE_ACCOUNT_JSON: sa }, fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as never, log: { info: vi.fn(), warn } });
    expect(await networkDown.send(msg)).toBe("retry");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TOKEN_A);
    expect(logged).not.toContain("PRIVATE KEY");
    expect(maskToken(TOKEN_A)).not.toBe(TOKEN_A);
  });

  it("le a credencial de arquivo", () => {
    const client = createFcmClient({ env: { FCM_SERVICE_ACCOUNT_FILE: "/x/sa.json" }, readFile: () => sa, fetchImpl: fakeFetch(() => new Response("{}")).fn });
    expect(client.enabled).toBe(true);
  });
});
