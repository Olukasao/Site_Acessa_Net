import { AppError } from "../errors.js";
import { normalizeBrazilianPhone } from "../auth/cpf.js";
import type { AppConfig } from "../config.js";
import type { SgpUraClient } from "../integrations/sgp/sgpClient.js";
import type { InMemoryStore } from "../repositories/inMemoryStore.js";
import { OwnershipService } from "../security/ownership.js";

export const DOCUMENT_MAX_FILES = 5;
export const DOCUMENT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_DESCRIPTION_MAX_LENGTH = 500;

interface DocumentKind {
  contentType: string;
  /** Assinatura (primeiros bytes) do formato -- o nome/tipo informado pelo cliente nao basta. */
  matches: (data: Buffer) => boolean;
}

const startsWith = (data: Buffer, bytes: number[]) => bytes.every((byte, index) => data[index] === byte);

const DOCUMENT_KINDS: Record<string, DocumentKind> = {
  pdf: { contentType: "application/pdf", matches: (data) => startsWith(data, [0x25, 0x50, 0x44, 0x46]) },
  jpg: { contentType: "image/jpeg", matches: (data) => startsWith(data, [0xff, 0xd8, 0xff]) },
  jpeg: { contentType: "image/jpeg", matches: (data) => startsWith(data, [0xff, 0xd8, 0xff]) },
  png: { contentType: "image/png", matches: (data) => startsWith(data, [0x89, 0x50, 0x4e, 0x47]) }
};

export interface DocumentUploadInput {
  customerId: string;
  contractId: string;
  contactPhone: string;
  description?: string | undefined;
  files: Array<{ name: string; contentBase64: string }>;
}

export interface DocumentUploadResult {
  protocol: string;
  sent: number;
  failed: string[];
}

function safeFilename(name: string, extension: string) {
  const base = name
    .replace(/\.[^.]*$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 60);
  return `${base || "documento"}.${extension}`;
}

/**
 * Chamado "Anexar documentos": cria a ocorrencia do tipo ANEXAR DOCUMENTO no SGP (setor Financeiro) e anexa cada
 * arquivo na aba "Anexos" dela (/api/ura/ocorrencia/{id}/anexo/add/). Fica fora do fluxo de triagem/diagnostico.
 */
export class DocumentsService {
  private readonly ownership: OwnershipService;
  /** Guarda contra duplo-clique: dois envios simultaneos criariam dois chamados (mesmo racional do SupportService). */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: InMemoryStore,
    private readonly sgpClient: SgpUraClient,
    private readonly chamadoConfig: AppConfig["sgp"]["chamado"]
  ) {
    this.ownership = new OwnershipService(store, sgpClient);
  }

  async submit(input: DocumentUploadInput): Promise<DocumentUploadResult> {
    const contract = await this.ownership.assertContract(input.customerId, input.contractId);

    if (!/^\d+$/.test(contract.id)) {
      throw new AppError(422, "DOCUMENTS_UNAVAILABLE", "Nao foi possivel enviar documentos para este contrato.");
    }

    const contactPhone = normalizeBrazilianPhone(input.contactPhone);
    if (!contactPhone) {
      throw new AppError(422, "INVALID_CONTACT_PHONE", "Informe um telefone brasileiro valido para contato.");
    }

    if (input.files.length < 1 || input.files.length > DOCUMENT_MAX_FILES) {
      throw new AppError(422, "INVALID_DOCUMENT_COUNT", `Envie de 1 a ${DOCUMENT_MAX_FILES} arquivos.`);
    }

    const files = input.files.map((file) => {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      const kind = DOCUMENT_KINDS[extension];
      const data = Buffer.from(file.contentBase64, "base64");
      if (!kind || data.length === 0 || !kind.matches(data)) {
        throw new AppError(422, "INVALID_DOCUMENT_TYPE", "Envie apenas arquivos PDF, JPG ou PNG validos.");
      }
      if (data.length > DOCUMENT_MAX_FILE_BYTES) {
        throw new AppError(422, "DOCUMENT_TOO_LARGE", "Cada arquivo pode ter no maximo 8 MB.");
      }
      return { originalName: file.name, filename: safeFilename(file.name, extension), contentType: kind.contentType, data };
    });

    const guardKey = `${input.customerId}:${input.contractId}`;
    if (this.inFlight.has(guardKey)) {
      throw new AppError(409, "DUPLICATE_DOCUMENTS_IN_PROGRESS", "Ja existe um envio de documentos em andamento.");
    }
    this.inFlight.add(guardKey);

    try {
      const customerName = this.store.getCustomer(input.customerId)?.name;
      const note = input.description?.trim();
      const content = [
        "ANEXAR DOCUMENTO - enviado pela Central do Assinante",
        customerName ? `Cliente: ${customerName}` : undefined,
        `Contato: ${contactPhone}`,
        `Arquivos: ${files.map((file) => file.filename).join(", ")}`,
        note ? `Observacao do cliente: ${note}` : undefined
      ]
        .filter(Boolean)
        .join("\n");

      const documents = this.chamadoConfig.documents;
      const chamado = await this.sgpClient.createCentralChamado({
        contrato: contract.id,
        conteudo: content,
        contato: customerName,
        contatoNumero: contactPhone,
        ocorrenciaTipo: documents.ocorrenciaTipo,
        motivoOs: documents.motivoOs,
        semOs: this.chamadoConfig.semOs,
        setor: documents.setor
      });

      const failed: string[] = [];
      for (const file of files) {
        try {
          await this.sgpClient.addOccurrenceAttachment({
            occurrenceId: chamado.occurrenceId,
            filename: file.filename,
            contentType: file.contentType,
            data: file.data
          });
        } catch {
          failed.push(file.originalName);
        }
      }

      this.store.recordAudit({
        type: "TICKET_CREATED",
        customerId: input.customerId,
        metadata: { contractId: contract.id, documents: true, files: files.length, failed: failed.length }
      });

      return { protocol: chamado.protocol || chamado.occurrenceId, sent: files.length - failed.length, failed };
    } finally {
      this.inFlight.delete(guardKey);
    }
  }
}
