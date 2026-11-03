import type { BillingProvider } from "../integrations/sgp/providers.js";
import type { BillingInvoice, ContractSummary } from "../types.js";
import type { PushDeviceRecord, PushDeviceRepository } from "../repositories/pushDeviceRepository.js";
import { maskToken, type PushLogger, type PushSendFn } from "./fcmClient.js";
import { todayInSaoPaulo } from "./appointmentNotifier.js";

export const OVERDUE_TITLE = "Fatura em atraso";
export const OVERDUE_ROUTE = "/cliente/faturas";
export const OVERDUE_CHANNEL = "faturas";
/** Janela silenciosa: so envia das 09:00 (inclusive) as 20:00 (exclusive) em Sao Paulo. */
export const QUIET_WINDOW_START_HOUR = 9;
export const QUIET_WINDOW_END_HOUR = 20;
export const STAGE2_MIN_DAYS_LATE = 5;

const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000;

export function isInsideSendWindow(now: Date) {
  const hour = new Date(now.getTime() - SAO_PAULO_OFFSET_MS).getUTCHours();
  return hour >= QUIET_WINDOW_START_HOUR && hour < QUIET_WINDOW_END_HOUR;
}

function dueIso(invoice: BillingInvoice) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(invoice.dueDate ?? "");
  return match ? match[1]! : null;
}

