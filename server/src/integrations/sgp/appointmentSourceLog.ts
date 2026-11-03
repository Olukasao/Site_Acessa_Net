/**
 * Log de onde saiu o horario de cada visita (campo do SGP), para investigar horario errado sem precisar
 * consultar o SGP de novo. So registra quando muda para o protocolo (as listagens se repetem a cada poucos segundos).
 * Sem logger configurado (testes, scripts) nao faz nada.
 */
type Logger = { info: (obj: Record<string, unknown>, msg?: string) => void };

const MAX_TRACKED = 5000;
let logger: Logger | undefined;
const lastByProtocol = new Map<string, string>();

export function setAppointmentSourceLogger(next: Logger | undefined) {
  logger = next;
  lastByProtocol.clear();
}

export function logAppointmentSource(protocol: string, date: string, time: string, source: string) {
  if (!logger) return;
  const key = `${date} ${time || "--:--"} ${source}`;
  if (lastByProtocol.get(protocol) === key) return;
  if (lastByProtocol.size >= MAX_TRACKED) lastByProtocol.clear();
  lastByProtocol.set(protocol, key);
  logger.info({ tag: "AGENDAMENTO", protocol, date, time: time || null, source }, "[AGENDAMENTO] horario da visita lido do SGP");
}
