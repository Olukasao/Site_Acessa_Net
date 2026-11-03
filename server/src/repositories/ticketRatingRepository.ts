import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "mysql2/promise";

export interface TicketRatingRecord {
  id: string;
  customerId: string;
  contractId: string;
  protocol: string;
  ticketTitle: string;
  /** Tecnico responsavel da OS no SGP; null quando o SGP nao informou. */
  technician: string | null;
  /** Quando o pedido de avaliacao pode ser mostrado/enviado (encerramento visto + atraso). */
  dueAt: string;
  pushedAt: string | null;
  answeredAt: string | null;
  rating: number | null;
  comment: string | null;
  createdAt: string;
}

export interface CreateRatingRequestInput {
  customerId: string;
  contractId: string;
  protocol: string;
  ticketTitle: string;
  technician?: string | null | undefined;
  dueAt: Date;
  now?: Date;
}

export interface TicketRatingRepository {
  /** Idempotente por (cliente, protocolo). Devolve true so quando criou. */
  createRequest(input: CreateRatingRequestInput): Promise<boolean>;
  /** No maximo UM pedido: o mais recente do cliente, se ainda sem resposta (nunca uma fila de chamados antigos). dueAt so agenda o push. */
  listPending(customerId: string, now: Date, since: Date): Promise<TicketRatingRecord[]>;
  /** Pedidos liberados que ainda nao receberam push. */
  listDueForPush(now: Date, since: Date, limit: number): Promise<TicketRatingRecord[]>;
  markPushed(customerId: string, protocol: string, now?: Date): Promise<void>;
  /** Grava a resposta so se ainda nao houver uma. Devolve false se nao existe pedido pendente. */
  submit(customerId: string, protocol: string, rating: number, comment: string | null, now: Date): Promise<boolean>;
  /** Pedidos criados no periodo (respondidos ou nao), do mais novo para o mais antigo. */
  listInRange(from: Date, to: Date, limit: number): Promise<TicketRatingRecord[]>;
  /** Pedido de avaliação de um protocolo (chamados abertos fora da Central não têm registro de atividade). */
  findByProtocol(protocol: string): Promise<TicketRatingRecord | null>;
  findById(id: string): Promise<TicketRatingRecord | null>;
  /** Apaga um pedido (respondido ou não). Devolve false se não existe. Uso: limpar avaliações de teste pelo painel. */
  deleteById(id: string): Promise<boolean>;
  /** Apaga todos os pedidos de um contrato (respondidos ou pendentes) e devolve quantos eram. */
  deleteByContract(contractId: string): Promise<number>;
}

interface RatingRow {
  id: string;
  customer_id: string;
  contract_id: string;
  protocol: string;
  ticket_title: string;
  technician: string | null;
  due_at: string;
  pushed_at: string | null;
  answered_at: string | null;
  rating: number | null;
  comment: string | null;
  created_at: string;
}

const COLUMNS =
  "id, customer_id, contract_id, protocol, ticket_title, technician, due_at, pushed_at, answered_at, rating, comment, created_at";

function mapRow(row: RatingRow): TicketRatingRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    contractId: row.contract_id,
    protocol: row.protocol,
    ticketTitle: row.ticket_title,
    technician: row.technician,
    dueAt: row.due_at,
    pushedAt: row.pushed_at,
    answeredAt: row.answered_at,
    rating: row.rating === null ? null : Number(row.rating),
    comment: row.comment,
    createdAt: row.created_at
  };
}

export class SqliteTicketRatingRepository implements TicketRatingRepository {
  constructor(private readonly db: DatabaseSync) {}

