import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { createDatabase } from "../src/repositories/sqlite.js";
import { MarketingStatsRepository } from "../src/analytics/marketingStats.js";
import { marketingRange } from "../src/routes/marketingFeedRoutes.js";
import { SqliteCentralActivityRepository } from "../src/repositories/centralActivityRepository.js";

const TOKEN = "t".repeat(40);

function container(token?: string) {
  return createContainer({
    env: "test",
    sqlitePath: ":memory:",
    sgp: { enabled: true, basicUsername: "test", basicPassword: "test" },
    marketingFeed: { token }
  });
}

describe("GET /api/integracoes/marketing/resumo", () => {
  it("a rota nem existe sem MARKETING_FEED_TOKEN", async () => {
    const app = await buildApp(container(undefined));
    const r = await app.inject({ method: "GET", url: "/api/integracoes/marketing/resumo" });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("recusa sem token ou com token errado", async () => {
    const app = await buildApp(container(TOKEN));
    expect((await app.inject({ method: "GET", url: "/api/integracoes/marketing/resumo" })).statusCode).toBe(401);
    const errado = await app.inject({ method: "GET", url: "/api/integracoes/marketing/resumo", headers: { authorization: "Bearer " + "x".repeat(40) } });
    expect(errado.statusCode).toBe(401);
    await app.close();
  });

  it("com o token certo devolve o resumo e nenhum dado pessoal", async () => {
    const app = await buildApp(container(TOKEN));
    const r = await app.inject({ method: "GET", url: "/api/integracoes/marketing/resumo?period=7d", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const body = r.json();
    expect(body.customers.accesses).toBe(0);
    expect(body.accounts.total).toBe(0);
    expect(body.wifi.visitorsTotal).toBe(0); // tabelas do Wi-Fi ainda nao existem: vira zero, nao erro
    expect(JSON.stringify(body)).not.toMatch(/cpf|email|phone|full_name/i);
    await app.close();
  });

  it("recusa periodo invalido ou grande demais", async () => {
    const app = await buildApp(container(TOKEN));
    const h = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/integracoes/marketing/resumo?period=custom&from=2020-01-01&to=2026-01-01", headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/integracoes/marketing/resumo?period=custom&from=2026-02-01&to=2026-01-01", headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/integracoes/marketing/resumo?period=ano", headers: h })).statusCode).toBe(400);
    await app.close();
  });
});

describe("MarketingStatsRepository", () => {
  it("conta contas, sessoes, chamados, contratacoes e Wi-Fi no periodo", async () => {
    const db = createDatabase(":memory:");
    const hoje = new Date().toISOString();
    const antigo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    db.prepare("INSERT INTO customer_auth_profiles (cpf_hash, first_access_completed, created_at, updated_at) VALUES (?,?,?,?)").run("a", 1, hoje, hoje);
    db.prepare("INSERT INTO customer_auth_profiles (cpf_hash, first_access_completed, created_at, updated_at) VALUES (?,?,?,?)").run("b", 0, antigo, antigo);
    const central = new SqliteCentralActivityRepository(db);
    const base = { sessionId: "s1", customerId: "c1", cpfHash: "a", deviceType: "mobile" };
    await central.record({ ...base, eventType: "LOGIN", page: "login" });
    await central.record({ ...base, eventType: "OPEN_TICKET", page: "tickets" });
    await central.record({ ...base, eventType: "OPEN_TICKET", page: "tickets" });
    db.exec("CREATE TABLE wifi_visitors (id TEXT PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT, created_at TEXT, updated_at TEXT)");
    db.exec("CREATE TABLE wifi_consents (id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_id TEXT, purpose TEXT, granted INTEGER, version TEXT, created_at TEXT)");
    db.exec("CREATE TABLE wifi_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_id TEXT, created_at TEXT)");
    db.prepare("INSERT INTO wifi_visitors VALUES ('v1','Maria','m@x','1',?,?)").run(hoje, hoje);
    db.prepare("INSERT INTO wifi_visitors VALUES ('v2','Joao','j@x','2',?,?)").run(hoje, hoje);
    db.prepare("INSERT INTO wifi_consents (visitor_id, purpose, granted, version, created_at) VALUES ('v1','marketing',1,'1',?)").run(hoje);
    db.prepare("INSERT INTO wifi_consents (visitor_id, purpose, granted, version, created_at) VALUES ('v2','marketing',1,'1',?)").run(hoje);
    db.prepare("INSERT INTO wifi_consents (visitor_id, purpose, granted, version, created_at) VALUES ('v2','marketing',0,'1',?)").run(hoje); // retirou o consentimento
    db.prepare("INSERT INTO wifi_sessions (visitor_id, created_at) VALUES ('v1',?)").run(hoje);

    const stats = new MarketingStatsRepository(async (sql, params) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>);
    const range = marketingRange({ period: "30d" });
    const resumo = await stats.summary(range, await central.overview(range));
    expect(resumo.accounts).toMatchObject({ total: 2, createdInRange: 1, firstAccessCompleted: 1 });
    expect(resumo.tickets.openedInRange).toBe(2);
    expect(resumo.tickets.openedByDay).toHaveLength(1);
    expect(resumo.customers.accesses).toBe(3);
    expect(resumo.sessions.loginsByDay[0]?.value).toBe(1);
    expect(resumo.wifi).toMatchObject({ visitorsTotal: 2, visitorsInRange: 2, marketingLeads: 1, sessionsInRange: 1 });
  });
});
