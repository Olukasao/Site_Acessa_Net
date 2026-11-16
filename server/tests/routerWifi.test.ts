import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { hashPassword, sha256 } from "../src/security/hash.js";
import { validateWifiPassword } from "../src/routerWifi/routerWifiService.js";

const TOKEN = "agent_token_" + "t".repeat(40);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
let ip = 0;
const freshIp = () => `10.9.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

async function setup(over: Partial<{ enabled: boolean; pilotContracts: string[]; agentToken: string | undefined }> = {}) {
  const container = createContainer({
    env: "test", sqlitePath: ":memory:", sgp: { enabled: true, baseUrl: "http://sgp.invalid", basicUsername: "t", basicPassword: "t", chamado: {}, sign: {} },
    routerWifi: { enabled: true, agentToken: TOKEN, agentPublicKey: PUBLIC_PEM, pilotContracts: [], ...over }
  } as never);
  vi.spyOn(container.sgpClient, "consultCustomerByContract").mockRejectedValue(new Error("sem rede nos testes"));
  const app = await buildApp(container);
  for (const [id, contract] of [["customer_A", "1001"], ["customer_B", "2002"]] as const) {
    container.store.upsertCustomer({ id, name: id, cpf: "39581323830", phone: "11999990000" });
    container.store.upsertContract({ id: contract, customerId: id, addressLine: "x", city: "c", state: "SP", planName: "p", status: "ACTIVE" });
    await container.authProfiles.upsert?.({ cpfHash: sha256(id) } as never);
  }
  const cpfHash = sha256("A");
  await container.authSessions.create({ id: "sess_A", sessionTokenHash: "h", customerId: "customer_A", cpfHash, expiresAt: new Date(Date.now() + 3_600_000) } as never);
  vi.spyOn(container.authProfiles, "findByCpfHash").mockImplementation(async (hash) =>
    hash === cpfHash ? ({ cpfHash, passwordHash: await hashPassword("Senha-Central-1") } as never) : null
  );
  const auth = `Bearer ${container.localPasswordAuthService.tokens.issueAccessToken("customer_A", "sess_A")}`;
  // ganchos falsos: nada de SGP, FCM ou SMTP nos testes
  const tickets: Array<{ contractId: string; description: string }> = [];
  const notified: string[] = [];
  (container.routerWifiService as unknown as { hooks: unknown }).hooks = {
    openTicket: async (input: { contractId: string; description: string }) => (tickets.push(input), { protocol: "261116000001" }),
    notifyChanged: async (job: { id: string }) => void notified.push(job.id)
  };
  // agente no ar: cada busca de tarefas e o sinal de vida
  await container.routerWifiJobs.touchAgent("a1", true, "t", new Date());
  return { container, app, auth, tickets, notified };
}

const agent = { authorization: `Bearer ${TOKEN}` };
const change = (body: Record<string, unknown> = {}) => ({
  contractId: "1001", newPassword: "Casa-Nova#2026", bands: ["2.4GHz", "5GHz"], currentPassword: "Senha-Central-1", ...body
});

describe("Gerenciar meu Wi-Fi - Central", () => {
  it("regras da senha Wi-Fi", () => {
    expect(validateWifiPassword("Abc#1234")).toBeNull();
    expect(validateWifiPassword("abc#1234")).toMatch(/maiúscula/);
    expect(validateWifiPassword("Abc#12")).toMatch(/8/);
    expect(validateWifiPassword("Ação#12345")).toMatch(/acento/);
    expect(validateWifiPassword(" Abc#1234")).toMatch(/espaço/);
    expect(validateWifiPassword("A".repeat(60) + "#1aaa")).toMatch(/63/);
  });

  it("sem login 401; contrato de outro cliente bloqueado; desligado mostra indisponível sem criar tarefa", async () => {
    const { app, auth, container } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=1001", remoteAddress: freshIp() })).statusCode).toBe(401);
    const other = await app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=2002", headers: { authorization: auth }, remoteAddress: freshIp() });
    expect([403, 404]).toContain(other.statusCode);
    const cross = await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change({ contractId: "2002" }), remoteAddress: freshIp() });
    expect([403, 404]).toContain(cross.statusCode);
    expect(await container.routerWifiJobs.list(10)).toHaveLength(0);

    const off = await setup({ enabled: false });
    const r = await off.app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=1001", headers: { authorization: off.auth }, remoteAddress: freshIp() });
    expect(r.json()).toMatchObject({ available: false, job: null });
    const p = await off.app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: off.auth }, payload: change(), remoteAddress: freshIp() });
    expect(p.statusCode).toBe(404);
    await app.close();
    await off.app.close();
  });

  it("piloto: só os contratos da lista", async () => {
    const { app, auth } = await setup({ pilotContracts: ["9999"] });
    const r = await app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=1001", headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(r.json().available).toBe(false);
    await app.close();
  });

  it("o cliente não escolhe IP, porta nem roteador: campos extras são recusados", async () => {
    const { app, auth } = await setup();
    for (const extra of [{ ip: "100.64.0.1" }, { port: 80 }, { deviceId: "x" }, { url: "http://evil" }]) {
      const r = await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change(extra), remoteAddress: freshIp() });
      expect(r.statusCode).toBe(400);
    }
    await app.close();
  });

  it("pede a senha da Central de novo; senha errada 403 e nada é criado", async () => {
    const { app, auth, container } = await setup();
    const r = await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change({ currentPassword: "errada" }), remoteAddress: freshIp() });
    expect(r.statusCode).toBe(403);
    expect(await container.routerWifiJobs.list(10)).toHaveLength(0);
    await app.close();
  });

  it("fluxo completo: pedido cifrado, agente pega, conclui com verificação, segredo apagado", async () => {
    const { app, auth, container } = await setup();
    const created = await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change(), remoteAddress: freshIp() });
    expect(created.statusCode).toBe(202);
    const jobId = created.json().job.id as string;
    expect(JSON.stringify(created.json())).not.toContain("Casa-Nova");

    // uma por vez
    const again = await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change(), remoteAddress: freshIp() });
    expect(again.statusCode).toBe(409);

    // agente sem token: 401
    expect((await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", payload: { agentId: "a1" }, remoteAddress: freshIp() })).statusCode).toBe(401);
    const claim = await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1", max: 5 }, remoteAddress: freshIp() });
    const [job] = claim.json().jobs;
    expect(job).toMatchObject({ id: jobId, contractId: "1001", kind: "change_password", bands: ["2.4GHz", "5GHz"] });
    expect(Object.keys(job).sort()).toEqual(["bands", "contractId", "id", "kind", "secretEnc"]); // nada de cliente/CPF
    const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(job.secretEnc, "base64")).toString();
    expect(plain).toBe("Casa-Nova#2026");
    // outro agente não pega a mesma
    expect((await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a2" }, remoteAddress: freshIp() })).json().jobs).toHaveLength(0);

    const progress = await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state: "updating" }, remoteAddress: freshIp() });
    expect(progress.statusCode).toBe(200);
    const mid = await app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${jobId}`, headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(mid.json().job).toMatchObject({ state: "updating", done: false });

    // resultado com campo a mais (ex.: senha) é recusado
    const leak = await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state: "completed", result: { bands: ["5GHz"], verified: true, password: "x" } }, remoteAddress: freshIp() });
    expect(leak.statusCode).toBe(422);
    // outro agente não informa
    expect((await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a2", state: "completed" }, remoteAddress: freshIp() })).statusCode).toBe(404);

    const done = await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state: "completed", result: { bands: ["2.4GHz", "5GHz"], verified: true } }, remoteAddress: freshIp() });
    expect(done.json()).toEqual({ ok: true, state: "completed" });
    expect((await container.routerWifiJobs.findById(jobId))?.secretEnc).toBeNull();
    const final = await app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${jobId}`, headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(final.json().job).toMatchObject({ state: "completed", done: true, message: "Pronto!" });
    // terminada não muda mais
    expect((await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state: "failed" }, remoteAddress: freshIp() })).statusCode).toBe(409);
    await app.close();
  });

  it("'concluído' sem verificação vira 'não confirmado'; tarefa parada também", async () => {
    const { app, auth, container } = await setup();
    const jobId = (await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change(), remoteAddress: freshIp() })).json().job.id;
    await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    const r = await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state: "completed", result: { bands: ["5GHz"], verified: false } }, remoteAddress: freshIp() });
    expect(r.json().state).toBe("unconfirmed");
    expect((await container.routerWifiJobs.findById(jobId))?.errorCode).toBe("VERIFY_FAILED");

    // roteador aceitou mas nao deu para reler (ex.: Huawei mascara a senha): continua "nao confirmado", com a mensagem certa
    const j2 = (await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change(), remoteAddress: freshIp() })).json().job.id;
    await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    const r2 = await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${j2}`, headers: agent, payload: { agentId: "a1", state: "completed", result: { bands: ["5GHz"], verified: false, accepted: true } }, remoteAddress: freshIp() });
    expect(r2.json().state).toBe("unconfirmed");
    const seen = await app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${j2}`, headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(seen.json().job.message).toMatch(/aceitou a nova senha/);

    // pendente sem agente -> falha; em andamento parado -> não confirmado (nunca repete sozinho)
    const repo = container.routerWifiJobs;
    const old = new Date(Date.now() - 10 * 60_000);
    const stuck = await repo.create({ customerId: "customer_A", contractId: "1001", kind: "change_password", bands: ["5GHz"], secretEnc: "x", now: old });
    await repo.claim("a1", 5, old);
    const pend = await repo.create({ customerId: "customer_A", contractId: "1001", kind: "status", bands: [], secretEnc: null, now: old });
    await repo.expireStale(new Date(), 3 * 60_000, 4 * 60_000);
    expect(await repo.findById(stuck.id)).toMatchObject({ state: "unconfirmed", errorCode: "AGENT_TIMEOUT", secretEnc: null });
    expect(await repo.findById(pend.id)).toMatchObject({ state: "failed", errorCode: "AGENT_UNAVAILABLE" });
    await app.close();
  });

  it("leitura do roteador: cria uma tarefa, reaproveita a recente e devolve as redes", async () => {
    const { app, auth } = await setup();
    const first = await app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=1001", headers: { authorization: auth }, remoteAddress: freshIp() });
    const jobId = first.json().job.id;
    expect(first.json().job.state).toBe("pending");
    const same = await app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=1001", headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(same.json().job.id).toBe(jobId);
    await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    const result = { online: true, vendor: "TP-Link", model: null, firmware: null, management: "available", bands: ["2.4GHz", "5GHz"], ssids: { "2.4GHz": "Casa", "5GHz": "Casa_5G" }, canChangePassword: true };
    expect((await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state: "completed", result }, remoteAddress: freshIp() })).statusCode).toBe(200);
    const nets = await app.inject({ method: "GET", url: "/api/customer/wifi/networks?contractId=1001", headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(nets.json().networks).toEqual([{ band: "2.4GHz", ssid: "Casa" }, { band: "5GHz", ssid: "Casa_5G" }]);
    const fresh = await app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=1001", headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(fresh.json().job).toMatchObject({ id: jobId, state: "completed" });
    await app.close();
  });


  it("agente fora do ar: a tela avisa 'indisponível agora' e a troca é recusada sem criar tarefa", async () => {
    const { app, auth, container } = await setup();
    // sinal velho (agente caiu)
    await container.routerWifiJobs.touchAgent("a1", true, "t", new Date(Date.now() - 5 * 60_000));
    const st = await app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=1001", headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(st.json()).toMatchObject({ available: true, agentOnline: false, job: null });
    const av = await app.inject({ method: "GET", url: "/api/customer/wifi/availability?contractId=1001", headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(av.json()).toEqual({ available: true, agentOnline: false });
    const ch = await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change(), remoteAddress: freshIp() });
    expect(ch.statusCode).toBe(503);
    expect(await container.routerWifiJobs.list(10)).toHaveLength(0);
    // o agente volta: a busca de tarefas já é o sinal de vida
    await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1", dryRun: false, version: "0.2" }, remoteAddress: freshIp() });
    const back = await app.inject({ method: "GET", url: "/api/customer/wifi/availability?contractId=1001", headers: { authorization: auth }, remoteAddress: freshIp() });
    expect(back.json()).toEqual({ available: true, agentOnline: true });
    await app.close();
  });

  async function changeAccepted(ctx: Awaited<ReturnType<typeof setup>>) {
    const { app, auth } = ctx;
    const jobId = (await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change(), remoteAddress: freshIp() })).json().job.id as string;
    await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state: "completed", result: { bands: ["5GHz"], verified: false, accepted: true, vendor: "Huawei", model: "EG8145V5-V2" } }, remoteAddress: freshIp() });
    return jobId;
  }

  it("aviso de senha alterada: uma vez só, quando o roteador aceita; falha não avisa", async () => {
    const ctx = await setup();
    const jobId = await changeAccepted(ctx);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.notified).toEqual([jobId]);
    // a tarefa seguinte falha: sem aviso
    const j2 = (await ctx.app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: ctx.auth }, payload: change(), remoteAddress: freshIp() })).json().job.id;
    await ctx.app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    await ctx.app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${j2}`, headers: agent, payload: { agentId: "a1", state: "failed", errorCode: "ROUTER_UNREACHABLE" }, remoteAddress: freshIp() });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.notified).toEqual([jobId]);
    await ctx.app.close();
  });

  it("'Conseguiu conectar?': sim fecha o pedido; só vale uma vez; é só do titular", async () => {
    const ctx = await setup();
    const jobId = await changeAccepted(ctx);
    const pending = await ctx.app.inject({ method: "GET", url: "/api/customer/wifi/status?contractId=1001", headers: { authorization: ctx.auth }, remoteAddress: freshIp() });
    expect(pending.json().pendingChange).toMatchObject({ id: jobId, needsConfirmation: true });
    const yes = await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: ctx.auth }, payload: { connected: true }, remoteAddress: freshIp() });
    expect(yes.statusCode).toBe(200);
    expect(yes.json().job).toMatchObject({ state: "completed", confirmation: "connected", needsConfirmation: false });
    expect(ctx.tickets).toHaveLength(0);
    // segunda resposta: recusada
    expect((await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: ctx.auth }, payload: { connected: false }, remoteAddress: freshIp() })).statusCode).toBe(409);
    // sem login e campo extra
    expect((await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, payload: { connected: true }, remoteAddress: freshIp() })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: ctx.auth }, payload: { connected: true, ticket: "x" }, remoteAddress: freshIp() })).statusCode).toBe(400);
    await ctx.app.close();
  });

  it("'Não conectou' abre o chamado com o histórico, sem a senha, e guarda o protocolo", async () => {
    const ctx = await setup();
    const jobId = await changeAccepted(ctx);
    const no = await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: ctx.auth }, payload: { connected: false }, remoteAddress: freshIp() });
    expect(no.statusCode).toBe(200);
    expect(no.json()).toMatchObject({ ticketOpened: true, job: { confirmation: "not_connected", ticketProtocol: "261116000001", state: "unconfirmed", needsConfirmation: false } });
    expect(no.json().job.message).toContain("261116000001");
    expect(ctx.tickets).toHaveLength(1);
    expect(ctx.tickets[0]!.contractId).toBe("1001");
    expect(ctx.tickets[0]!.description).toMatch(/NAO conseguiu conectar/);
    expect(ctx.tickets[0]!.description).not.toContain("Casa-Nova");
    await ctx.app.close();
  });

  it("outro cliente não confirma o pedido alheio", async () => {
    const ctx = await setup();
    const jobId = await changeAccepted(ctx);
    const cpfHash = sha256("B");
    await ctx.container.authSessions.create({ id: "sess_B", sessionTokenHash: "h2", customerId: "customer_B", cpfHash, expiresAt: new Date(Date.now() + 3_600_000) } as never);
    const authB = `Bearer ${ctx.container.localPasswordAuthService.tokens.issueAccessToken("customer_B", "sess_B")}`;
    const r = await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: authB }, payload: { connected: false }, remoteAddress: freshIp() });
    expect(r.statusCode).toBe(404);
    expect(ctx.tickets).toHaveLength(0);
    await ctx.app.close();
  });

  it("inventário e painel: recebe do agente, resume por modelo e mostra taxa de sucesso", async () => {
    const ctx = await setup();
    await changeAccepted(ctx);
    const entries = [
      { contractId: "10050", vendor: "Huawei", model: "EG8145V5-V2", management: "available" },
      { contractId: "19611", vendor: "Huawei", model: "EG8145V5-V2", management: "available" },
      { contractId: "3005", vendor: null, model: null, management: "not_identified", certSubject: "TP-Link", certFp: "a".repeat(64) }
    ];
    const bad = await ctx.app.inject({ method: "POST", url: "/api/internal/router-agent/inventory", headers: agent, payload: { agentId: "a1", entries: [{ ...entries[0], ssid: "x" }] }, remoteAddress: freshIp() });
    expect(bad.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: "POST", url: "/api/internal/router-agent/inventory", headers: agent, payload: { agentId: "a1", entries }, remoteAddress: freshIp() });
    expect(ok.json()).toEqual({ saved: 3 });
    const summary = await ctx.container.routerWifiService.adminOverview(30);
    expect(summary.inventory.total).toBe(3);
    expect(summary.inventory.counts[0]).toMatchObject({ vendor: "Huawei", model: "EG8145V5-V2", total: 2 });
    expect(summary.summary).toMatchObject({ requests: 1, accepted: 1, acceptedRate: 100, awaitingCustomer: 1 });
    expect(summary.summary.byModel["Huawei EG8145V5-V2"]).toEqual({ requests: 1, accepted: 1, failed: 0 });
    expect(summary.agent.online).toBe(true);
    // painel: sem login 401; visualizador 403; admin e editor veem
    expect((await ctx.app.inject({ method: "GET", url: "/admin/api/roteadores", remoteAddress: freshIp() })).statusCode).toBe(401);
    const adminToken = async (role: "admin" | "editor" | "viewer") => {
      const email = `${role}@acessanet.test`;
      await ctx.container.adminUsers.create({ id: `adm_${role}`, email, name: role, passwordHash: await hashPassword("Senha-de-teste-123"), role });
      const login = await ctx.app.inject({ method: "POST", url: "/admin/api/auth/login", payload: { email, password: "Senha-de-teste-123" }, remoteAddress: freshIp() });
      return `Bearer ${login.json().accessToken as string}`;
    };
    expect((await ctx.app.inject({ method: "GET", url: "/admin/api/roteadores", headers: { authorization: await adminToken("viewer") }, remoteAddress: freshIp() })).statusCode).toBe(403);
    for (const role of ["admin", "editor"] as const) {
      const r = await ctx.app.inject({ method: "GET", url: "/admin/api/roteadores?days=7", headers: { authorization: await adminToken(role) }, remoteAddress: freshIp() });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ agent: { online: true }, summary: { requests: 1 }, inventory: { total: 3 } });
      // nada de senha, ip ou id interno do cliente na resposta do painel
      expect(JSON.stringify(r.json())).not.toMatch(/customer_A|secretEnc|Casa-Nova/);
    }
    await ctx.app.close();
  });

  it("sem token de agente as rotas do agente não existem", async () => {
    const { app } = await setup({ agentToken: undefined });
    expect((await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() })).statusCode).toBe(404);
    await app.close();
  });
});
