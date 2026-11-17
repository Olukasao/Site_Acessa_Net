import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { hashPassword, sha256 } from "../src/security/hash.js";
import { buildWifiNames, validateWifiBaseName, validateWifiPassword } from "../src/routerWifi/routerWifiService.js";

const TOKEN = "agent_token_" + "t".repeat(40);
const FEED_TOKEN = "feed_token_" + "f".repeat(40);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
let ip = 0;
const freshIp = () => `10.9.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

async function setup(over: Partial<{ enabled: boolean; pilotContracts: string[]; agentToken: string | undefined }> = {}) {
  const container = createContainer({
    env: "test", sqlitePath: ":memory:", sgp: { enabled: true, baseUrl: "http://sgp.invalid", basicUsername: "t", basicPassword: "t", chamado: {}, sign: {} },
    routerWifi: { enabled: true, agentToken: TOKEN, agentPublicKey: PUBLIC_PEM, pilotContracts: [], ...over },
    contractFeed: { token: FEED_TOKEN }
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
    expect(Object.keys(job).sort()).toEqual(["bands", "contractId", "id", "kind", "params", "secretEnc"]); // nada de cliente/CPF
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

  it("'Não conectou' abre o chamado com os dados memorizados (redes, roteador e a senha escolhida) e guarda o protocolo", async () => {
    const ctx = await setup();
    const jobId = await changeAccepted(ctx);
    const no = await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: ctx.auth }, payload: { connected: false }, remoteAddress: freshIp() });
    expect(no.statusCode).toBe(200);
    expect(no.json()).toMatchObject({ ticketOpened: true, job: { confirmation: "not_connected", ticketProtocol: "261116000001", state: "unconfirmed", needsConfirmation: false } });
    expect(no.json().job.message).toContain("261116000001");
    expect(ctx.tickets).toHaveLength(1);
    expect(ctx.tickets[0]!.contractId).toBe("1001");
    expect(ctx.tickets[0]!.description).toMatch(/NÃO conseguiu conectar/);
    // dados memorizados para o tecnico trocar no roteador: redes, roteador e a senha que o cliente escolheu
    expect(ctx.tickets[0]!.description).toContain("Nova senha escolhida pelo cliente: Casa-Nova#2026");
    expect(ctx.tickets[0]!.description).toContain("Huawei EG8145V5-V2");
    // depois do chamado aberto a senha memorizada e apagada
    expect(await ctx.container.routerWifiJobs.getFallbackEnc(jobId)).toBeNull();
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

  it("aviso da equipe: feed com token traz a troca aceita e a resposta do cliente, sem senha, IP nem id interno", async () => {
    const ctx = await setup();
    const feed = (headers: Record<string, string> = { authorization: `Bearer ${FEED_TOKEN}` }) =>
      ctx.app.inject({ method: "GET", url: "/api/integracoes/wifi/trocas", headers, remoteAddress: freshIp() });
    expect((await feed({})).statusCode).toBe(401);
    expect((await feed({ authorization: "Bearer errado" })).statusCode).toBe(401);
    expect((await feed()).json().items).toEqual([]);

    const jobId = await changeAccepted(ctx);
    const first = (await feed()).json().items;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: jobId, contractId: "1001", bands: ["2.4GHz", "5GHz"], vendor: "Huawei", model: "EG8145V5-V2", state: "unconfirmed", confirmation: null });
    await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: ctx.auth }, payload: { connected: false }, remoteAddress: freshIp() });
    const after = (await feed()).json().items[0];
    expect(after).toMatchObject({ confirmation: "not_connected", ticketProtocol: "261116000001" });
    expect(after).not.toHaveProperty("customerId"); // so o nome; o id interno do cliente nao sai
    expect(after.customerName).toBe("customer_A"); // (no teste o nome cadastrado e esse texto)
    expect(JSON.stringify(after)).not.toMatch(/secretEnc|Casa-Nova|100\.64/);
    await ctx.app.close();
  });


  async function failedAttempt(ctx: Awaited<ReturnType<typeof setup>>, state: string, errorCode: string) {
    const { app, auth } = ctx;
    const jobId = (await app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: auth }, payload: change(), remoteAddress: freshIp() })).json().job.id as string;
    await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    await app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state, errorCode }, remoteAddress: freshIp() });
    await new Promise((r) => setTimeout(r, 40));
    return jobId;
  }

  it("depois de trocar o nome, a leitura antiga não vale: cria leitura nova e não mostra o nome velho", async () => {
    const ctx = await setup();
    const { app, auth } = ctx;
    const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: auth }, remoteAddress: freshIp() });
    const claim = () => app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    const report = (id: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${id}`, headers: agent, payload: { agentId: "a1", ...payload }, remoteAddress: freshIp() });
    // leitura concluida com o nome antigo
    const s1 = (await get("/api/customer/wifi/status?contractId=1001")).json().job.id as string;
    await claim();
    await report(s1, { state: "completed", result: { online: true, vendor: "Stavix", model: "X", firmware: null, management: "available", bands: ["2.4GHz", "5GHz"], ssids: { "2.4GHz": "Velho 2.4", "5GHz": "Velho 5G" }, canChangePassword: true } });
    expect((await get("/api/customer/wifi/status?contractId=1001")).json().job.id).toBe(s1); // ainda recente: reaproveita
    // troca de nome concluida depois da leitura
    await new Promise((r) => setTimeout(r, 20));
    const c = (await app.inject({ method: "POST", url: "/api/customer/wifi/name", headers: { authorization: auth }, payload: { contractId: "1001", name: "Novo", currentPassword: "Senha-Central-1" }, remoteAddress: freshIp() })).json().job.id as string;
    await claim();
    await report(c, { state: "completed", result: { bands: ["2.4GHz", "5GHz"], verified: true, accepted: true, vendor: "Stavix", model: "X" } });
    const nets = (await get("/api/customer/wifi/networks?contractId=1001")).json();
    expect(nets.networks.map((n: { ssid: string | null }) => n.ssid)).toEqual([null, null]);
    const s2 = (await get("/api/customer/wifi/status?contractId=1001")).json().job;
    expect(s2.id).not.toBe(s1);
    expect(s2.done).toBe(false);
    await app.close();
  });

  it.each(["CONTRACT_SUSPENDED", "CONTRACT_CANCELED"])("contrato %s: mensagem própria, sem chamado e sem guardar a senha", async (code) => {
    const ctx = await setup();
    const jobId = await failedAttempt(ctx, "failed", code);
    const seen = (await ctx.app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${jobId}`, headers: { authorization: ctx.auth }, remoteAddress: freshIp() })).json().job;
    expect(ctx.tickets).toHaveLength(0);
    expect(seen).toMatchObject({ state: "failed", fallbackTicket: false });
    expect(seen.message).not.toMatch(/chamado/);
    expect(await ctx.container.routerWifiJobs.getFallbackEnc(jobId)).toBeNull();
    expect(await ctx.container.routerWifiService.sweepFallbacks()).toBe(0);
    expect(ctx.tickets).toHaveLength(0);
    await ctx.app.close();
  });

  it("troca que não funcionou: memoriza os dados e abre o chamado sozinho, uma vez", async () => {
    const ctx = await setup();
    const jobId = await failedAttempt(ctx, "failed", "ROUTER_UNREACHABLE");
    expect(ctx.tickets).toHaveLength(1);
    expect(ctx.tickets[0]!.contractId).toBe("1001");
    expect(ctx.tickets[0]!.description).toMatch(/NÃO funcionou \(ROUTER_UNREACHABLE\)/);
    expect(ctx.tickets[0]!.description).toContain("2.4 GHz e 5 GHz");
    expect(ctx.tickets[0]!.description).toContain("Nova senha escolhida pelo cliente: Casa-Nova#2026");
    const seen = (await ctx.app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${jobId}`, headers: { authorization: ctx.auth }, remoteAddress: freshIp() })).json().job;
    expect(seen).toMatchObject({ state: "failed", fallbackTicket: true, ticketProtocol: "261116000001" });
    expect(seen.message).toContain("Abrimos o chamado 261116000001");
    // a senha memorizada some quando o chamado abre; e olhar de novo nao abre outro
    expect(await ctx.container.routerWifiJobs.getFallbackEnc(jobId)).toBeNull();
    await ctx.app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${jobId}`, headers: { authorization: ctx.auth }, remoteAddress: freshIp() });
    expect(await ctx.container.routerWifiService.sweepFallbacks()).toBe(0);
    expect(ctx.tickets).toHaveLength(1);
    // o texto cifrado no banco nao e a senha em claro
    await ctx.app.close();
  });

  it("sem suporte (modelo em validação) e 'não confirmado' por erro também viram chamado; 'roteador aceitou' não", async () => {
    const ctx = await setup();
    await failedAttempt(ctx, "unsupported", "ROUTER_REQUIRES_VALIDATION");
    expect(ctx.tickets).toHaveLength(1);
    const ctx2 = await setup();
    await failedAttempt(ctx2, "unconfirmed", "INTERNAL");
    expect(ctx2.tickets).toHaveLength(1);
    const ctx3 = await setup();
    await changeAccepted(ctx3); // aceito pelo roteador: quem decide e o cliente
    expect(ctx3.tickets).toHaveLength(0);
    // ...e a senha continua memorizada ate o cliente responder (ou 24 h)
    const [row] = await ctx3.container.routerWifiJobs.list(1);
    expect(await ctx3.container.routerWifiJobs.getFallbackEnc(row!.id)).not.toBeNull();
    await ctx.app.close();
    await ctx2.app.close();
    await ctx3.app.close();
  });

  it("concluído com confirmação do cliente apaga a senha memorizada e não abre chamado", async () => {
    const ctx = await setup();
    const jobId = await changeAccepted(ctx);
    await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: ctx.auth }, payload: { connected: true }, remoteAddress: freshIp() });
    expect(await ctx.container.routerWifiJobs.getFallbackEnc(jobId)).toBeNull();
    expect(ctx.tickets).toHaveLength(0);
    // verificado pelo agente: tambem apaga
    const j2 = (await ctx.app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: ctx.auth }, payload: change(), remoteAddress: freshIp() })).json().job.id;
    await ctx.app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    await ctx.app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${j2}`, headers: agent, payload: { agentId: "a1", state: "completed", result: { bands: ["5GHz"], verified: true } }, remoteAddress: freshIp() });
    expect(await ctx.container.routerWifiJobs.getFallbackEnc(j2)).toBeNull();
    expect(ctx.tickets).toHaveLength(0);
    await ctx.app.close();
  });

  it("se o chamado não abrir agora (SGP fora), os dados ficam memorizados e a varredura abre depois", async () => {
    const ctx = await setup();
    let falhar = true;
    const tickets: string[] = [];
    (ctx.container.routerWifiService as unknown as { hooks: unknown }).hooks = {
      openTicket: async (input: { description: string }) => {
        if (falhar) throw new Error("SGP fora");
        tickets.push(input.description);
        return { protocol: "261116000002" };
      },
      notifyChanged: async () => undefined
    };
    const jobId = await failedAttempt(ctx, "failed", "ROUTER_AUTH_FAILED");
    expect(tickets).toHaveLength(0);
    const waiting = (await ctx.app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${jobId}`, headers: { authorization: ctx.auth }, remoteAddress: freshIp() })).json().job;
    expect(waiting.ticketProtocol).toBeNull();
    expect(waiting.message).toContain("estamos abrindo o chamado");
    expect(await ctx.container.routerWifiJobs.getFallbackEnc(jobId)).not.toBeNull();
    falhar = false;
    expect(await ctx.container.routerWifiService.sweepFallbacks()).toBeGreaterThanOrEqual(1);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toContain("Casa-Nova#2026");
    expect((await ctx.container.routerWifiJobs.findById(jobId))?.ticketProtocol).toBe("261116000002");
    await ctx.app.close();
  });

  it("agente que sumiu no meio: a varredura encerra e abre o chamado; dados vencidos são apagados", async () => {
    const ctx = await setup();
    const repo = ctx.container.routerWifiJobs;
    const old = new Date(Date.now() - 10 * 60_000);
    const stuck = await repo.create({ customerId: "customer_A", contractId: "1001", kind: "change_password", bands: ["5GHz"], secretEnc: "x", fallbackEnc: (ctx.container.routerWifiService as unknown as { encryptFallback(p: string): string }).encryptFallback("Parada#2026"), now: old });
    await repo.claim("a1", 5, old);
    await ctx.container.routerWifiService.sweepFallbacks();
    expect(await repo.findById(stuck.id)).toMatchObject({ state: "unconfirmed", errorCode: "AGENT_TIMEOUT" });
    expect(ctx.tickets).toHaveLength(1);
    expect(ctx.tickets[0]!.description).toContain("Parada#2026");
    // dados memorizados vencidos (mais de 24 h) sao apagados
    const velho = await repo.create({ customerId: "customer_A", contractId: "1001", kind: "change_password", bands: ["5GHz"], secretEnc: null, fallbackEnc: "lixo", now: new Date(Date.now() - 30 * 3600_000) });
    await repo.failBySystem(velho.id, "AGENT_UNAVAILABLE", new Date());
    await ctx.container.routerWifiService.sweepFallbacks();
    expect(await repo.getFallbackEnc(velho.id)).toBeNull();
    await ctx.app.close();
  });

  it("espera longa: sem tarefa a resposta demora até waitMs; com tarefa nova responde na hora", async () => {
    const ctx = await setup();
    const claim = (body: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1", ...body }, remoteAddress: freshIp() });
    // sem tarefa: espera o prazo e volta vazio
    const t0 = Date.now();
    const vazio = await claim({ waitMs: 700 });
    expect(vazio.json().jobs).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    // tarefa que chega durante a espera: o agente recebe sem esperar o prazo todo
    const espera = claim({ waitMs: 8000 });
    await new Promise((r) => setTimeout(r, 400));
    const criado = Date.now();
    await ctx.container.routerWifiJobs.create({ customerId: "customer_A", contractId: "1001", kind: "status", bands: [], secretEnc: null });
    const res = await espera;
    expect(res.json().jobs).toHaveLength(1);
    expect(Date.now() - criado).toBeLessThan(1500);
    // limite do prazo e campo desconhecido
    expect((await claim({ waitMs: 60_000 })).statusCode).toBe(400);
    expect((await claim({ waitMs: -1 })).statusCode).toBe(400);
    // o sinal de vida vale desde o inicio da espera
    expect(await ctx.container.routerWifiService.agentOnline()).toBe(true);
    await ctx.app.close();
  });

  it("servidor reiniciou no meio da abertura do chamado: a marca velha de 'abrindo' é retomada (e a recente não)", async () => {
    const ctx = await setup();
    const repo = ctx.container.routerWifiJobs;
    const svc = ctx.container.routerWifiService as unknown as { encryptFallback(p: string): string };
    const job = await repo.create({ customerId: "customer_A", contractId: "1001", kind: "change_password", bands: ["5GHz"], secretEnc: null, fallbackEnc: svc.encryptFallback("Presa#2026") });
    await repo.failBySystem(job.id, "AGENT_UNAVAILABLE", new Date());
    // alguem reservou ha pouco e caiu: ainda nao retoma (pode estar abrindo de verdade)
    expect(await repo.claimFallback(job.id, new Date(), new Date(Date.now() - 2 * 60_000))).toBe(true);
    expect(await ctx.container.routerWifiService.sweepFallbacks()).toBe(0);
    expect(ctx.tickets).toHaveLength(0);
    // a reserva envelheceu (mais de 2 min): a varredura retoma e abre o chamado
    await repo.claimFallback(job.id, new Date(Date.now() - 5 * 60_000), new Date(Date.now() + 60_000)); // simula marca velha
    expect(await ctx.container.routerWifiService.sweepFallbacks()).toBe(1);
    expect(ctx.tickets).toHaveLength(1);
    expect(ctx.tickets[0]!.description).toContain("Presa#2026");
    expect((await repo.findById(job.id))?.ticketProtocol).toBe("261116000001");
    await ctx.app.close();
  });

  it("nome do Wi-Fi: o cliente digita só o nome; 2.4 e 5G ficam sempre no fim das duas redes", () => {
    expect(validateWifiBaseName("Casa da Ana")).toBeNull();
    expect(buildWifiNames("Casa da Ana")).toEqual({ "2.4GHz": "Casa da Ana 2.4", "5GHz": "Casa da Ana 5G" });
    expect(validateWifiBaseName("")).toMatch(/Digite/);
    expect(validateWifiBaseName(" Casa")).toMatch(/espaço/);
    expect(validateWifiBaseName("Casa 5G")).toMatch(/2.4 e 5G/); // ja traz a marca: nao duplica
    expect(validateWifiBaseName("Casa-2.4")).toMatch(/2.4 e 5G/);
    expect(validateWifiBaseName("Casa 5GHz")).toMatch(/2.4 e 5G/);
    expect(validateWifiBaseName("Cása")).toMatch(/sem acento/);
    expect(validateWifiBaseName("<b>x</b>")).toMatch(/sem acento/);
    expect(validateWifiBaseName("a  b")).toMatch(/um espaço/);
    expect(validateWifiBaseName("a".repeat(28))).toBeNull();
    expect(validateWifiBaseName("a".repeat(29))).toMatch(/28/); // com " 2.4"/" 5G" passaria de 32
  });

  const nome = (body: Record<string, unknown> = {}) => ({ contractId: "1001", name: "Casa da Ana", currentPassword: "Senha-Central-1", ...body });
  const postName = (ctx: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown> = nome(), auth: string | null = ctx.auth) =>
    ctx.app.inject({ method: "POST", url: "/api/customer/wifi/name", headers: auth ? { authorization: auth } : {}, payload: body, remoteAddress: freshIp() });
  const completarNome = async (ctx: Awaited<ReturnType<typeof setup>>, jobId: string, state: string, result?: Record<string, unknown>, errorCode?: string) => {
    await ctx.app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    return ctx.app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${jobId}`, headers: agent, payload: { agentId: "a1", state, ...(result ? { result } : {}), ...(errorCode ? { errorCode } : {}) }, remoteAddress: freshIp() });
  };

  it("troca de nome: o sistema monta os dois nomes, o agente confere de volta e termina concluído sem pedir confirmação", async () => {
    const ctx = await setup();
    expect((await postName(ctx, nome(), null)).statusCode).toBe(401);
    for (const ruim of [{ name: "Casa 5G" }, { name: "Cása" }, { name: "" }, { name: "x".repeat(40) }]) {
      expect([400, 422]).toContain((await postName(ctx, nome(ruim))).statusCode);
    }
    // o cliente nao escolhe redes nem nomes prontos: so o nome
    for (const extra of [{ bands: ["5GHz"] }, { names: { "5GHz": "x" } }, { ip: "100.64.0.1" }]) {
      expect((await postName(ctx, nome(extra))).statusCode).toBe(400);
    }
    expect((await postName(ctx, nome({ currentPassword: "errada" }))).statusCode).toBe(403);
    expect(await ctx.container.routerWifiJobs.list(10)).toHaveLength(0);

    const created = await postName(ctx);
    expect(created.statusCode).toBe(202);
    const job = created.json().job;
    expect(job).toMatchObject({ kind: "change_ssid", bands: ["2.4GHz", "5GHz"], names: { "2.4GHz": "Casa da Ana 2.4", "5GHz": "Casa da Ana 5G" } });
    // o agente recebe os nomes prontos (nao e segredo) e nenhuma senha
    const claim = await ctx.app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() });
    expect(claim.json().jobs[0]).toMatchObject({ kind: "change_ssid", secretEnc: null, params: { names: { "2.4GHz": "Casa da Ana 2.4", "5GHz": "Casa da Ana 5G" } } });
    // enquanto roda, nao deixa pedir outra troca (nome ou senha)
    expect((await postName(ctx)).statusCode).toBe(409);
    const pw = await ctx.app.inject({ method: "POST", url: "/api/customer/wifi/password", headers: { authorization: ctx.auth }, payload: change(), remoteAddress: freshIp() });
    expect(pw.statusCode).toBe(409);

    const done = await ctx.app.inject({ method: "POST", url: `/api/internal/router-agent/jobs/${job.id}`, headers: agent, payload: { agentId: "a1", state: "completed", result: { bands: ["2.4GHz", "5GHz"], verified: true, accepted: true, vendor: "Huawei", model: "EG8145V5-V2" } }, remoteAddress: freshIp() });
    expect(done.json()).toEqual({ ok: true, state: "completed" });
    const seen = (await ctx.app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${job.id}`, headers: { authorization: ctx.auth }, remoteAddress: freshIp() })).json().job;
    expect(seen).toMatchObject({ state: "completed", done: true, needsConfirmation: false });
    expect(seen.message).toMatch(/nome do Wi-Fi foi alterado/);
    expect(ctx.tickets).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.notified).toContain(job.id);
    await ctx.app.close();
  });

  it("troca de nome que não funcionou abre o chamado com os nomes (sem senha nenhuma)", async () => {
    const ctx = await setup();
    const job = (await postName(ctx)).json().job;
    await completarNome(ctx, job.id, "failed", undefined, "ROUTER_UNREACHABLE");
    await new Promise((r) => setTimeout(r, 40));
    expect(ctx.tickets).toHaveLength(1);
    expect(ctx.tickets[0]!.description).toContain("Troca do NOME do Wi-Fi");
    expect(ctx.tickets[0]!.description).toContain('"Casa da Ana 2.4"');
    expect(ctx.tickets[0]!.description).toContain('"Casa da Ana 5G"');
    expect(ctx.tickets[0]!.description).not.toMatch(/senha escolhida/i);
    const seen = (await ctx.app.inject({ method: "GET", url: `/api/customer/wifi/jobs/${job.id}`, headers: { authorization: ctx.auth }, remoteAddress: freshIp() })).json().job;
    expect(seen).toMatchObject({ fallbackTicket: true, ticketProtocol: "261116000001" });
    expect(seen.message).toContain("nome do Wi-Fi");
    // "concluido" sem a conferencia de volta no roteador nao vale: vira falha e chamado
    const ctx2 = await setup();
    const j2 = (await postName(ctx2)).json().job;
    const r2 = await completarNome(ctx2, j2.id, "completed", { bands: ["2.4GHz", "5GHz"], verified: false, accepted: true });
    expect(r2.json().state).toBe("unconfirmed");
    await new Promise((r) => setTimeout(r, 40));
    expect(ctx2.tickets).toHaveLength(1);
    await ctx.app.close();
    await ctx2.app.close();
  });

  it("histórico: lista as trocas (senha e nome) sem nunca trazer senha; só o titular enxerga", async () => {
    const ctx = await setup();
    const pwJob = await changeAccepted(ctx);
    const nameJob = (await postName(ctx)).json().job;
    await completarNome(ctx, nameJob.id, "completed", { bands: ["2.4GHz", "5GHz"], verified: true, accepted: true });
    const h = await ctx.app.inject({ method: "GET", url: "/api/customer/wifi/history?contractId=1001", headers: { authorization: ctx.auth }, remoteAddress: freshIp() });
    expect(h.statusCode).toBe(200);
    const body = h.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([nameJob.id, pwJob]); // mais nova primeiro
    expect(body.items[0]).toMatchObject({ kind: "change_ssid", done: true, names: { "2.4GHz": "Casa da Ana 2.4" } });
    expect(body.items[1]).toMatchObject({ kind: "change_password" });
    expect(body.lastPassword).toMatchObject({ bands: ["2.4GHz", "5GHz"] });
    expect(JSON.stringify(body)).not.toMatch(/Casa-Nova|password_enc|passwordEnc|secretEnc/);
    expect((await ctx.app.inject({ method: "GET", url: "/api/customer/wifi/history?contractId=1001", remoteAddress: freshIp() })).statusCode).toBe(401);
    expect([403, 404]).toContain((await ctx.app.inject({ method: "GET", url: "/api/customer/wifi/history?contractId=2002", headers: { authorization: ctx.auth }, remoteAddress: freshIp() })).statusCode);
    await ctx.app.close();
  });

  it("ver a última senha: só com a senha da Central, só a do próprio contrato, e some se o cliente disser que não funcionou", async () => {
    const ctx = await setup();
    const reveal = (body: Record<string, unknown> = {}, auth: string | null = ctx.auth) =>
      ctx.app.inject({ method: "POST", url: "/api/customer/wifi/last-password", headers: auth ? { authorization: auth } : {}, payload: { contractId: "1001", currentPassword: "Senha-Central-1", ...body }, remoteAddress: freshIp() });
    // ainda nao ha senha guardada
    expect((await reveal()).statusCode).toBe(404);
    const jobId = await changeAccepted(ctx);
    expect((await reveal({}, null)).statusCode).toBe(401);
    expect((await reveal({ currentPassword: "errada" })).statusCode).toBe(403);
    expect((await reveal({ extra: 1 })).statusCode).toBe(400);
    const ok = await reveal();
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toContain("no-store");
    expect(ok.json()).toMatchObject({ password: "Casa-Nova#2026", bands: ["2.4GHz", "5GHz"] });
    // a senha esta cifrada no banco (nunca em claro)
    const row = await ctx.container.routerWifiJobs.getLastPassword("1001");
    expect(row?.passwordEnc).toBeTruthy();
    expect(row?.passwordEnc).not.toContain("Casa-Nova");
    // outro cliente nao le a senha deste contrato
    const authB = (() => `Bearer ${ctx.container.localPasswordAuthService.tokens.issueAccessToken("customer_B", "sess_B")}`)();
    await ctx.container.authSessions.create({ id: "sess_B", sessionTokenHash: "hb", customerId: "customer_B", cpfHash: sha256("B"), expiresAt: new Date(Date.now() + 3_600_000) } as never);
    expect([403, 404]).toContain((await reveal({}, authB)).statusCode);
    // o cliente diz que NAO conectou: essa senha nao vale como "ultima senha"
    await ctx.app.inject({ method: "POST", url: `/api/customer/wifi/jobs/${jobId}/confirm`, headers: { authorization: ctx.auth }, payload: { connected: false }, remoteAddress: freshIp() });
    expect((await reveal()).statusCode).toBe(404);
    await ctx.app.close();
  });

  it("sem token de agente as rotas do agente não existem", async () => {
    const { app } = await setup({ agentToken: undefined });
    expect((await app.inject({ method: "POST", url: "/api/internal/router-agent/claim", headers: agent, payload: { agentId: "a1" }, remoteAddress: freshIp() })).statusCode).toBe(404);
    await app.close();
  });
});
