import { describe, expect, it, vi } from "vitest";
import { DocumentsService } from "../src/support/documentsService.js";
import type { SgpUraClient } from "../src/integrations/sgp/sgpClient.js";
import type { InMemoryStore } from "../src/repositories/inMemoryStore.js";

const chamadoConfig = {
  app: "noc",
  token: "t",
  timeoutMs: 1000,
  semOs: undefined,
  mapping: {},
  documents: { ocorrenciaTipo: "10013", motivoOs: "2125", setor: "3" }
};

const pdf = Buffer.from("%PDF-1.4 teste").toString("base64");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

function build(overrides: { attach?: ReturnType<typeof vi.fn> } = {}) {
  const createCentralChamado = vi.fn().mockResolvedValue({ sgpTicketId: "840", osId: "", occurrenceId: "840", protocol: "200429142914", rawStatus: "aberto", raw: {} });
  const addOccurrenceAttachment = overrides.attach ?? vi.fn().mockResolvedValue(undefined);
  const client = { createCentralChamado, addOccurrenceAttachment } as unknown as SgpUraClient;
  const store = {
    getCustomer: () => ({ name: "Fulano" }),
    recordAudit: vi.fn(),
    getContract: () => ({ id: "5989", customerId: "c1" })
  } as unknown as InMemoryStore;
  const service = new DocumentsService(store, client, chamadoConfig);
  // O vinculo contrato->cliente tem teste proprio (OwnershipService); aqui so interessa o fluxo do SGP.
  (service as unknown as { ownership: unknown }).ownership = {
    assertContract: vi.fn().mockResolvedValue({ id: "5989", customerId: "c1" })
  };
  return { service, createCentralChamado, addOccurrenceAttachment };
}

const base = { customerId: "c1", contractId: "5989", contactPhone: "(11) 91234-5678" };

describe("DocumentsService.submit", () => {
  it("cria o chamado ANEXAR DOCUMENTO (tipo, motivo e setor da config) e anexa cada arquivo na ocorrencia", async () => {
    const { service, createCentralChamado, addOccurrenceAttachment } = build();
    const result = await service.submit({
      ...base,
      description: "RG e comprovante",
      files: [{ name: "Comprovante março.pdf", contentBase64: pdf }, { name: "rg.PNG", contentBase64: png }]
    });

    expect(createCentralChamado).toHaveBeenCalledWith(
      expect.objectContaining({ contrato: "5989", ocorrenciaTipo: "10013", motivoOs: "2125", setor: "3" })
    );
    expect(addOccurrenceAttachment).toHaveBeenCalledTimes(2);
    expect(addOccurrenceAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceId: "840", filename: "Comprovante_marco.pdf", contentType: "application/pdf" })
    );
    expect(result).toEqual({ protocol: "200429142914", sent: 2, failed: [] });
  });

  it("informa o arquivo que falhou sem perder o chamado ja criado", async () => {
    const attach = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("sgp"));
    const { service } = build({ attach });
    const result = await service.submit({
      ...base,
      files: [{ name: "a.pdf", contentBase64: pdf }, { name: "b.pdf", contentBase64: pdf }]
    });
    expect(result).toEqual({ protocol: "200429142914", sent: 1, failed: ["b.pdf"] });
  });

  it("recusa arquivo cujo conteudo nao bate com a extensao e nao cria chamado", async () => {
    const { service, createCentralChamado } = build();
    await expect(
      service.submit({ ...base, files: [{ name: "virus.pdf", contentBase64: Buffer.from("MZ executavel").toString("base64") }] })
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT_TYPE" });
    await expect(service.submit({ ...base, files: [{ name: "x.exe", contentBase64: pdf }] })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT_TYPE"
    });
    expect(createCentralChamado).not.toHaveBeenCalled();
  });

  it("recusa telefone invalido e arquivo acima de 8 MB", async () => {
    const { service } = build();
    await expect(
      service.submit({ ...base, contactPhone: "123", files: [{ name: "a.pdf", contentBase64: pdf }] })
    ).rejects.toMatchObject({ code: "INVALID_CONTACT_PHONE" });
    const big = Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(8 * 1024 * 1024)]).toString("base64");
    await expect(service.submit({ ...base, files: [{ name: "grande.pdf", contentBase64: big }] })).rejects.toMatchObject({
      code: "DOCUMENT_TOO_LARGE"
    });
  });
});
