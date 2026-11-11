import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { sha256 } from "../src/security/hash.js";

const SECRET = "chat_secret_" + "s".repeat(40);
let ip = 0;
const freshIp = () => `10.7.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

async function setup(chatSecret: string | undefined = SECRET) {
  const container = createContainer({
    env: "test", sqlitePath: ":memory:", sgp: { basicUsername: "t", basicPassword: "t" },
    chat: { tokenSecret: chatSecret, ttlSeconds: 900, issuer: "acessanet-app", audience: "acessanet-chat-api", pushToken: undefined }
  } as never);
  vi.spyOn(container.sgpClient, "consultCustomerByContract").mockRejectedValue(new Error("sem rede nos testes"));
  const app = await buildApp(container);
  container.store.upsertCustomer({ id: "customer_A", name: "Ana", cpf: "39581323830", phone: "11999990000" });
  container.store.upsertContract({ id: "1001", customerId: "customer_A", addressLine: "x", city: "c", state: "SP", planName: "p", status: "ACTIVE" });
  container.store.upsertCustomer({ id: "customer_B", name: "Beto", cpf: "41882797884", phone: "11999990001" });
  container.store.upsertContract({ id: "2002", customerId: "customer_B", addressLine: "y", city: "c", state: "SP", planName: "p", status: "ACTIVE" });
  await container.authSessions.create({ id: "sess_A", sessionTokenHash: "h", customerId: "customer_A", cpfHash: sha256("A"), expiresAt: new Date(Date.now() + 3_600_000) } as never);
  const auth = `Bearer ${container.localPasswordAuthService.tokens.issueAccessToken("customer_A", "sess_A")}`;
  return { container, app, auth };
}

const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());

describe("POST /api/auth/chat-token", () => {
  it("emite JWT HS256 com o cliente da sessão e os contratos dele, verificável pelo segredo da chat-api", async () => {
    const { app, auth } = await setup();
    const r = await app.inject({ method: "POST", url: "/api/auth/chat-token", headers: { authorization: auth }, remoteAddress: freshIp(), payload: {} });
    expect(r.statusCode).toBe(200);
    const { chatToken, contractId } = r.json();
    expect(contractId).toBe("1001");
    const [h, b, sig] = chatToken.split(".");
    expect(createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url")).toBe(sig);
    expect(decode(chatToken)).toMatchObject({ userType: "customer", sub: "customer_A", customerName: "Ana", contractId: "1001", contractIds: ["1001"], iss: "acessanet-app", aud: "acessanet-chat-api" });
    expect(decode(chatToken).exp - decode(chatToken).iat).toBe(900);
  });

  it("não emite token para contrato de outro cliente", async () => {
    const { app, auth } = await setup();
    const r = await app.inject({ method: "POST", url: "/api/auth/chat-token", headers: { authorization: auth }, remoteAddress: freshIp(), payload: { contractId: "2002" } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error?.code ?? r.json().code).toBe("CONTRACT_FORBIDDEN");
  });

  it("recusa chamado que não é do cliente e corpo com campos extras (ex.: customerId)", async () => {
    const { app, auth } = await setup();
    const inexistente = await app.inject({ method: "POST", url: "/api/auth/chat-token", headers: { authorization: auth }, remoteAddress: freshIp(), payload: { contractId: "1001", ticketId: "nao-existe" } });
    expect([403, 404]).toContain(inexistente.statusCode);
    const extra = await app.inject({ method: "POST", url: "/api/auth/chat-token", headers: { authorization: auth }, remoteAddress: freshIp(), payload: { customerId: "customer_B" } });
    expect(extra.statusCode).toBe(400);
  });

  it("exige login e fica desligado (503) sem segredo válido", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/auth/chat-token", remoteAddress: freshIp(), payload: {} })).statusCode).toBe(401);
    const off = await setup("curto");
    const r = await off.app.inject({ method: "POST", url: "/api/auth/chat-token", headers: { authorization: off.auth }, remoteAddress: freshIp(), payload: {} });
    expect(r.statusCode).toBe(503);
  });
});
