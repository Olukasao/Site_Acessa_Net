import { describe, expect, it, vi } from "vitest";
import { createContainer, type AppContainer } from "../src/container.js";
import { OverdueNotifier } from "../src/push/overdueNotifier.js";
import { createFcmClient, type PushMessage, type PushSendResult } from "../src/push/fcmClient.js";

const TOKEN = "tokenA_" + "a".repeat(40);
const IN_WINDOW = new Date("2026-10-29T15:00:00Z"); // 12:00 Sao Paulo
const BEFORE_WINDOW = new Date("2026-10-29T11:59:00Z"); // 08:59
const AT_END = new Date("2026-10-29T23:00:00Z"); // 20:00

type Inv = { id: string; status: string; dueDate?: string; daysLate?: number; amount?: number };
const inv = (id: string, status: string, dueDate?: string, daysLate?: number): Inv => ({ id, status, number: id, amount: 123.45, ...(dueDate ? { dueDate } : {}), ...(daysLate !== undefined ? { daysLate } : {}) }) as Inv;

async function setup(invoices: Record<string, Inv[] | Error | "unavailable">, extra: { now?: () => Date; enabled?: boolean } = {}) {
  const container: AppContainer = createContainer({ env: "test", sqlitePath: ":memory:", sgp: { basicUsername: "t", basicPassword: "t" } } as never);
  await container.pushDevices.upsertDevice({ customerId: "c1", token: TOKEN, platform: "android", contractIds: Object.keys(invoices) });
  const calls: string[] = [];
  const billing = {
    async listInvoices(contract: { id: string }) {
      calls.push(contract.id);
      const entry = invoices[contract.id];
      if (entry instanceof Error) throw entry;
      return { contractId: contract.id, invoices: entry === "unavailable" ? [] : (entry ?? []), updatedAt: "", source: entry === "unavailable" ? "unavailable" : "sgp" } as never;
    }
  };
  const sent: PushMessage[] = [];
  let result: PushSendResult = "ok";
  const make = (now: () => Date = () => IN_WINDOW) =>
    new OverdueNotifier({
      repo: container.pushDevices,
      billing,
      enabled: extra.enabled ?? true,
      send: async (m) => (sent.push(m), result),
      now
    });
  return { container, calls, sent, make, setResult: (r: PushSendResult) => (result = r) };
}