  async createRequest(input: CreateRatingRequestInput): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO ticket_ratings (id, customer_id, contract_id, protocol, ticket_title, technician, due_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.customerId,
        input.contractId,
        input.protocol,
        input.ticketTitle,
        input.technician ?? null,
        input.dueAt.toISOString(),
        (input.now ?? new Date()).toISOString()
      );
    return Number(result.changes) > 0;
  }

  async listPending(customerId: string, now: Date, since: Date): Promise<TicketRatingRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM ticket_ratings AS t
         WHERE t.customer_id = ? AND t.rating IS NULL AND t.created_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM ticket_ratings AS newer WHERE newer.customer_id = t.customer_id
               AND (newer.created_at > t.created_at OR (newer.created_at = t.created_at AND newer.protocol > t.protocol))
           )
         ORDER BY t.created_at DESC LIMIT 1`
      )
      .all(customerId, since.toISOString()) as unknown as RatingRow[];
    return rows.map(mapRow);
  }

  async listDueForPush(now: Date, since: Date, limit: number): Promise<TicketRatingRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM ticket_ratings
         WHERE pushed_at IS NULL AND rating IS NULL AND due_at <= ? AND created_at >= ? ORDER BY due_at LIMIT ?`
      )
      .all(now.toISOString(), since.toISOString(), limit) as unknown as RatingRow[];
    return rows.map(mapRow);
  }

  async markPushed(customerId: string, protocol: string, now = new Date()): Promise<void> {
    this.db
      .prepare("UPDATE ticket_ratings SET pushed_at = ? WHERE customer_id = ? AND protocol = ? AND pushed_at IS NULL")
      .run(now.toISOString(), customerId, protocol);
  }

  async submit(customerId: string, protocol: string, rating: number, comment: string | null, now: Date): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE ticket_ratings SET rating = ?, comment = ?, answered_at = ?
         WHERE customer_id = ? AND protocol = ? AND rating IS NULL`
      )
      .run(rating, comment, now.toISOString(), customerId, protocol);
    return Number(result.changes) > 0;
  }

  async listInRange(from: Date, to: Date, limit: number): Promise<TicketRatingRecord[]> {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM ticket_ratings WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
      .all(from.toISOString(), to.toISOString(), limit) as unknown as RatingRow[];
    return rows.map(mapRow);
  }
  async findByProtocol(protocol: string): Promise<TicketRatingRecord | null> {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM ticket_ratings WHERE protocol = ? ORDER BY created_at DESC LIMIT 1`).get(protocol) as unknown as RatingRow | undefined;
    return row ? mapRow(row) : null;
  }

  async findById(id: string): Promise<TicketRatingRecord | null> {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM ticket_ratings WHERE id = ?`).get(id) as unknown as RatingRow | undefined;
    return row ? mapRow(row) : null;
  }

  async deleteById(id: string): Promise<boolean> {
    return Number(this.db.prepare("DELETE FROM ticket_ratings WHERE id = ?").run(id).changes) > 0;
  }

  async deleteByContract(contractId: string): Promise<number> {
    return Number(this.db.prepare("DELETE FROM ticket_ratings WHERE contract_id = ?").run(contractId).changes);
  }
}

export class MysqlTicketRatingRepository implements TicketRatingRepository {
  constructor(private readonly pool: Pool) {}

  async createRequest(input: CreateRatingRequestInput): Promise<boolean> {
    const [result] = await this.pool.execute(
      `INSERT IGNORE INTO ticket_ratings (id, customer_id, contract_id, protocol, ticket_title, technician, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.customerId,
        input.contractId,
        input.protocol,
        input.ticketTitle,
        input.technician ?? null,
        input.dueAt.toISOString(),
        (input.now ?? new Date()).toISOString()
      ]
    );
    return Number((result as { affectedRows?: number }).affectedRows) > 0;
  }

  async listPending(customerId: string, now: Date, since: Date): Promise<TicketRatingRecord[]> {
    const [rows] = await this.pool.execute(
      `SELECT ${COLUMNS} FROM ticket_ratings AS t
       WHERE t.customer_id = ? AND t.rating IS NULL AND t.created_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM ticket_ratings AS newer WHERE newer.customer_id = t.customer_id
             AND (newer.created_at > t.created_at OR (newer.created_at = t.created_at AND newer.protocol > t.protocol))
         )
       ORDER BY t.created_at DESC LIMIT 1`,
      [customerId, since.toISOString()]
    );
    return (rows as RatingRow[]).map(mapRow);
  }

  async listDueForPush(now: Date, since: Date, limit: number): Promise<TicketRatingRecord[]> {
    const [rows] = await this.pool.query(
      `SELECT ${COLUMNS} FROM ticket_ratings
       WHERE pushed_at IS NULL AND rating IS NULL AND due_at <= ? AND created_at >= ? ORDER BY due_at LIMIT ?`,
      [now.toISOString(), since.toISOString(), limit]
    );
    return (rows as RatingRow[]).map(mapRow);
  }

  async markPushed(customerId: string, protocol: string, now = new Date()): Promise<void> {
    await this.pool.execute("UPDATE ticket_ratings SET pushed_at = ? WHERE customer_id = ? AND protocol = ? AND pushed_at IS NULL", [
      now.toISOString(),
      customerId,
      protocol
    ]);
  }

  async submit(customerId: string, protocol: string, rating: number, comment: string | null, now: Date): Promise<boolean> {
    const [result] = await this.pool.execute(
      `UPDATE ticket_ratings SET rating = ?, comment = ?, answered_at = ?
       WHERE customer_id = ? AND protocol = ? AND rating IS NULL`,
      [rating, comment, now.toISOString(), customerId, protocol]
    );
    return Number((result as { affectedRows?: number }).affectedRows) > 0;
  }

  async listInRange(from: Date, to: Date, limit: number): Promise<TicketRatingRecord[]> {
    const [rows] = await this.pool.query(
      `SELECT ${COLUMNS} FROM ticket_ratings WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
      [from.toISOString(), to.toISOString(), limit]
    );
    return (rows as RatingRow[]).map(mapRow);
  }

  async findByProtocol(protocol: string): Promise<TicketRatingRecord | null> {
    const [rows] = await this.pool.execute(`SELECT ${COLUMNS} FROM ticket_ratings WHERE protocol = ? ORDER BY created_at DESC LIMIT 1`, [protocol]);
    const row = (rows as RatingRow[])[0];
    return row ? mapRow(row) : null;
  }

  async findById(id: string): Promise<TicketRatingRecord | null> {
    const [rows] = await this.pool.execute(`SELECT ${COLUMNS} FROM ticket_ratings WHERE id = ?`, [id]);
    const row = (rows as RatingRow[])[0];
    return row ? mapRow(row) : null;
  }

  async deleteById(id: string): Promise<boolean> {
    const [result] = await this.pool.execute("DELETE FROM ticket_ratings WHERE id = ?", [id]);
    return Number((result as { affectedRows?: number }).affectedRows) > 0;
  }

  async deleteByContract(contractId: string): Promise<number> {
    const [result] = await this.pool.execute("DELETE FROM ticket_ratings WHERE contract_id = ?", [contractId]);
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }
}
