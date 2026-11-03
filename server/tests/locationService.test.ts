import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/repositories/sqlite.js";
import { SqliteLocationRequestRepository } from "../src/repositories/locationRequestRepository.js";
import { LocationService, buildLocationNote, MAX_ACCURACY_METERS } from "../src/support/locationService.js";
import type { SgpUraClient } from "../src/integrations/sgp/sgpClient.js";
import type { TicketProvider } from "../src/integrations/sgp/providers.js";
import type { InMemoryStore } from "../src/repositories/inMemoryStore.js";
import type { PublicTicketVisit } from "../src/types.js";

const visit = (over: Partial<PublicTicketVisit> = {}): PublicTicketVisit =>
  ({ id: "1", protocol: "261103100000", contractId: "3005", status: "SCHEDULED", statusInterno: "scheduled", title: "Visita", createdAt: "", updatedAt: "", appointment: undefined, ...over }) as PublicTicketVisit;

function build(options: { tickets?: PublicTicketVisit[]; orders?: Array<Record<string, unknown>>; noteFails?: "os" | "occurrence"; sgpDown?: boolean; notInSgp?: boolean } = {}) {
  const repo = new SqliteLocationRequestRepository(createDatabase(":memory:"));
  const addServiceOrderNote = vi.fn(async (input: { target: "os" | "occurrence" }) => {
    if (options.noteFails === input.target) throw new Error("sgp");
  });
  const addOccurrenceAttachment = vi.fn(async () => undefined);
  const client = { addServiceOrderNote, addOccurrenceAttachment } as unknown as SgpUraClient;
  const tickets = {
    listOccurrencesByContract: vi.fn(async () => {
      if (options.sgpDown) throw new Error("SGP fora do ar");
      if (options.notInSgp) return [];
      return [{ protocol: "261103100000", contractId: "3005", raw: { id: 784001, ordens_servicos: options.orders ?? [{ id: 227041, status: "Aberta" }] } }];
    })
  } as unknown as TicketProvider;
  const service = new LocationService(repo, {} as InMemoryStore, client, tickets, async () => options.tickets ?? [visit()]);
  (service as unknown as { ownership: unknown }).ownership = { assertContract: vi.fn().mockResolvedValue({ id: "3005" }) };
  return { service, repo, addServiceOrderNote, addOccurrenceAttachment, tickets: tickets as unknown as { listOccurrencesByContract: ReturnType<typeof vi.fn> } };
}

const base = { customerId: "c1", contractId: "3005", protocol: "261103100000", latitude: -23.3232, longitude: -46.7284, accuracyMeters: 25, source: "app" as const };