describe("OverdueNotifier", () => {
  it("primeiro atraso notifica 1x, sem valor em reais, com a data de vencimento; ciclo repetido nao duplica", async () => {
    const { sent, make } = await setup({ "1001": [inv("f1", "OVERDUE", "2026-10-27", 2)] });
    const n = make();
    await n.runCycle();
    await n.runCycle();
    await make().runCycle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: "Fatura em atraso",
      body: "Você tem uma fatura vencida em 27/10/2026. Toque para ver como pagar.",
      channelId: "faturas",
      data: { route: "/cliente/faturas" }
    });
    expect(JSON.stringify(sent[0])).not.toMatch(/123|R\$/);
  });

  it("5+ dias dispara o estagio 2 uma unica vez", async () => {
    const list = [inv("f1", "OVERDUE", "2026-10-27", 2)];
    const { sent, make, container } = await setup({ "1001": list });
    const n = make();
    await n.runCycle();
    list[0] = inv("f1", "OVERDUE", "2026-10-24", 5);
    await n.runCycle();
    await n.runCycle();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      title: "Fatura vencida há 5 dias",
      body: "Para evitar a redução de velocidade, regularize o pagamento. Toque para ver as opções."
    });
    expect((await container.pushDevices.getBillingStages("c1")).get("f1")).toBe(2);
  });

  it("sem daysLate calcula pela data de vencimento (fuso de Sao Paulo)", async () => {
    const { sent, make } = await setup({ "1001": [inv("f1", "OVERDUE", "2026-10-24", 0)] });
    // daysLate=0 explicito vale; usa um sem o campo:
    const s2 = await setup({ "1001": [inv("f1", "OVERDUE", "2026-10-24")] });
    const n = s2.make();
    await n.runCycle();
    await n.runCycle();
    expect(s2.sent).toHaveLength(2); // estagio 1 e depois 2 (5 dias)
    await make().runCycle();
    expect(sent).toHaveLength(1);
  });

  it("fatura paga ou aberta nao notifica; fatura que foi paga nao recebe estagio 2", async () => {
    const list = [inv("f1", "PAID", "2026-10-20"), inv("f2", "OPEN", "2026-11-05")];
    const { sent, make } = await setup({ "1001": list });
    await make().runCycle();
    expect(sent).toHaveLength(0);
    const l2 = [inv("f3", "OVERDUE", "2026-10-27", 2)];
    const s2 = await setup({ "1001": l2 });
    const n = s2.make();
    await n.runCycle();
    l2[0] = inv("f3", "PAID", "2026-10-27");
    await n.runCycle();
    expect(s2.sent).toHaveLength(1);
  });

  it("fora da janela 09-20 nao envia, nao consulta e nao grava; dentro, envia depois", async () => {
    for (const t of [BEFORE_WINDOW, AT_END]) {
      const { sent, calls, make, container } = await setup({ "1001": [inv("f1", "OVERDUE", "2026-10-27", 2)] });
      expect(await make(() => t).runCycle()).toMatchObject({ skipped: "quiet_hours" });
      expect(sent).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect((await container.pushDevices.getBillingStages("c1")).size).toBe(0);
    }
    const ok = await setup({ "1001": [inv("f1", "OVERDUE", "2026-10-27", 2)] });
    await ok.make(() => new Date("2026-10-29T12:00:00Z")).runCycle(); // 09:00 em SP
    expect(ok.sent).toHaveLength(1);
  });

  it("varias faturas vencidas => uma notificacao e estado de todas", async () => {
    const { sent, make, container } = await setup({
      "1001": [inv("f2", "OVERDUE", "2026-10-27", 2), inv("f1", "OVERDUE", "2026-10-21", 8)],
      "1002": [inv("f3", "OVERDUE", "2026-10-26", 3)]
    });
    const n = make();
    await n.runCycle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Você tem 3 faturas vencidas. Toque para ver como pagar.");
    expect([...(await container.pushDevices.getBillingStages("c1")).entries()].sort()).toEqual([["f1", 1], ["f2", 1], ["f3", 1]]);
    await n.runCycle();
    expect(sent).toHaveLength(2); // f1 (8 dias) sobe para o estagio 2
    expect(sent[1]!.title).toBe("Fatura vencida há 8 dias");
  });

  it("token invalido e desativado e retry nao grava", async () => {
    const s = await setup({ "1001": [inv("f1", "OVERDUE", "2026-10-27", 2)] });
    s.setResult("retry");
    const n = s.make();
    await n.runCycle();
    expect((await s.container.pushDevices.getBillingStages("c1")).size).toBe(0);
    expect(await s.container.pushDevices.listActiveDevices()).toHaveLength(1);
    s.setResult("invalid_token");
    await n.runCycle();
    expect(await s.container.pushDevices.listActiveDevices()).toHaveLength(0);
    expect((await s.container.pushDevices.getBillingStages("c1")).size).toBe(0);
    s.setResult("ok");
    await n.runCycle();
    expect(s.sent).toHaveLength(2); // sem dispositivos ativos, o terceiro ciclo nao envia
  });

  it("erro ou indisponibilidade do SGP pula o contrato sem falhar", async () => {
    const { sent, make } = await setup({ "1001": new Error("SGP_BUSY"), "1002": "unavailable" });
    await expect(make().runCycle()).resolves.toMatchObject({ contracts: 2, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("sem credencial FCM nenhuma consulta ao SGP", async () => {
    const warn = vi.fn();
    const fcm = createFcmClient({ env: {}, log: { info: vi.fn(), warn } });
    const { calls, container } = await setup({ "1001": [inv("f1", "OVERDUE", "2026-10-27", 2)] });
    const n = new OverdueNotifier({
      repo: container.pushDevices,
      billing: { listInvoices: async (c) => (calls.push(c.id), { contractId: c.id, invoices: [], updatedAt: "", source: "sgp" }) },
      enabled: fcm.enabled,
      send: fcm.send,
      now: () => IN_WINDOW
    });
    expect(await n.runCycle()).toMatchObject({ skipped: "disabled" });
    expect(calls).toHaveLength(0);
  });
});
