import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { setChatPushSender } from "../src/routes/chatPushRoutes.js";
import type { PushMessage } from "../src/push/fcmClient.js";

const PUSH = "push_" + "p".repeat(40);
const TOKEN_A = "fcm-token-A-" + "a".repeat(30);
const TOKEN_B = "fcm-token-B-" + "b".repeat(30);
let ip = 0;
const freshIp = () => `10.8.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

async function setup(pushToken: string | null = PUSH) {
  const container = createContainer({
    env: "test", sqlitePath: ":memory:", sgp: { basicUsername: "t", basicPassword: "t" },
    chat: { tokenSecret: undefined, ttlSeconds: 900, issuer: "acessanet-app", audience: "acessanet-chat-api", pushToken: pushToken ?? undefined }
  } as never);
  vi.spyOn(container.sgpClient, "consultCustomerByContract").mockRejectedValue(new Error("sem rede nos testes"));
  const app = await buildApp(container);
  await container.pushDevices.upsertDevice({ customerId: "customer_A", token: TOKEN_A, platform: "android", appVersion: "1.0", contractIds: ["1001"] });
  await container.pushDevices.upsertDevice({ customerId: "customer_B", token: TOKEN_B, platform: "android", appVersion: "1.0", contractIds: ["2002"] });
  return { container, app };
}
const chamar = (app: Awaited<ReturnType<typeof setup>>["app"], payload: unknown, token: string | null = PUSH) =>
  app.inject({ method: "POST", url: "/api/integracoes/atendimento/push", remoteAddress: freshIp(), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), payload: payload as never });

afterEach(() => setChatPushSender(null));

describe("push do chat de atendimento", () => {
  it("avisa só os aparelhos do cliente informado, com rota de chamados e sem dados pessoais", async () => {
    const enviados: PushMessage[] = [];
    setChatPushSender(async (m) => { enviados.push(m); return "ok"; });
    const { app } = await setup();
    const r = await chamar(app, { customerId: "customer_A", title: "AcessaNet", body: "Um atendente respondeu você.", conversationId: 7 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ sent: 1, devices: 1 });
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatchObject({ token: TOKEN_A, channelId: "chamados", data: { route: "/cliente/chamados", action: "chat", conversationId: "7" } });
  });

  it("desativa o aparelho quando o FCM diz que o token é inválido", async () => {
    setChatPushSender(async () => "invalid_token");
    const { app, container } = await setup();
    await chamar(app, { customerId: "customer_A", title: "t", body: "b" });
    expect((await container.pushDevices.listActiveDevices()).map((d) => d.token)).toEqual([TOKEN_B]);
  });

  it("exige o token de integração e recusa campos extras", async () => {
    setChatPushSender(async () => "ok");
    const { app } = await setup();
    expect((await chamar(app, { customerId: "customer_A", title: "t", body: "b" }, null)).statusCode).toBe(401);
    expect((await chamar(app, { customerId: "customer_A", title: "t", body: "b" }, "errado".repeat(8))).statusCode).toBe(401);
    expect((await chamar(app, { customerId: "customer_A", title: "t", body: "b", token: "x" })).statusCode).toBe(400);
  });

  it("limita avisos por minuto ao mesmo cliente", async () => {
    setChatPushSender(async () => "ok");
    const { app } = await setup();
    const codigos: number[] = [];
    for (let i = 0; i < 8; i++) codigos.push((await chamar(app, { customerId: "customer_A", title: "t", body: "b" })).statusCode);
    expect(codigos.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codigos.slice(6).every((c) => c === 429)).toBe(true);
  });

  it("a rota nem existe sem token configurado", async () => {
    const { app } = await setup(null);
    expect((await chamar(app, { customerId: "customer_A", title: "t", body: "b" })).statusCode).toBe(404);
  });
});