describe("LocationService.submit - entrega ao chamado", () => {
  it("manda o link do mapa sozinho para a OS e para a ocorrencia, sem esperar aprovacao", async () => {
    const { service, addServiceOrderNote, addOccurrenceAttachment } = build();
    const record = await service.submit(base);

    expect(record).toMatchObject({ status: "approved", reviewedBy: "auto", contractId: "3005", protocol: "261103100000", source: "app" });
    expect(record.sgpPostedAt).not.toBeNull();
    expect(addServiceOrderNote).toHaveBeenCalledWith(
      expect.objectContaining({ osId: "227041", target: "os", text: expect.stringContaining("https://www.google.com/maps/search/?api=1&query=-23.323200,-46.728400") })
    );
    expect(addServiceOrderNote).toHaveBeenCalledWith(expect.objectContaining({ osId: "227041", target: "occurrence" }));
    expect(addOccurrenceAttachment).not.toHaveBeenCalled();
  });

  it("chamado SEM OS: grava o link como anexo de texto na aba Anexos da ocorrencia", async () => {
    const { service, addServiceOrderNote, addOccurrenceAttachment } = build({ orders: [] });
    const record = await service.submit(base);

    expect(record.status).toBe("approved");
    expect(addServiceOrderNote).not.toHaveBeenCalled();
    expect(addOccurrenceAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceId: "784001", filename: "localizacao-da-casa.txt", contentType: "text/plain" })
    );
    const call = (addOccurrenceAttachment.mock.calls[0] as unknown as [{ data: Buffer }])[0];
    expect(call.data.toString("utf8")).toContain("https://www.google.com/maps/search/?api=1&query=-23.323200,-46.728400");
  });

  it("se o SGP falha o envio NAO se perde: fica pendente para reenviar pelo painel", async () => {
    const { service, repo } = build({ sgpDown: true });
    const record = await service.submit(base);
    expect(record).toMatchObject({ status: "pending", sgpPostedAt: null });
    expect((await repo.list("pending", 10))).toHaveLength(1);
  });

  it("chamado recem-criado que o SGP ainda nao lista tambem fica pendente", async () => {
    const { service, addServiceOrderNote } = build({ notInSgp: true });
    expect((await service.submit(base)).status).toBe("pending");
    expect(addServiceOrderNote).not.toHaveBeenCalled();
  });

  it("um novo envio do mesmo chamado substitui o pendente anterior e o historico fica", async () => {
    const { service, repo } = build({ sgpDown: true });
    await service.submit(base);
    await service.submit({ ...base, latitude: -23.3300 });
    const pending = await repo.list("pending", 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.latitude).toBeCloseTo(-23.33, 4);
    const all = await repo.list(undefined, 10);
    expect(all).toHaveLength(2);
    expect(all.find((item) => item.status === "rejected")?.reviewNote).toContain("Substituido");
  });

  it("recusa coordenada fora do Brasil, 0,0 e lixo", async () => {
    const { service } = build();
    for (const [latitude, longitude] of [[0, 0], [40.7, -74.0], [Number.NaN, -46], [-23, 120]] as const) {
      await expect(service.submit({ ...base, latitude, longitude })).rejects.toMatchObject({ code: "INVALID_LOCATION" });
    }
  });

  it("recusa localizacao imprecisa", async () => {
    const { service } = build();
    await expect(service.submit({ ...base, accuracyMeters: MAX_ACCURACY_METERS + 1 })).rejects.toMatchObject({ code: "LOCATION_TOO_IMPRECISE" });
  });

  it("so aceita para chamado aberto do proprio cliente naquele contrato", async () => {
    await expect(build({ tickets: [] }).service.submit(base)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(build({ tickets: [visit({ contractId: "9999" })] }).service.submit(base)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(build({ tickets: [visit({ statusInterno: "closed" })] }).service.submit(base)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("limita a 5 envios por contrato por dia", async () => {
    const { service } = build();
    for (let i = 0; i < 5; i += 1) await service.submit({ ...base, latitude: -23.3 - i / 1000 });
    await expect(service.submit(base)).rejects.toMatchObject({ code: "LOCATION_LIMIT" });
  });
});

/** Envio que a entrega automatica nao conseguiu gravar (SGP falhou na hora) e ficou pendente. */
async function pendingSubmission(options: Parameters<typeof build>[0] = {}) {
  const ctx = build(options);
  ctx.tickets.listOccurrencesByContract.mockRejectedValueOnce(new Error("SGP fora do ar"));
  const record = await ctx.service.submit(base);
  expect(record.status).toBe("pending");
  ctx.addServiceOrderNote.mockClear();
  return { ...ctx, id: record.id };
}

describe("LocationService.approve / reject (reenvio pelo painel)", () => {
  it("o painel reenvia um pendente: grava o link na OS e na ocorrencia e marca como enviado", async () => {
    const { service, repo, addServiceOrderNote, id } = await pendingSubmission();

    const approved = await service.approve(id, "adm1");

    expect(approved).toMatchObject({ status: "approved", reviewedBy: "adm1" });
    expect(approved.sgpPostedAt).not.toBeNull();
    expect(addServiceOrderNote).toHaveBeenCalledTimes(2);
    expect((await repo.findById(id))?.status).toBe("approved");
  });

  it("se a anotacao da OS falha, nada e marcado como enviado e da para tentar de novo", async () => {
    const { service, repo, id } = await pendingSubmission({ noteFails: "os" });
    await expect(service.approve(id, "adm1")).rejects.toThrow();
    expect((await repo.findById(id))?.status).toBe("pending");
  });

  it("se so o comentario da ocorrencia falha, vale (a OS ja recebeu o link)", async () => {
    const { service, id } = await pendingSubmission({ noteFails: "occurrence" });
    expect((await service.approve(id, "adm1")).status).toBe("approved");
  });

  it("prefere a OS ainda aberta quando ha mais de uma", async () => {
    const { service, addServiceOrderNote, id } = await pendingSubmission({ orders: [{ id: 1, status: "Encerrada" }, { id: 2, status: "Aberta" }] });
    await service.approve(id, "adm1");
    expect(addServiceOrderNote).toHaveBeenCalledWith(expect.objectContaining({ osId: "2" }));
  });

  it("nao analisa duas vezes e recusar nao escreve no SGP", async () => {
    const { service, addServiceOrderNote, id } = await pendingSubmission();
    const rejected = await service.reject(id, "adm1", "ponto errado");
    expect(rejected).toMatchObject({ status: "rejected", reviewNote: "ponto errado" });
    expect(addServiceOrderNote).not.toHaveBeenCalled();
    await expect(service.approve(id, "adm1")).rejects.toMatchObject({ code: "LOCATION_ALREADY_REVIEWED" });
    await expect(service.reject(id, "adm1", null)).rejects.toMatchObject({ code: "LOCATION_ALREADY_REVIEWED" });
  });

  it("um envio ja entregue automaticamente nao pode ser reenviado", async () => {
    const { service } = build();
    const delivered = await service.submit(base);
    await expect(service.approve(delivered.id, "adm1")).rejects.toMatchObject({ code: "LOCATION_ALREADY_REVIEWED" });
  });

  it("o texto da OS traz mapa e rota e nao traz acento nem emoji", () => {
    const text = buildLocationNote({
      id: "x", customerId: "c", contractId: "3005", protocol: "p", latitude: -23.3232, longitude: -46.7284, accuracyMeters: 25.4,
      source: "app", status: "pending", createdAt: "2026-11-03T13:30:00.000Z", reviewedAt: null, reviewedBy: null, reviewNote: null, sgpPostedAt: null
    });
    expect(text).toContain("Mapa: https://www.google.com/maps/search/?api=1&query=-23.323200,-46.728400");
    expect(text).toContain("Rota: https://www.google.com/maps/dir/?api=1&destination=-23.323200,-46.728400");
    expect(text).toContain("precisao de cerca de 25 m");
    expect(text).toMatch(/^[\x20-\x7E\n]+$/);
  });
});
