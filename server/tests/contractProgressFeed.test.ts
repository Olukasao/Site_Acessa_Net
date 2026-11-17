import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/repositories/sqlite.js";
import { SqliteContractRequestRepository } from "../src/repositories/contractRequestRepository.js";

const base = {
  planId: "800", planName: "Plano 800 Mega", planPriceCents: 16999, planPriceText: "R$ 169,99",
  cep: "07700000", street: "Rua A", number: "1", complement: null, district: "Centro", city: "Caieiras", uf: "SP",
  cityCovered: true, email: null, cpf: null, contactPeriod: null, notes: null, privacyNoticeVersion: "v1",
  marketingOptIn: false, ipHash: null, userAgent: null
};

describe("feed de contratações em andamento", () => {
  it("traz só pedidos fora de 'novo', com o motivo apenas nos cancelados e sem dados pessoais", async () => {
    const repo = new SqliteContractRequestRepository(createDatabase(":memory:"));
    const mk = (n: number) => repo.create({ ...base, protocol: `AC261117-00000${n}`, idempotencyKey: `k${n}`, customerName: `Cliente ${n}`, whatsapp: "11988887777" });
    const novo = await mk(1);
    const atend = await mk(2);
    const canc = await mk(3);
    const fim = await mk(4);
    await repo.applyChanges(atend.id, { status: "em_atendimento" }, "admin");
    await repo.applyChanges(canc.id, { status: "cancelado", note: "Motivo do cancelamento: cliente desistiu" }, "admin");
    await repo.applyChanges(fim.id, { status: "contratado" }, "admin");

    const items = await repo.listProgressForFeed(50);
    expect(items.map((i) => i.id).sort()).toEqual([atend.id, canc.id, fim.id].sort());
    expect(items.find((i) => i.id === novo.id)).toBeUndefined();
    expect(items.find((i) => i.id === canc.id)?.cancelReason).toBe("cliente desistiu");
    expect(items.find((i) => i.id === atend.id)?.cancelReason).toBeNull();
    expect(JSON.stringify(items)).not.toContain("11988887777");
  });
});
