import type { TicketProvider, TicketSummaryWithRaw } from "../integrations/sgp/providers.js";
import { mapSgpOsToCustomerVisit } from "../integrations/sgp/sgpMapper.js";
import type { PushDeviceRepository, PushDeviceRecord } from "../repositories/pushDeviceRepository.js";
import { maskToken, type PushLogger, type PushSendFn } from "./fcmClient.js";
import { shiftFromTime } from "../support/preferredPeriod.js";

export const PUSH_TITLE = "Visita técnica agendada";

const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000;

/** "AAAA-MM-DD" de hoje no fuso America/Sao_Paulo (sem horario de verao desde 2019). */
export function todayInSaoPaulo(now: Date) {
  return new Date(now.getTime() - SAO_PAULO_OFFSET_MS).toISOString().slice(0, 10);
}

function formatDateBr(isoDate: string) {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

/** Mesma regra da tela: o turno sai da hora agendada no SGP ("Manhã"/"Tarde"/"Noite"); sem hora, só a data. */
export function buildAppointmentBody(date: string, time: string | null, rescheduled: boolean) {
  const shift = shiftFromTime(time);
  const when = shift ? `${formatDateBr(date)}, turno da ${shift.toLowerCase()}` : formatDateBr(date);
  return rescheduled ? `O horário da visita mudou: ${when}.` : `Seu atendimento foi agendado para ${when}.`;
}

export interface AppointmentNotifierDeps {
  repo: PushDeviceRepository;
  tickets: Pick<TicketProvider, "listOccurrencesByContract">;
  /** FCM ligado? Desligado => o ciclo nao faz nada (nem consulta o SGP). */
  enabled: boolean;
  send: PushSendFn;
  log?: PushLogger;
  maxContractsPerCycle?: number;
  now?: () => Date;
}

export interface CycleSummary {
  skipped?: "disabled" | "overlap";
  contracts: number;
  sent: number;
  invalidated: number;
}

export class AppointmentNotifier {
  private running = false;
  private cursor = 0;
  private timer: NodeJS.Timeout | undefined;
  private firstTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AppointmentNotifierDeps) {}

  /** Inicia o intervalo. Nunca lanca; cada ciclo tem try/catch total. */
  start(intervalMs: number, firstDelayMs = 30_000) {
    if (this.timer) return;
    const tick = () => {
      void this.runCycle().catch((error) => {
        this.deps.log?.warn({ tag: "PUSH", error: error instanceof Error ? error.message : "erro" }, "[PUSH] ciclo falhou");
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

  async runCycle(): Promise<CycleSummary> {
    const summary: CycleSummary = { contracts: 0, sent: 0, invalidated: 0 };
    if (!this.deps.enabled) return { ...summary, skipped: "disabled" };
    if (this.running) return { ...summary, skipped: "overlap" };
    this.running = true;
    try {
      await this.cycle(summary);
    } catch (error) {
      this.deps.log?.warn({ tag: "PUSH", error: error instanceof Error ? error.message : "erro" }, "[PUSH] erro no ciclo");
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async cycle(summary: CycleSummary) {
    const { repo, tickets } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();
    const today = todayInSaoPaulo(now);
    const devices = await repo.listActiveDevices();

    const devicesByCustomer = new Map<string, PushDeviceRecord[]>();
    const pairs: Array<{ customerId: string; contractId: string }> = [];
    const seenPairs = new Set<string>();
    for (const device of devices) {
      const list = devicesByCustomer.get(device.customerId) ?? [];
      list.push(device);
      devicesByCustomer.set(device.customerId, list);
      for (const contractId of device.contractIds) {
        if (!/^\d+$/.test(contractId)) continue;
        const key = `${device.customerId}:${contractId}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        pairs.push({ customerId: device.customerId, contractId });
      }
    }
    if (pairs.length === 0) return;

    pairs.sort((a, b) => (a.customerId + a.contractId < b.customerId + b.contractId ? -1 : 1));
    const max = Math.max(1, this.deps.maxContractsPerCycle ?? 150);
    const take = Math.min(max, pairs.length);
    const start = this.cursor % pairs.length;
    const batch = Array.from({ length: take }, (_, i) => pairs[(start + i) % pairs.length]!);
    this.cursor = (start + take) % pairs.length;

    const handled = new Set<string>();
    const dead = new Set<string>();
    for (const { customerId, contractId } of batch) {
      summary.contracts += 1;
      let occurrences: Awaited<ReturnType<TicketProvider["listOccurrencesByContract"]>>;
      try {
        occurrences = await tickets.listOccurrencesByContract(contractId);
      } catch {
        // SGP_BUSY / SGP_CIRCUIT_OPEN / erro: pula este contrato, tenta no proximo ciclo.
        continue;
      }
      for (const occurrence of occurrences) {
        const visit = mapSgpOsToCustomerVisit((occurrence as TicketSummaryWithRaw).raw, occurrence.contractId);
        if (!visit || visit.statusInterno === "closed") continue;
        const date = visit.appointment?.date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) continue;
        const handledKey = `${customerId}:${visit.protocol}`;
        if (handled.has(handledKey)) continue;
        handled.add(handledKey);

        const rawTime = visit.appointment?.windowStart ?? "";
        const time = /^\d{2}:\d{2}/.test(rawTime) ? rawTime.slice(0, 5) : null;
        // O cliente ve o turno (Manha/Tarde/Noite), entao mudar a hora dentro do mesmo turno nao gera aviso.
        // Chave "P:periodo da manha" igual a das versoes anteriores, para nao reenviar aviso de quem ja recebeu.
        const shift = shiftFromTime(time);
        const key = shift ? `${date} P:período da ${shift.toLowerCase()}` : `${date} 00:00`;
        const previous = await repo.getAppointmentState(customerId, visit.protocol);
        if (previous?.appointmentKey === key) continue;
        // Mesmo dia e agora sem hora: o cliente nao veria um horario novo; so atualiza o estado, sem push.
        if (!shift && previous?.appointmentKey.startsWith(`${date} `)) {
          await repo.saveAppointmentState(customerId, visit.protocol, key, now);
          continue;
        }

        const body = buildAppointmentBody(date, time, Boolean(previous));
        let accepted = false;
        for (const device of devicesByCustomer.get(customerId) ?? []) {
          if (dead.has(device.token)) continue;
          let result;
          try {
            result = await this.deps.send({ token: device.token, title: PUSH_TITLE, body,
              data: { route: "/cliente/chamados", protocol: visit.protocol },
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
            await repo.disableToken(device.token, now);
            this.deps.log?.info({ tag: "PUSH", token: maskToken(device.token) }, "[PUSH] token invalido desativado");
          }
        }
        if (accepted) await repo.saveAppointmentState(customerId, visit.protocol, key, now);
      }
    }
  }
}
