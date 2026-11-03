import type { TicketRatingRecord } from "../repositories/ticketRatingRepository.js";

export const NO_TECHNICIAN_LABEL = "Sem técnico informado";

export interface TechnicianRatingStats {
  technician: string;
  answered: number;
  average: number;
  low: number;
}

export interface RatingsSummary {
  requests: number;
  answered: number;
  /** Respondidos / pedidos, 0..1. */
  responseRate: number;
  average: number | null;
  /** Notas 1 a 5 (indices "1".."5"). */
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
  /** Notas 1 e 2. */
  low: number;
  byTechnician: TechnicianRatingStats[];
}

export interface RatingListItem {
  /** Id do pedido (para o admin apagar). Nao e o id do cliente. */
  id: string;
  protocol: string;
  customerId: string;
  contractId: string;
  ticketTitle: string;
  technician: string;
  rating: number;
  comment: string | null;
  answeredAt: string;
}

export interface RatingsFilters {
  rating?: number | undefined;
  technician?: string | undefined;
  withComment?: boolean | undefined;
}

const round = (value: number) => Math.round(value * 100) / 100;

export function buildRatingsSummary(records: TicketRatingRecord[]): RatingsSummary {
  const distribution = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  const perTechnician = new Map<string, { sum: number; answered: number; low: number }>();
  let sum = 0;
  let answered = 0;

  for (const record of records) {
    if (record.rating === null) continue;
    answered += 1;
    sum += record.rating;
    distribution[String(record.rating) as keyof typeof distribution] += 1;
    const name = record.technician || NO_TECHNICIAN_LABEL;
    const stats = perTechnician.get(name) ?? { sum: 0, answered: 0, low: 0 };
    stats.sum += record.rating;
    stats.answered += 1;
    if (record.rating <= 2) stats.low += 1;
    perTechnician.set(name, stats);
  }

  const byTechnician = [...perTechnician.entries()]
    .map(([technician, stats]) => ({ technician, answered: stats.answered, average: round(stats.sum / stats.answered), low: stats.low }))
    .sort((a, b) => b.answered - a.answered || a.technician.localeCompare(b.technician, "pt-BR"));

  return {
    requests: records.length,
    answered,
    responseRate: records.length ? round(answered / records.length) : 0,
    average: answered ? round(sum / answered) : null,
    distribution,
    low: distribution["1"] + distribution["2"],
    byTechnician
  };
}

export function listRatings(records: TicketRatingRecord[], filters: RatingsFilters, page: number, limit: number) {
  const answered = records
    .filter((record): record is TicketRatingRecord & { rating: number; answeredAt: string } => record.rating !== null && record.answeredAt !== null)
    .filter((record) => (filters.rating ? record.rating === filters.rating : true))
    .filter((record) => (filters.technician ? (record.technician || NO_TECHNICIAN_LABEL) === filters.technician : true))
    .filter((record) => (filters.withComment ? Boolean(record.comment) : true))
    .sort((a, b) => (a.answeredAt < b.answeredAt ? 1 : -1));

  const items: RatingListItem[] = answered.slice((page - 1) * limit, page * limit).map((record) => ({
    id: record.id,
    protocol: record.protocol,
    customerId: record.customerId,
    contractId: record.contractId,
    ticketTitle: record.ticketTitle,
    technician: record.technician || NO_TECHNICIAN_LABEL,
    rating: record.rating,
    comment: record.comment,
    answeredAt: record.answeredAt
  }));

  return { items, total: answered.length, page, limit };
}
