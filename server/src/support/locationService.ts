import { AppError } from "../errors.js";
import type { SgpUraClient } from "../integrations/sgp/sgpClient.js";
import type { TicketProvider, TicketSummaryWithRaw } from "../integrations/sgp/providers.js";
import { normalizeChamadoStatus } from "../integrations/sgp/statusMapper.js";
import type { InMemoryStore } from "../repositories/inMemoryStore.js";
import type { LocationRequestRecord, LocationRequestRepository, LocationSource } from "../repositories/locationRequestRepository.js";
import { OwnershipService } from "../security/ownership.js";
import type { PublicTicketVisit } from "../types.js";

/** Caixa do Brasil: descarta coordenada de outro pais, 0,0 e lixo. */
const BRAZIL = { minLat: -34, maxLat: 6, minLng: -74, maxLng: -28 };
/** Acima disso o ponto nao serve para achar uma casa (o aparelho so soube a regiao). */
export const MAX_ACCURACY_METERS = 200;
const MAX_SUBMISSIONS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubmitLocationInput {
  customerId: string;
  contractId: string;
  protocol: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number | undefined;
  source: LocationSource;
}

export function googleMapsUrl(latitude: number, longitude: number) {
  return `https://www.google.com/maps/search/?api=1&query=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

function googleRouteUrl(latitude: number, longitude: number) {
  return `https://www.google.com/maps/dir/?api=1&destination=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

/** Texto que o tecnico le na OS/ocorrencia do SGP (sem emoji nem acento: o SGP e o terminal dele nem sempre mostram direito). */
export function buildLocationNote(record: LocationRequestRecord) {
  const when = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(
    new Date(record.createdAt)
  );
  const accuracy = record.accuracyMeters === null ? "" : `, precisao de cerca de ${Math.round(record.accuracyMeters)} m`;
  return [
    `LOCALIZACAO DA CASA confirmada pelo cliente (${record.source === "app" ? "app" : "site"}, ${when}${accuracy}).`,
    `Mapa: ${googleMapsUrl(record.latitude, record.longitude)}`,
    `Rota: ${googleRouteUrl(record.latitude, record.longitude)}`
  ].join("\n");
}

/** Quem entregou o ponto ao SGP quando foi automatico (nao ha admin). */
export const AUTO_REVIEWER = "auto";

/**
 * O cliente envia onde fica a casa para a visita e o link do mapa vai SOZINHO para o chamado no SGP (anotacao da OS +
 * comentario da ocorrencia; sem OS, um anexo de texto na aba Anexos). Se o SGP falhar ou o chamado ainda nao aparecer la,
 * o envio fica pendente e a equipe reenvia pelo painel ("Enviar ao chamado"). O cliente ja confirma o ponto na tela.
 */
export class LocationService {
  private readonly ownership: OwnershipService;

  constructor(
    private readonly repo: LocationRequestRepository,
    store: InMemoryStore,
    private readonly sgpClient: SgpUraClient,
    private readonly tickets: TicketProvider,
    private readonly listCustomerTickets: (customerId: string) => Promise<PublicTicketVisit[]>
  ) {
    this.ownership = new OwnershipService(store, sgpClient);
  }

  async submit(input: SubmitLocationInput): Promise<LocationRequestRecord> {
    const { latitude, longitude } = input;
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < BRAZIL.minLat ||
      latitude > BRAZIL.maxLat ||
      longitude < BRAZIL.minLng ||
      longitude > BRAZIL.maxLng
    ) {
      throw new AppError(422, "INVALID_LOCATION", "Nao foi possivel usar essa localizacao. Tente de novo.");
    }
    if (input.accuracyMeters !== undefined && input.accuracyMeters > MAX_ACCURACY_METERS) {
      throw new AppError(
        422,
        "LOCATION_TOO_IMPRECISE",
        "A localizacao esta imprecisa. Va para perto de uma janela ou area aberta e tente de novo."
      );
    }

    await this.ownership.assertContract(input.customerId, input.contractId);

    // So para chamado aberto desse cliente, nesse contrato: o protocolo vem do navegador e nao e confiavel.
    const customerTickets = await this.listCustomerTickets(input.customerId);
    const ticket = customerTickets.find((item) => item.protocol === input.protocol && item.contractId === input.contractId);
    if (!ticket || ticket.statusInterno === "closed") {
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Chamado nao encontrado.");
    }

    const recent = await this.repo.countRecent(input.customerId, input.contractId, new Date(Date.now() - DAY_MS));
    if (recent >= MAX_SUBMISSIONS_PER_DAY) {
      throw new AppError(429, "LOCATION_LIMIT", "Voce ja enviou a localizacao varias vezes hoje. Tente novamente amanha.");
    }

    const record = await this.repo.create({
      customerId: input.customerId,
      contractId: input.contractId,
      protocol: input.protocol,
      latitude: Number(latitude.toFixed(7)),
      longitude: Number(longitude.toFixed(7)),
      accuracyMeters: input.accuracyMeters ?? null,
      source: input.source
    });

    // Entrega ao chamado na hora. Falha aqui nao desfaz o envio: fica pendente para reenvio pelo painel.
    try {
      return await this.deliver(record, AUTO_REVIEWER);
    } catch {
      return record;
    }
  }

  /** Estado do ultimo envio, para a tela mostrar "aguardando analise" / "confirmada" sem expor coordenadas de outros. */
  async statusFor(customerId: string, contractId: string, protocol: string) {
    await this.ownership.assertContract(customerId, contractId);
    const record = await this.repo.latestFor(customerId, contractId, protocol);
    return record ? { status: record.status, sentAt: record.createdAt, reviewNote: record.status === "rejected" ? record.reviewNote : null } : null;
  }

  /** Reenvio manual pelo painel: grava o link no chamado de um envio que ficou pendente. */
  async approve(id: string, adminId: string): Promise<LocationRequestRecord> {
    const record = await this.repo.findById(id);
    if (!record) throw new AppError(404, "LOCATION_NOT_FOUND", "Localizacao nao encontrada.");
    if (record.status !== "pending") throw new AppError(409, "LOCATION_ALREADY_REVIEWED", "Essa localizacao ja foi analisada.");
    return this.deliver(record, adminId);
  }

  /**
   * Grava o link do mapa no chamado: anotacao da OS (a que o tecnico le) e comentario da ocorrencia; chamado sem OS recebe
   * o link como anexo de texto na aba Anexos da ocorrencia. Se nada for gravado, o envio segue pendente.
   */
  private async deliver(record: LocationRequestRecord, reviewer: string): Promise<LocationRequestRecord> {
    const target = await this.findTicketTarget(record);
    if (!target) {
      throw new AppError(404, "LOCATION_TICKET_NOT_IN_SGP", "O chamado ainda nao aparece no SGP.");
    }

    const text = buildLocationNote(record);
    if (target.osId) {
      // A anotacao da OS e a que o tecnico le: se ela falhar, nada foi gravado e o envio segue pendente.
      await this.sgpClient.addServiceOrderNote({ osId: target.osId, text, target: "os" });
      // O comentario na ocorrencia e um segundo lugar para a equipe ver; uma falha nele nao desfaz a anotacao.
      await this.sgpClient.addServiceOrderNote({ osId: target.osId, text, target: "occurrence" }).catch(() => undefined);
    } else if (target.occurrenceId) {
      await this.sgpClient.addOccurrenceAttachment({
        occurrenceId: target.occurrenceId,
        filename: "localizacao-da-casa.txt",
        contentType: "text/plain",
        data: Buffer.from(text, "utf8")
      });
    } else {
      throw new AppError(422, "LOCATION_NO_TARGET", "Nao foi possivel identificar onde gravar a localizacao no SGP.");
    }

    const now = new Date();
    if (!(await this.repo.review(record.id, "approved", reviewer, null, now))) {
      throw new AppError(409, "LOCATION_ALREADY_REVIEWED", "Essa localizacao ja foi analisada.");
    }
    await this.repo.markSgpPosted(record.id, now);
    return (await this.repo.findById(record.id))!;
  }

  async reject(id: string, adminId: string, note: string | null): Promise<LocationRequestRecord> {
    const record = await this.repo.findById(id);
    if (!record) throw new AppError(404, "LOCATION_NOT_FOUND", "Localizacao nao encontrada.");
    if (!(await this.repo.review(id, "rejected", adminId, note, new Date()))) {
      throw new AppError(409, "LOCATION_ALREADY_REVIEWED", "Essa localizacao ja foi analisada.");
    }
    return (await this.repo.findById(id))!;
  }

  /** OS da visita (a primeira ainda aberta; se todas encerradas, a primeira) e id da ocorrencia, ambos como o SGP os conhece. */
  private async findTicketTarget(record: LocationRequestRecord): Promise<{ osId: string | null; occurrenceId: string | null } | null> {
    let occurrences: TicketSummaryWithRaw[];
    try {
      occurrences = (await this.tickets.listOccurrencesByContract(record.contractId)) as TicketSummaryWithRaw[];
    } catch {
      throw new AppError(502, "SGP_REQUEST_FAILED", "Nao foi possivel consultar o SGP agora.");
    }
    const occurrence = occurrences.find((item) => item.protocol === record.protocol);
    if (!occurrence) return null;

    const raw = occurrence.raw as Record<string, unknown> | undefined;
    const rawId = raw?.id;
    const occurrenceId = typeof rawId === "number" || typeof rawId === "string" ? String(rawId) : null;

    const orders = raw?.ordens_servicos;
    let osId: string | null = null;
    if (Array.isArray(orders) && orders.length > 0) {
      const list = orders as Array<Record<string, unknown>>;
      const open = list.find((order) => normalizeChamadoStatus(String(order.status ?? "")).status !== "closed");
      const id = (open ?? list[0])?.id;
      osId = typeof id === "number" || typeof id === "string" ? String(id) : null;
    }
    return { osId, occurrenceId };
  }
}
