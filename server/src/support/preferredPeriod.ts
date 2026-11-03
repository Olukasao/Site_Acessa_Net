/** Horário preferencial de atendimento escolhido pelo cliente ao abrir o chamado. */
export const preferredPeriods = ["MORNING", "AFTERNOON", "EVENING", "FULL_DAY"] as const;
export type PreferredPeriod = (typeof preferredPeriods)[number];

/** Texto mostrado ao cliente. */
const LABELS: Record<PreferredPeriod, string> = {
  MORNING: "Manhã",
  AFTERNOON: "Tarde",
  EVENING: "Noite",
  FULL_DAY: "Integral"
};

/** Texto que vai no conteúdo do chamado no SGP (ASCII, no mesmo padrão do resto da descrição). */
const SGP_TEXT: Record<PreferredPeriod, string> = {
  MORNING: "Manha",
  AFTERNOON: "Tarde",
  EVENING: "Noite",
  FULL_DAY: "Integral (qualquer horario)"
};

const LINE_PREFIX = "Horario preferencial de atendimento:";

export function preferredPeriodLabel(period: PreferredPeriod): string {
  return LABELS[period];
}

/** Põe a linha logo depois de "Contato: ..." (ou no fim, se a descrição não tiver essa linha). */
export function addPreferredPeriodLine(description: string, period: PreferredPeriod): string {
  const line = `${LINE_PREFIX} ${SGP_TEXT[period]}`;
  if (/^Contato:.*$/m.test(description)) {
    return description.replace(/^(Contato:.*)$/m, `$1\n${line}`);
  }
  return `${description}\n${line}`;
}

const OBSERVATION_PREFIX = "Observacao do cliente:";
export const OBSERVATION_MAX_LENGTH = 300;

/** Texto livre do cliente numa linha só (sem quebras que forjem outras linhas do chamado), sem caracteres de controle, ate 300 caracteres. */
export function cleanObservation(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OBSERVATION_MAX_LENGTH);
}

/** Põe "Observacao do cliente: ..." logo depois do horário preferencial (ou de "Contato:", ou no fim). Texto vazio não muda nada. */
export function addObservationLine(description: string, observation: string | undefined): string {
  const text = cleanObservation(observation);
  if (!text) return description;
  const line = `${OBSERVATION_PREFIX} ${text}`;
  for (const anchor of [/^Hor[aá]rio preferencial de atendimento:.*$/im, /^Contato:.*$/m]) {
    if (anchor.test(description)) return description.replace(anchor, (found) => `${found}\n${line}`);
  }
  return `${description}\n${line}`;
}

/** Lê o horário preferencial de volta do conteúdo do chamado (chamados do SGP, inclusive os abertos pela equipe com a mesma linha). */
export function parsePreferredPeriodLabel(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const match = content.match(/Hor[aá]rio preferencial de atendimento:\s*([A-Za-zÀ-ÿ]+)/i);
  if (!match?.[1]) return undefined;
  const word = match[1].toLowerCase();
  if (word.startsWith("manh")) return LABELS.MORNING;
  if (word === "tarde") return LABELS.AFTERNOON;
  if (word === "noite") return LABELS.EVENING;
  if (word === "integral") return LABELS.FULL_DAY;
  return undefined;
}

/**
 * Turno da visita, sempre a partir da hora que a equipe agendou no SGP (nunca da preferência do cliente):
 * antes de 12:00 Manhã, até 17:59 Tarde, depois Noite. "00:00" ou vazio = hora não informada.
 */
export function shiftFromTime(time: string | null | undefined): "Manhã" | "Tarde" | "Noite" | undefined {
  const match = /^(\d{2}):(\d{2})/.exec(time ?? "");
  if (!match || (match[1] === "00" && match[2] === "00")) return undefined;
  const hour = Number(match[1]);
  if (hour < 12) return "Manhã";
  if (hour < 18) return "Tarde";
  return "Noite";
}
