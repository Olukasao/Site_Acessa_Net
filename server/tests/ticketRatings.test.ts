import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createContainer, type AppContainer } from "../src/container.js";
import { sha256 } from "../src/security/hash.js";
import { RatingNotifier, RATING_PUSH_TITLE } from "../src/push/ratingNotifier.js";
import type { PushMessage, PushSendResult } from "../src/push/fcmClient.js";
import { buildRatingsSummary, listRatings, NO_TECHNICIAN_LABEL } from "../src/support/ratingsReport.js";
import { cleanRatingComment } from "../src/routes/ratingRoutes.js";
import { extractTechnicianName } from "../src/integrations/sgp/sgpMapper.js";

const TOKEN = "tokenR_" + "r".repeat(40);
const NOW = new Date("2026-10-30T15:00:00Z");
const HOUR = 3_600_000;

let ipCounter = 0;
const freshIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function setup() {
  const container = createContainer({ env: "test", sqlitePath: ":memory:", sgp: { basicUsername: "t", basicPassword: "t" } } as never);
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

function closed(numero: string, opts: { finalizacao?: string; responsavel?: string; status?: string } = {}) {
  return {
    numero,
    status: opts.status ?? "Encerrada",
    data_cadastro: "2026-10-28",
    hora_cadastro: "08:15",
    data_finalizacao: opts.finalizacao ?? "2026-10-30",
    tipo: "Sem internet",
    conteudo: "Chamado finalizado.",
    ordens_servicos: opts.responsavel ? [{ status: "Encerrada", responsavel: opts.responsavel }] : []
  };
}

function fakeTickets(map: Record<string, unknown[]>) {
  return {
    async listOccurrencesByContract(contractId: string) {
      return (map[contractId] ?? []).map((raw) => ({ id: String((raw as { numero: string }).numero), contractId, raw })) as never;
    }
  };
}

function notifier(container: AppContainer, tickets: ReturnType<typeof fakeTickets>, send: (m: PushMessage) => Promise<PushSendResult>, now: () => Date, extra: object = {}) {
  return new RatingNotifier({ repo: container.pushDevices, ratings: container.ticketRatings, tickets, enabled: true, send, now, ...extra });
}

async function registerDevice(container: AppContainer) {
  await container.pushDevices.upsertDevice({ customerId: "customer_A", token: TOKEN, platform: "android", contractIds: ["1001"], now: NOW });
}

describe("RatingNotifier", () => {
  it("com espera configurada (2h), so manda o push depois dela, uma unica vez", async () => {
    const { container, app } = await setup();
    await registerDevice(container);
    const send = vi.fn(async (_m: PushMessage): Promise<PushSendResult> => "ok");
    let now = NOW;
    const n = notifier(container, fakeTickets({ "1001": [closed("261030001", { responsavel: "Carlos Silva" })] }), send, () => now, { delayMs: 2 * HOUR });

    expect(await n.runCycle()).toMatchObject({ requested: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();

    now = new Date(NOW.getTime() + 1 * HOUR);
    expect(await n.runCycle()).toMatchObject({ requested: 0, sent: 0 });

    now = new Date(NOW.getTime() + 2 * HOUR + 1000);
    expect(await n.runCycle()).toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ title: RATING_PUSH_TITLE, token: TOKEN, data: { route: "/cliente/chamados", protocol: "261030001", action: "rate" } });

    now = new Date(NOW.getTime() + 5 * HOUR);
    await n.runCycle();
    expect(send).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("guarda o tecnico, ignora chamado aberto e chamado encerrado ha mais de 3 dias", async () => {
    const { container, app } = await setup();
    await registerDevice(container);
    const n = notifier(
      container,
      fakeTickets({
        "1001": [
          closed("1", { responsavel: "Carlos Silva" }),
          closed("2", { status: "Aberta" }),
          closed("3", { finalizacao: "2026-10-20" })
        ]
      }),
      async () => "ok",
      () => NOW
    );
    await n.runCycle();
    const records = await container.ticketRatings.listInRange(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() + HOUR), 100);
    expect(records.map((r) => r.protocol)).toEqual(["1"]);
    expect(records[0]).toMatchObject({ technician: "Carlos Silva", ticketTitle: "Sem internet" });
    await app.close();
  });

  it("manda um unico push por cliente, do chamado mais recente", async () => {
    const { container, app } = await setup();
    await registerDevice(container);
    const old = new Date(NOW.getTime() - 3 * HOUR);
    await container.ticketRatings.createRequest({ customerId: "customer_A", contractId: "1001", protocol: "261030000001", ticketTitle: "Antigo", dueAt: old, now: old });
    await container.ticketRatings.createRequest({ customerId: "customer_A", contractId: "1001", protocol: "261030000002", ticketTitle: "Novo", dueAt: old, now: NOW });
    const send = vi.fn(async (_m: PushMessage): Promise<PushSendResult> => "ok");
    const n = notifier(container, fakeTickets({}), send, () => new Date(NOW.getTime() + 1000));
    await n.runCycle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].data).toMatchObject({ protocol: "261030000002" });
    await n.runCycle();
    expect(send).toHaveBeenCalledTimes(1); // o antigo foi dado como tratado, nao sai depois
    await app.close();
  });

  it("desativa token invalido e tenta de novo se o FCM falhar", async () => {
    const { container, app } = await setup();
    await registerDevice(container);
    const outcomes: PushSendResult[] = ["retry", "ok"];
    const send = vi.fn(async (): Promise<PushSendResult> => outcomes.shift() ?? "ok");
    let now = NOW;
    const n = notifier(container, fakeTickets({ "1001": [closed("9")] }), send, () => now, { delayMs: 0 });
    await n.runCycle();
    expect(send).toHaveBeenCalledTimes(1);
    now = new Date(NOW.getTime() + 60_000);
    await n.runCycle();
    expect(send).toHaveBeenCalledTimes(2);
    now = new Date(NOW.getTime() + 120_000);
    await n.runCycle();
    expect(send).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("nao faz nada se desligado", async () => {
    const { container, app } = await setup();
    const n = notifier(container, fakeTickets({}), async () => "ok", () => NOW, { enabled: false });
    expect(await n.runCycle()).toMatchObject({ skipped: "disabled" });
    await app.close();
  });
});

describe("rotas /v1/ratings", () => {
  const get = (app: Awaited<ReturnType<typeof setup>>["app"], auth?: string) =>
    app.inject({ method: "GET", url: "/v1/ratings/pending", headers: auth ? { authorization: auth } : {}, remoteAddress: freshIp() });
  const post = (app: Awaited<ReturnType<typeof setup>>["app"], auth: string, payload: unknown) =>
    app.inject({ method: "POST", url: "/v1/ratings", payload: payload as never, headers: { authorization: auth }, remoteAddress: freshIp() });

  it("exige login", async () => {
    const { app } = await setup();
    expect((await get(app)).statusCode).toBe(401);
    await app.close();
  });

  it("lista no maximo o pedido mais recente do proprio cliente e aceita uma unica avaliacao por chamado", async () => {
    const { container, app, customers } = await setup();
    const past = new Date(Date.now() - HOUR);
    const future = new Date(Date.now() + HOUR);
    await container.ticketRatings.createRequest({ customerId: "customer_A", contractId: "1001", protocol: "P1", ticketTitle: "Sem internet", technician: "Carlos", dueAt: past, now: past });
    await container.ticketRatings.createRequest({ customerId: "customer_A", contractId: "1001", protocol: "P2", ticketTitle: "Lenta", dueAt: future, now: past });
    await container.ticketRatings.createRequest({ customerId: "customer_B", contractId: "2002", protocol: "P3", ticketTitle: "Wi-Fi", dueAt: past, now: past });

    // O SGP confirma P2 como encerrado agora (so assim o cartao aparece).
    const today = new Date().toISOString().slice(0, 10);
    vi.spyOn(container.providers.tickets, "listOccurrencesByContract").mockImplementation(
      async (contractId: string) => [{ id: "P2", contractId, raw: closed("P2", { finalizacao: today }) }] as never
    );
    // Dois pendentes do mesmo cliente: so o mais recente (P2) e pedido; o P1, mais antigo, nunca aparece.
    const pending = await get(app, customers.A!.auth);
    expect(pending.json().pending).toEqual([{ protocol: "P2", contractId: "1001", title: "Lenta" }]);
    expect(pending.body).not.toContain("Carlos");

    expect((await post(app, customers.A!.auth, { protocol: "P1", rating: 5, comment: "  Ótimo   atendimento \u0000 " })).statusCode).toBe(200);
    expect((await post(app, customers.A!.auth, { protocol: "P1", rating: 1 })).statusCode).toBe(409); // ja avaliado
    expect((await post(app, customers.A!.auth, { protocol: "P3", rating: 4 })).statusCode).toBe(409); // de outro cliente
    expect((await get(app, customers.A!.auth)).json().pending).toHaveLength(1);
    expect((await post(app, customers.A!.auth, { protocol: "P2", rating: 4 })).statusCode).toBe(200);
    expect((await get(app, customers.A!.auth)).json().pending).toEqual([]);

    const [saved] = (await container.ticketRatings.listInRange(new Date(0), new Date(Date.now() + HOUR), 10)).filter((r) => r.protocol === "P1");
    expect(saved).toMatchObject({ rating: 5, comment: "Ótimo atendimento" });
    await app.close();
  });

  it("cliente com 50 chamados encerrados avalia so o ultimo, e os antigos nunca viram pedido", async () => {
    const { container, app, customers } = await setup();
    const today = new Date().toISOString().slice(0, 10);
    const occurrences = Array.from({ length: 50 }, (_, i) => closed(`2610300000${String(i).padStart(2, "0")}`, { finalizacao: today }));
    vi.spyOn(container.providers.tickets, "listOccurrencesByContract").mockImplementation(
      async (contractId: string) => occurrences.map((raw) => ({ id: raw.numero, contractId, raw })) as never
    );
    const first = await get(app, customers.A!.auth);
    expect(first.json().pending).toEqual([{ protocol: "261030000049", contractId: "1001", title: "Sem internet" }]);
    const rows = await container.ticketRatings.listInRange(new Date(0), new Date(Date.now() + HOUR), 100);
    expect(rows.map((r) => r.protocol)).toEqual(["261030000049"]);

    // Depois de avaliar o ultimo, nada mais e pedido (os 49 antigos nao entram na fila).
    expect((await post(app, customers.A!.auth, { protocol: "261030000049", rating: 5 })).statusCode).toBe(200);
    expect((await get(app, customers.A!.auth)).json().pending).toEqual([]);
    await app.close();
  });

  it("entre chamados encerrados em dias diferentes, vale o de encerramento mais recente", async () => {
    const { container, app, customers } = await setup();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10);
    const list = [closed("261030000900", { finalizacao: yesterday }), closed("261030000100", { finalizacao: today })];
    vi.spyOn(container.providers.tickets, "listOccurrencesByContract").mockImplementation(
      async (contractId: string) => list.map((raw) => ({ id: raw.numero, contractId, raw })) as never
    );
    const res = await get(app, customers.A!.auth);
    expect(res.json().pending.map((item: { protocol: string }) => item.protocol)).toEqual(["261030000100"]);
    await app.close();
  });

  it("nao mostra a avaliacao se o chamado foi reaberto ou cancelado", async () => {
    const { container, app, customers } = await setup();
    const today = new Date().toISOString().slice(0, 10);
    await container.ticketRatings.createRequest({ customerId: "customer_A", contractId: "1001", protocol: "261030777", ticketTitle: "x", dueAt: new Date(), now: new Date() });
    const spy = vi.spyOn(container.providers.tickets, "listOccurrencesByContract");
    // Reaberto: o SGP agora diz que esta aberto.
    spy.mockImplementation(async (contractId: string) => [{ id: "261030777", contractId, raw: closed("261030777", { status: "Aberta", finalizacao: today }) }] as never);
    expect((await get(app, customers.A!.auth)).json().pending).toEqual([]);
    await app.close();
    const second = await setup();
    // Cancelado nao e atendimento concluido.
    vi.spyOn(second.container.providers.tickets, "listOccurrencesByContract").mockImplementation(
      async (contractId: string) => [{ id: "261030888", contractId, raw: closed("261030888", { status: "Cancelada", finalizacao: today }) }] as never
    );
    expect((await get(second.app, second.customers.A!.auth)).json().pending).toEqual([]);
    expect(await second.container.ticketRatings.listInRange(new Date(0), new Date(Date.now() + HOUR), 10)).toEqual([]);
    await second.app.close();
  });

  it("detecta na hora o chamado que acabou de ser encerrado no SGP, sem esperar o ciclo do notificador", async () => {
    const { container, app, customers } = await setup();
    vi.spyOn(container.providers.tickets, "listOccurrencesByContract").mockImplementation(
      async (contractId: string) =>
        [{ id: "261030001", contractId, raw: closed("261030001", { responsavel: "Carlos Silva", finalizacao: new Date().toISOString().slice(0, 10) }) }] as never
    );
    const pending = await get(app, customers.A!.auth);
    expect(pending.json().pending).toEqual([{ protocol: "261030001", contractId: "1001", title: "Sem internet" }]);
    const [stored] = await container.ticketRatings.listInRange(new Date(0), new Date(Date.now() + HOUR), 10);
    expect(stored).toMatchObject({ protocol: "261030001", technician: "Carlos Silva" });
    await app.close();
  });

  it("valida a nota", async () => {
    const { app, customers } = await setup();
    for (const rating of [0, 6, 2.5, "5"]) {
      expect((await post(app, customers.A!.auth, { protocol: "P1", rating })).statusCode).toBe(400);
    }
    await app.close();
  });
});

describe("relatorio de avaliacoes", () => {
  const rec = (protocol: string, technician: string | null, rating: number | null, comment: string | null = null) => ({
    id: protocol,
    customerId: "c",
    contractId: "1",
    protocol,
    ticketTitle: "t",
    technician,
    dueAt: "2026-10-30T10:00:00.000Z",
    pushedAt: null,
    answeredAt: rating === null ? null : `2026-10-30T1${protocol.slice(-1)}:00:00.000Z`,
    rating,
    comment,
    createdAt: "2026-10-30T09:00:00.000Z"
  });
  const records = [rec("p1", "Carlos", 5), rec("p2", "Carlos", 1, "Demorou"), rec("p3", "Ana", 4), rec("p4", null, 2, "Ruim"), rec("p5", "Ana", null)];

  it("calcula media geral, distribuicao, taxa de resposta e media por tecnico", () => {
    const summary = buildRatingsSummary(records);
    expect(summary).toMatchObject({ requests: 5, answered: 4, responseRate: 0.8, average: 3, low: 2 });
    expect(summary.distribution).toEqual({ "1": 1, "2": 1, "3": 0, "4": 1, "5": 1 });
    expect(summary.byTechnician).toContainEqual({ technician: "Carlos", answered: 2, average: 3, low: 1 });
    expect(summary.byTechnician).toContainEqual({ technician: "Ana", answered: 1, average: 4, low: 0 });
    expect(summary.byTechnician.map((t) => t.technician)).toContain(NO_TECHNICIAN_LABEL);
  });

  it("sem respostas a media e nula", () => {
    expect(buildRatingsSummary([rec("p1", "Ana", null)])).toMatchObject({ answered: 0, average: null, responseRate: 0 });
  });

  it("filtra por nota, tecnico e comentario e pagina do mais recente para o mais antigo", () => {
    expect(listRatings(records, { rating: 1 }, 1, 10).items.map((i) => i.protocol)).toEqual(["p2"]);
    expect(listRatings(records, { technician: NO_TECHNICIAN_LABEL }, 1, 10).items.map((i) => i.protocol)).toEqual(["p4"]);
    expect(listRatings(records, { withComment: true }, 1, 10).total).toBe(2);
    const page = listRatings(records, {}, 2, 2);
    expect(page).toMatchObject({ total: 4, page: 2 });
    expect(page.items).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("limpa o comentario", () => {
    expect(cleanRatingComment(undefined)).toBeNull();
    expect(cleanRatingComment("   ")).toBeNull();
    expect(cleanRatingComment("a\u0000b\u0007c")).toBe("abc");
    expect(cleanRatingComment("x".repeat(900))).toHaveLength(500);
  });

  it("le o tecnico da OS pelos campos que a Agenda usa", () => {
    expect(extractTechnicianName({ ordens_servicos: [{ status: "x" }, { os_tecnico_responsavel: "  João\n  Souza " }] } as never)).toBe("João Souza");
    expect(extractTechnicianName({ ordens_servicos: [{ responsavel: "maria" }] } as never)).toBe("maria");
    expect(extractTechnicianName({ ordens_servicos: [] } as never)).toBeUndefined();
    expect(extractTechnicianName({} as never)).toBeUndefined();
  });
});

describe("GET /admin/api/avaliacoes", () => {
  async function adminAuth(app: Awaited<ReturnType<typeof setup>>["app"], container: AppContainer, role: "admin" | "vendedor") {
    const { hashPassword } = await import("../src/security/hash.js");
    const email = `${role}@acessanet.test`;
    await container.adminUsers.create({ id: `adm_${role}`, email, name: role, passwordHash: await hashPassword("Senha-de-teste-123"), role });
    const login = await app.inject({ method: "POST", url: "/admin/api/auth/login", payload: { email, password: "Senha-de-teste-123" }, remoteAddress: freshIp() });
    expect(login.statusCode).toBe(200);
    return `Bearer ${login.json().accessToken as string}`;
  }

  it("exige login de admin e nao abre para vendedor", async () => {
    const { app, container } = await setup();
    expect((await app.inject({ method: "GET", url: "/admin/api/avaliacoes", remoteAddress: freshIp() })).statusCode).toBe(401);
    const seller = await adminAuth(app, container, "vendedor");
    expect((await app.inject({ method: "GET", url: "/admin/api/avaliacoes", headers: { authorization: seller }, remoteAddress: freshIp() })).statusCode).toBe(403);
    await app.close();
  });

  it("devolve resumo por tecnico e lista filtrada", async () => {
    const { app, container } = await setup();
    const now = new Date();
    const past = new Date(now.getTime() - HOUR);
    for (const [protocol, technician, stars, comment] of [
      ["A1", "Carlos", 5, null],
      ["A2", "Carlos", 1, "Demorou"],
      ["A3", "Ana", 4, null]
    ] as const) {
      await container.ticketRatings.createRequest({ customerId: "customer_A", contractId: "1001", protocol, ticketTitle: "Sem internet", technician, dueAt: past, now: past });
      await container.ticketRatings.submit("customer_A", protocol, stars, comment, now);
    }
    await container.ticketRatings.createRequest({ customerId: "customer_A", contractId: "1001", protocol: "A4", ticketTitle: "Lenta", dueAt: past, now: past });

    const admin = await adminAuth(app, container, "admin");
    const res = await app.inject({ method: "GET", url: "/admin/api/avaliacoes?period=7d", headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toMatchObject({ requests: 4, answered: 3, average: 3.33, low: 1 });
    expect(body.summary.byTechnician).toContainEqual({ technician: "Carlos", answered: 2, average: 3, low: 1 });
    expect(body.total).toBe(3);

    const filtered = await app.inject({ method: "GET", url: "/admin/api/avaliacoes?period=7d&technician=Carlos&withComment=1", headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(filtered.json().items.map((i: { protocol: string }) => i.protocol)).toEqual(["A2"]);

    await app.close();
  });
});

describe("DELETE /admin/api/avaliacoes (limpar avaliacoes de teste)", () => {
  async function adminAuth(app: Awaited<ReturnType<typeof setup>>["app"], container: AppContainer, role: "admin" | "editor" | "vendedor") {
    const { hashPassword } = await import("../src/security/hash.js");
    const email = `${role}@acessanet.test`;
    await container.adminUsers.create({ id: `adm_${role}`, email, name: role, passwordHash: await hashPassword("Senha-de-teste-123"), role });
    const login = await app.inject({ method: "POST", url: "/admin/api/auth/login", payload: { email, password: "Senha-de-teste-123" }, remoteAddress: freshIp() });
    expect(login.statusCode).toBe(200);
    return `Bearer ${login.json().accessToken as string}`;
  }

  async function seed(container: AppContainer) {
    const past = new Date(Date.now() - HOUR);
    // Contrato de teste (3005): uma respondida e uma pendente. Contrato de cliente real (1001): uma respondida.
    await container.ticketRatings.createRequest({ customerId: "customer_T", contractId: "3005", protocol: "T1", ticketTitle: "Teste", dueAt: past, now: past });
    await container.ticketRatings.submit("customer_T", "T1", 5, "ok", new Date());
    await container.ticketRatings.createRequest({ customerId: "customer_T", contractId: "3005", protocol: "T2", ticketTitle: "Teste 2", dueAt: past, now: past });
    await container.ticketRatings.createRequest({ customerId: "customer_A", contractId: "1001", protocol: "R1", ticketTitle: "Real", dueAt: past, now: past });
    await container.ticketRatings.submit("customer_A", "R1", 4, null, new Date());
  }

  it("so admin apaga: sem login 401, editor e vendedor 403, e nada some", async () => {
    const { app, container } = await setup();
    await seed(container);
    const item = await container.ticketRatings.findByProtocol("T1");

    expect((await app.inject({ method: "DELETE", url: `/admin/api/avaliacoes/${item!.id}`, remoteAddress: freshIp() })).statusCode).toBe(401);
    for (const role of ["editor", "vendedor"] as const) {
      const token = await adminAuth(app, container, role);
      const res = await app.inject({ method: "DELETE", url: `/admin/api/avaliacoes/${item!.id}`, headers: { authorization: token }, remoteAddress: freshIp() });
      expect(res.statusCode).toBe(403);
    }
    expect(await container.ticketRatings.findByProtocol("T1")).not.toBeNull();
    await app.close();
  });

  it("apaga uma avaliacao so, deixa as outras e registra na auditoria o que foi apagado", async () => {
    const { app, container } = await setup();
    await seed(container);
    const admin = await adminAuth(app, container, "admin");
    const item = await container.ticketRatings.findByProtocol("T1");
    const audit = vi.spyOn(container.adminAuditLog, "record");

    const res = await app.inject({ method: "DELETE", url: `/admin/api/avaliacoes/${item!.id}`, headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(res.statusCode).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DELETE_RATING", beforeSnapshot: expect.objectContaining({ protocol: "T1", contractId: "3005", rating: 5 }) })
    );
    expect(await container.ticketRatings.findByProtocol("T1")).toBeNull();
    expect(await container.ticketRatings.findByProtocol("T2")).not.toBeNull();
    expect(await container.ticketRatings.findByProtocol("R1")).not.toBeNull();

    const missing = await app.inject({ method: "DELETE", url: `/admin/api/avaliacoes/${item!.id}`, headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("apaga todas as do contrato (respondidas e pendentes) sem tocar em outro contrato", async () => {
    const { app, container } = await setup();
    await seed(container);
    const admin = await adminAuth(app, container, "admin");
    const audit = vi.spyOn(container.adminAuditLog, "record");

    const res = await app.inject({ method: "DELETE", url: "/admin/api/avaliacoes/contrato/3005", headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, deleted: 2 });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DELETE_CONTRACT_RATINGS", beforeSnapshot: { contractId: "3005", deleted: 2 } })
    );
    expect(await container.ticketRatings.findByProtocol("T1")).toBeNull();
    expect(await container.ticketRatings.findByProtocol("T2")).toBeNull();
    expect(await container.ticketRatings.findByProtocol("R1")).not.toBeNull();

    const again = await app.inject({ method: "DELETE", url: "/admin/api/avaliacoes/contrato/3005", headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(again.statusCode).toBe(404);

    const bad = await app.inject({ method: "DELETE", url: "/admin/api/avaliacoes/contrato/3005%27%20OR%201=1", headers: { authorization: admin }, remoteAddress: freshIp() });
    expect(bad.statusCode).toBe(400);
    expect(await container.ticketRatings.findByProtocol("R1")).not.toBeNull();
    await app.close();
  });

  it("a lista de avaliacoes traz o id de cada uma, para o botao Excluir", async () => {
    const { app, container } = await setup();
    await seed(container);
    const admin = await adminAuth(app, container, "admin");
    const res = await app.inject({ method: "GET", url: "/admin/api/avaliacoes?period=7d", headers: { authorization: admin }, remoteAddress: freshIp() });
    const items = res.json().items as Array<{ id: string; protocol: string }>;
    expect(items.every((item) => typeof item.id === "string" && item.id.length > 0)).toBe(true);
    await app.close();
  });
});
