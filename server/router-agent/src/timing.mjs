import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tempos por etapa de um pedido (performance.now()). So nomes de etapa e milissegundos: nunca senha, token, IP ou credencial.
 * Cada pedido roda dentro de um `timingsStore.run(...)`; qualquer codigo chamado por ele registra etapas com `timed()`.
 */
export const timingsStore = new AsyncLocalStorage();

export function newTimings() {
  return { t0: performance.now(), steps: new Map() };
}

export async function timed(name, fn) {
  const store = timingsStore.getStore();
  if (!store) return fn();
  const t = performance.now();
  try {
    return await fn();
  } finally {
    store.steps.set(name, (store.steps.get(name) ?? 0) + (performance.now() - t));
  }
}

export function summarizeTimings(store) {
  return {
    totalMs: Math.round(performance.now() - store.t0),
    steps: Object.fromEntries([...store.steps].map(([name, ms]) => [name, Math.round(ms)]))
  };
}
