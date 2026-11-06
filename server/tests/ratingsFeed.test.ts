import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer } from "../src/container.js";

const TOKEN = "r".repeat(40);

function container(token?: string) {
  return createContainer({
    env: "test",
    sqlitePath: ":memory:",
    sgp: { enabled: true, basicUsername: "test", basicPassword: "test" },
    contractFeed: { token }
  } as never);
}

describe("GET /api/integracoes/avaliacoes", () => {
  it("a rota nem existe sem o token do feed", async () => {
    const app = await buildApp(container(undefined));
    expect((await app.inject({ method: "GET", url: "/api/integracoes/avaliacoes" })).statusCode).toBe(404);
    await app.close();
  });

  it("recusa sem token ou com token errado", async () => {
    const app = await buildApp(container(TOKEN));
    expect((await app.inject({ method: "GET", url: "/api/integracoes/avaliacoes" })).statusCode).toBe(401);
    const errado = await app.inject({ method: "GET", url: "/api/integracoes/avaliacoes", headers: { authorization: "Bearer " + "x".repeat(40) } });
    expect(errado.statusCode).toBe(401);
    await app.close();
  });

  it("devolve so avaliacoes respondidas, por protocolo, sem dados do cliente", async () => {
    const c = container(TOKEN);
    const now = new Date();
    await c.ticketRatings.createRequest({ customerId: "c1", contractId: "3005", protocol: "261106000001", ticketTitle: "OFFLINE", technician: "eniosilva", dueAt: now, now });
    await c.ticketRatings.createRequest({ customerId: "c2", contractId: "3006", protocol: "261106000002", ticketTitle: "OFFLINE", technician: "alexsilva", dueAt: now, now });
    expect(await c.ticketRatings.submit("c1", "261106000001", 5, "Muito bom", now)).toBe(true);
    const app = await buildApp(c);
    const r = await app.inject({ method: "GET", url: "/api/integracoes/avaliacoes", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const { items } = r.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ protocol: "261106000001", contractId: "3005", rating: 5, comment: "Muito bom", technician: "eniosilva" });
    expect(JSON.stringify(items)).not.toMatch(/customerId|c1/);
    await app.close();
  });
});
