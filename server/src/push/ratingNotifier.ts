import type { TicketProvider, TicketSummaryWithRaw } from "../integrations/sgp/providers.js";
import type { SgpOccurrenceRaw } from "../integrations/sgp/sgpClient.js";
import type { PublicTicketVisit } from "../types.js";
import { extractTechnicianName, mapSgpOsToCustomerVisit } from "../integrations/sgp/sgpMapper.js";
import type { PushDeviceRepository, PushDeviceRecord } from "../repositories/pushDeviceRepository.js";
import type { TicketRatingRepository } from "../repositories/ticketRatingRepository.js";
import { maskToken, type PushLogger, type PushSendFn } from "./fcmClient.js";
import { todayInSaoPaulo } from "./appointmentNotifier.js";

export const RATING_PUSH_TITLE = "Como foi o seu atendimento?";
export const RATING_PUSH_BODY = "Conte para a gente em 10 segundos. Sua opinião ajuda a melhorar.";

const DAY_MS = 24 * 60 * 60 * 1000;
/** So pede avaliacao de chamado encerrado ate este numero de dias atras (evita cobrar historico antigo). */
export const RATING_CLOSED_WINDOW_DAYS = 3;
/** O pedido some da Central depois disso. */
export const RATING_EXPIRES_DAYS = 14;

export interface RatingNotifierDeps {
  repo: PushDeviceRepository;
  ratings: TicketRatingRepository;
  tickets: Pick<TicketProvider, "listOccurrencesByContract">;
  enabled: boolean;
  send: PushSendFn;
  log?: PushLogger;
  /** Espera entre ver o chamado encerrado e mandar o push (padrao: nenhuma). */
  delayMs?: number;
  maxContractsPerCycle?: number;
  now?: () => Date;
}

export interface RatingCycleSummary {
  skipped?: "disabled" | "overlap";
  contracts: number;
  requested: number;
  sent: number;
  invalidated: number;
}

/** Sem espera: o pedido de avaliacao vale assim que o encerramento e visto (o push usa o mesmo instante). */
const DEFAULT_PUSH_DELAY_MS = 0;

/**
 * Cria o pedido de avaliacao de cada chamado ENCERRADO recentemente (ate RATING_CLOSED_WINDOW_DAYS) do contrato que
 * ainda nao foi visto. Usado pelo ciclo do notificador e pela consulta do proprio app (GET /v1/ratings/pending),
 * para o cartao aparecer logo que o chamado e finalizado. Devolve quantos pedidos novos criou.
 */
export async function recordClosedTickets(
  deps: Pick<RatingNotifierDeps, "ratings" | "tickets">,
  customerId: string,
  contractId: string,
  now: Date,
  delayMs = DEFAULT_PUSH_DELAY_MS
): Promise<number> {
  if (!/^\d+$/.test(contractId)) return 0;
  const oldest = todayInSaoPaulo(new Date(now.getTime() - RATING_CLOSED_WINDOW_DAYS * DAY_MS));
  const occurrences = await deps.tickets.listOccurrencesByContract(contractId);

  // So o ULTIMO chamado encerrado (data de encerramento mais recente; empate: protocolo maior = aberto depois).
  // Os anteriores nunca geram pedido: ninguem avalia uma fila de chamados antigos.
  let latest: { raw: SgpOccurrenceRaw; occurrence: (typeof occurrences)[number]; visit: PublicTicketVisit; closedDate: string } | undefined;
  for (const occurrence of occurrences) {
    const raw = (occurrence as TicketSummaryWithRaw).raw;
    const visit = mapSgpOsToCustomerVisit(raw, occurrence.contractId);
    if (!visit || visit.statusInterno !== "closed") continue;
    const closedDate = visit.updatedAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closedDate) || closedDate < oldest) continue;
    if (!latest || closedDate > latest.closedDate || (closedDate === latest.closedDate && visit.protocol > latest.visit.protocol)) {
      latest = { raw, occurrence, visit, closedDate };
    }
  }
  if (!latest) return 0;

  const isNew = await deps.ratings.createRequest({
    customerId,
    contractId: latest.occurrence.contractId,
    protocol: latest.visit.protocol,
    ticketTitle: latest.visit.title.slice(0, 255),
    technician: extractTechnicianName(latest.raw) ?? null,
    dueAt: new Date(now.getTime() + delayMs),
    now
  });
  const created = isNew ? 1 : 0;
  return created;
}

