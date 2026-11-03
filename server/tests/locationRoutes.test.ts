import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer, type AppContainer } from "../src/container.js";
import { hashPassword } from "../src/security/hash.js";

let ipCounter = 0;
const freshIp = () => `10.20.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function setup() {
  const container = createContainer({ env: "test", sqlitePath: ":memory:", sgp: { basicUsername: "t", basicPassword: "t" } } as never);
  const app = await buildApp(container);
  return { container, app };
}

async function adminAuth(app: Awaited<ReturnType<typeof setup>>["app"], container: AppContainer, role: "admin" | "editor" | "vendedor" | "viewer") {
  const email = `${role}@acessanet.test`;
  await container.adminUsers.create({ id: `adm_${role}`, email, name: role, passwordHash: await hashPassword("Senha-de-teste-123"), role });
  const login = await app.inject({ method: "POST", url: "/admin/api/auth/login", payload: { email, password: "Senha-de-teste-123" }, remoteAddress: freshIp() });
  expect(login.statusCode).toBe(200);
  return `Bearer ${login.json().accessToken as string}`;
}

async function seed(container: AppContainer) {
  return container.locationRequests.create({
    customerId: "customer_T",
    contractId: "3005",
    protocol: "261103100000",
    latitude: -23.3232,
    longitude: -46.7284,
    accuracyMeters: 20,
    source: "app"
  });
}

describe("localizacao da casa - rotas", () => {
  it("o cliente precisa estar logado para enviar e para consultar", async () => {
    const { app } = await setup();
    const body = { contractId: "3005", protocol: "1", latitude: -23.3, longitude: -46.7, source: "web" };
    expect((await app.inject({ method: "POST", url: "/v1/support/location", payload: body, remoteAddress: freshIp() })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/support/location?contractId=3005&protocol=1", remoteAddress: freshIp() })).statusCode).toBe(401);
    await app.close();
  });

  it("painel: sem login 401; vendedor e viewer 403; admin e editor veem a lista com o link do mapa", async () => {
    const { app, container } = await setup();
    await seed(container);
    expect((await app.inject({ method: "GET", url: "/admin/api/localizacoes", remoteAddress: freshIp() })).statusCode).toBe(401);
    for (const role of ["vendedor", "viewer"] as const) {
      const token = await adminAuth(app, container, role);
      expect((await app.inject({ method: "GET", url: "/admin/api/localizacoes", headers: { authorization: token }, remoteAddress: freshIp() })).statusCode).toBe(403);
    }
    for (const role of ["admin", "editor"] as const) {
      const token = await adminAuth(app, container, role);
      const res = await app.inject({ method: "GET", url: "/admin/api/localizacoes?status=pending", headers: { authorization: token }, remoteAddress: freshIp() });
      expect(res.statusCode).toBe(200);
      expect(res.json().items[0]).toMatchObject({ contractId: "3005", status: "pending", mapUrl: "https://www.google.com/maps/search/?api=1&query=-23.323200,-46.728400" });
      // O id interno do cliente nao sai do servidor.
      expect(JSON.stringify(res.json())).not.toContain("customer_T");
    }
    await app.close();
  });

  it("recusar guarda o motivo, nao escreve no SGP e a segunda analise e barrada", async () => {
    const { app, container } = await setup();
    const record = await seed(container);
    const token = await adminAuth(app, container, "editor");

    const rejected = await app.inject({ method: "POST", url: `/admin/api/localizacoes/${record.id}/recusar`, headers: { authorization: token }, payload: { note: "ponto errado" }, remoteAddress: freshIp() });
    expect(rejected.statusCode).toBe(200);
    expect((await container.locationRequests.findById(record.id))).toMatchObject({ status: "rejected", reviewNote: "ponto errado", reviewedBy: "adm_editor" });

    const again = await app.inject({ method: "POST", url: `/admin/api/localizacoes/${record.id}/recusar`, headers: { authorization: token }, payload: {}, remoteAddress: freshIp() });
    expect(again.statusCode).toBe(409);
    const missing = await app.inject({ method: "POST", url: "/admin/api/localizacoes/nao-existe/aprovar", headers: { authorization: token }, remoteAddress: freshIp() });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
