import { safeError } from "./safe.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Hora (0-23) em America/Sao_Paulo. */
export const saoPauloHour = (now = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(now));

/** "1-6" = das 01h as 06h (vira a meia-noite se o inicio for maior que o fim). Vazio = qualquer hora. */
export function parseWindow(text) {
  const m = String(text ?? "").trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 23 || b > 24) throw new Error(`janela invalida: ${text}`);
  return { from: a, to: b };
}
export function inWindow(win, hour) {
  if (!win) return true;
  return win.from <= win.to ? hour >= win.from && hour < win.to : hour >= win.from || hour < win.to;
}

/**
 * Inventario SO LEITURA: passa devagar pelos contratos da lista, identifica o roteador de cada um (SGP + certificado +
 * pagina de login, sem login e sem tentar senha) e manda o resumo para a Central. Retoma de onde parou (arquivo de progresso).
 */
export async function runInventory({ manager, central, contracts, delayMs = 4000, window = null, progressPath = null, batchSize = 20, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), stop = () => false }) {
  const done = new Set(progressPath && existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, "utf8")).done ?? [] : []);
  const todo = contracts.filter((c) => !done.has(c));
  const stats = { total: todo.length, saved: 0, notFound: 0, failed: 0, byVendor: {} };
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const sent = batch;
    batch = [];
    await central("/api/internal/router-agent/inventory", { agentId: "inventario", entries: sent });
    stats.saved += sent.length;
    for (const e of sent) done.add(e.contractId);
    if (progressPath) writeFileSync(progressPath, JSON.stringify({ done: [...done] }));
  };
  for (const contractId of todo) {
    if (stop()) break;
    while (!inWindow(window, saoPauloHour(now())) && !stop()) {
      await sleep(60_000); // fora da janela de baixo movimento: espera
    }
    try {
      const entry = await manager.inventoryOne(contractId);
      if (!entry) {
        stats.notFound++;
        done.add(contractId);
      } else {
        batch.push(entry);
        const key = [entry.vendor ?? "?", entry.model ?? ""].join(" ").trim();
        stats.byVendor[key] = (stats.byVendor[key] ?? 0) + 1;
      }
    } catch (error) {
      stats.failed++;
      log.warn?.(`[inventario] contrato ${String(contractId).length} digitos: ${error?.code ?? safeError(error, 80)}`);
    }
    if (batch.length >= batchSize) await flush();
    await sleep(delayMs);
  }
  await flush();
  return stats;
}