export function formatDueDate(invoice: BillingInvoice) {
  const iso = dueIso(invoice);
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** daysLate do SGP quando existir; senao calcula pela data de vencimento (dia de Sao Paulo). */
export function daysLateOf(invoice: BillingInvoice, now: Date) {
  if (typeof invoice.daysLate === "number" && Number.isFinite(invoice.daysLate)) return invoice.daysLate;
  const iso = dueIso(invoice);
  if (!iso) return 0;
  const diff = Date.parse(`${todayInSaoPaulo(now)}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`);
  return Math.max(0, Math.floor(diff / 86_400_000));
}

/** Nunca inclui valor em reais: a notificacao aparece na tela bloqueada. */
export function buildOverdueMessage(lead: { invoice: BillingInvoice; stage: 1 | 2; daysLate: number }, count: number) {
  if (count >= 2) {
    return { title: OVERDUE_TITLE, body: `Você tem ${count} faturas vencidas. Toque para ver como pagar.` };
  }
  if (lead.stage === 2) {
    return {
      title: `Fatura vencida há ${lead.daysLate} dias`,
      body: "Para evitar a redução de velocidade, regularize o pagamento. Toque para ver as opções."
    };
  }
  const due = formatDueDate(lead.invoice);
  return {
    title: OVERDUE_TITLE,
    body: due ? `Você tem uma fatura vencida em ${due}. Toque para ver como pagar.` : "Você tem uma fatura vencida. Toque para ver como pagar."
  };
}

export interface OverdueNotifierDeps {
  repo: PushDeviceRepository;
  billing: Pick<BillingProvider, "listInvoices">;
  enabled: boolean;
  send: PushSendFn;
  log?: PushLogger;
  maxContractsPerCycle?: number;
  now?: () => Date;
}

export interface OverdueCycleSummary {
  skipped?: "disabled" | "overlap" | "quiet_hours";
  contracts: number;
  sent: number;
  invalidated: number;
}

export class OverdueNotifier {
  private running = false;
  private cursor = 0;
  private timer: NodeJS.Timeout | undefined;
  private firstTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: OverdueNotifierDeps) {}

  start(intervalMs: number, firstDelayMs = 90_000) {
    if (this.timer) return;
    const tick = () => {
      void this.runCycle().catch((error) => {
        this.deps.log?.warn({ tag: "PUSH", error: error instanceof Error ? error.message : "erro" }, "[PUSH] ciclo de faturas falhou");
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

  async runCycle(): Promise<OverdueCycleSummary> {
    const summary: OverdueCycleSummary = { contracts: 0, sent: 0, invalidated: 0 };
    if (!this.deps.enabled) return { ...summary, skipped: "disabled" };
    if (this.running) return { ...summary, skipped: "overlap" };
    const now = (this.deps.now ?? (() => new Date()))();
    // Fora da janela: adia sem consultar o SGP e sem gravar estado.
    if (!isInsideSendWindow(now)) return { ...summary, skipped: "quiet_hours" };
    this.running = true;
    try {
      await this.cycle(summary, now);
    } catch (error) {
      this.deps.log?.warn({ tag: "PUSH", error: error instanceof Error ? error.message : "erro" }, "[PUSH] erro no ciclo de faturas");
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async cycle(summary: OverdueCycleSummary, now: Date) {
    const { repo, billing } = this.deps;
    const devices = await repo.listActiveDevices();
    const devicesByCustomer = new Map<string, PushDeviceRecord[]>();
    const pairs: Array<{ customerId: string; contractId: string }> = [];
    const seen = new Set<string>();
    for (const device of devices) {
      const list = devicesByCustomer.get(device.customerId) ?? [];
      list.push(device);
      devicesByCustomer.set(device.customerId, list);
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
    const batch = Array.from({ length: take }, (_, i) => pairs[(start + i) % pairs.length]!);
    this.cursor = (start + take) % pairs.length;

    const contractsByCustomer = new Map<string, string[]>();
    for (const { customerId, contractId } of batch) {
      contractsByCustomer.set(customerId, [...(contractsByCustomer.get(customerId) ?? []), contractId]);
    }

    for (const [customerId, contractIds] of contractsByCustomer) {
      const overdue = new Map<string, BillingInvoice>();
      for (const contractId of contractIds) {
        summary.contracts += 1;
        try {
          const contract: ContractSummary = { id: contractId, customerId, addressLine: "", city: "", state: "", planName: "", status: "ACTIVE" };
          const list = await billing.listInvoices(contract);
          if (list.source === "unavailable") continue; // SGP indisponivel: pula o contrato
          for (const invoice of list.invoices) {
            if (invoice.status === "OVERDUE") overdue.set(invoice.id, invoice);
          }
        } catch {
          continue;
        }
      }
      if (overdue.size === 0) continue;

      const stages = await repo.getBillingStages(customerId);
      const due: Array<{ invoice: BillingInvoice; stage: 1 | 2; daysLate: number }> = [];
      for (const invoice of overdue.values()) {
        const current = stages.get(invoice.id);
        const daysLate = daysLateOf(invoice, now);
        if (current === undefined) due.push({ invoice, stage: 1, daysLate });
        else if (current === 1 && daysLate >= STAGE2_MIN_DAYS_LATE) due.push({ invoice, stage: 2, daysLate });
      }
      if (due.length === 0) continue;
      due.sort((a, b) => (dueIso(a.invoice) ?? "9999").localeCompare(dueIso(b.invoice) ?? "9999") || a.invoice.id.localeCompare(b.invoice.id));

      const message = buildOverdueMessage(due[0]!, due.length);
      let accepted = false;
      for (const device of devicesByCustomer.get(customerId) ?? []) {
        let result;
        try {
          result = await this.deps.send({
            token: device.token,
            title: message.title,
            body: message.body,
            data: { route: OVERDUE_ROUTE },
            channelId: OVERDUE_CHANNEL
          });
        } catch {
          result = "retry" as const;
        }
        if (result === "ok") {
          accepted = true;
          summary.sent += 1;
        } else if (result === "invalid_token") {
          summary.invalidated += 1;
          await repo.disableToken(device.token, now);
          this.deps.log?.info({ tag: "PUSH", token: maskToken(device.token) }, "[PUSH] token invalido desativado");
          devicesByCustomer.set(customerId, (devicesByCustomer.get(customerId) ?? []).filter((d) => d.token !== device.token));
        }
      }
      if (accepted) {
        for (const item of due) await repo.saveBillingStage(customerId, item.invoice.id, item.stage, now);
      }
    }
  }
}