export class RatingNotifier {
  private running = false;
  private cursor = 0;
  private timer: NodeJS.Timeout | undefined;
  private firstTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: RatingNotifierDeps) {}

  start(intervalMs: number, firstDelayMs = 60_000) {
    if (this.timer) return;
    const tick = () => {
      void this.runCycle().catch((error) => {
        this.deps.log?.warn({ tag: "RATING", error: error instanceof Error ? error.message : "erro" }, "[RATING] ciclo falhou");
      });
    };
    this.firstTimer = setTimeout(tick, firstDelayMs);
    this.firstTimer.unref();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = undefined;
    this.firstTimer = undefined;
  }

  async runCycle(): Promise<RatingCycleSummary> {
    const summary: RatingCycleSummary = { contracts: 0, requested: 0, sent: 0, invalidated: 0 };
    if (!this.deps.enabled) return { ...summary, skipped: "disabled" };
    if (this.running) return { ...summary, skipped: "overlap" };
    this.running = true;
    try {
      const now = (this.deps.now ?? (() => new Date()))();
      const devices = await this.deps.repo.listActiveDevices();
      const devicesByCustomer = new Map<string, PushDeviceRecord[]>();
      for (const device of devices) {
        const list = devicesByCustomer.get(device.customerId) ?? [];
        list.push(device);
        devicesByCustomer.set(device.customerId, list);
      }
      await this.collectClosedTickets(devices, now, summary);
      await this.sendDue(devicesByCustomer, now, summary);
    } catch (error) {
      this.deps.log?.warn({ tag: "RATING", error: error instanceof Error ? error.message : "erro" }, "[RATING] erro no ciclo");
    } finally {
      this.running = false;
    }
    return summary;
  }

  /** Cria o pedido (com espera) para cada chamado encerrado recente que ainda nao foi visto. */
  private async collectClosedTickets(devices: PushDeviceRecord[], now: Date, summary: RatingCycleSummary) {
    const pairs: Array<{ customerId: string; contractId: string }> = [];
    const seen = new Set<string>();
    for (const device of devices) {
      for (const contractId of device.contractIds) {
        if (!/^\d+$/.test(contractId)) continue;
        const key = `${device.customerId}:${contractId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ customerId: device.customerId, contractId });
      }
    }
    if (pairs.length === 0) return;

    pairs.sort((a, b) => (a.customerId + a.contractId < b.customerId + b.contractId ? -1 : 1));
    const take = Math.min(Math.max(1, this.deps.maxContractsPerCycle ?? 150), pairs.length);
    const start = this.cursor % pairs.length;
    this.cursor = (start + take) % pairs.length;

    const delay = this.deps.delayMs ?? DEFAULT_PUSH_DELAY_MS;

    for (let i = 0; i < take; i += 1) {
      const { customerId, contractId } = pairs[(start + i) % pairs.length]!;
      summary.contracts += 1;
      summary.requested += await recordClosedTickets(this.deps, customerId, contractId, now, delay).catch(() => 0);
    }
  }

  private async sendDue(devicesByCustomer: Map<string, PushDeviceRecord[]>, now: Date, summary: RatingCycleSummary) {
    const since = new Date(now.getTime() - RATING_EXPIRES_DAYS * DAY_MS);
    const allDue = await this.deps.ratings.listDueForPush(now, since, 200);
    // Um push por cliente, do chamado mais recente; os outros pedidos pendentes de push ficam sem aviso.
    const newestByCustomer = new Map<string, (typeof allDue)[number]>();
    for (const request of allDue) {
      const current = newestByCustomer.get(request.customerId);
      if (!current || request.createdAt > current.createdAt || (request.createdAt === current.createdAt && request.protocol > current.protocol)) {
        newestByCustomer.set(request.customerId, request);
      }
    }
    const due = [...newestByCustomer.values()];
    for (const request of allDue) {
      if (newestByCustomer.get(request.customerId) !== request) await this.deps.ratings.markPushed(request.customerId, request.protocol, now);
    }
    const dead = new Set<string>();
    for (const request of due) {
      let accepted = false;
      for (const device of devicesByCustomer.get(request.customerId) ?? []) {
        if (dead.has(device.token)) continue;
        let result;
        try {
          result = await this.deps.send({
            token: device.token,
            title: RATING_PUSH_TITLE,
            body: RATING_PUSH_BODY,
            data: { route: "/cliente/chamados", protocol: request.protocol, action: "rate" },
            channelId: "chamados"
          });
        } catch {
          result = "retry" as const;
        }
        if (result === "ok") {
          accepted = true;
          summary.sent += 1;
        } else if (result === "invalid_token") {
          summary.invalidated += 1;
          dead.add(device.token);
          await this.deps.repo.disableToken(device.token, now);
          this.deps.log?.info({ tag: "RATING", token: maskToken(device.token) }, "[RATING] token invalido desativado");
        }
      }
      if (accepted) await this.deps.ratings.markPushed(request.customerId, request.protocol, now);
    }
  }
}
