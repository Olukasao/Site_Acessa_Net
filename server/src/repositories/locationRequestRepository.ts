import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "mysql2/promise";

export type LocationRequestStatus = "pending" | "approved" | "rejected";
export type LocationSource = "web" | "app";

export interface LocationRequestRecord {
  id: string;
  customerId: string;
  contractId: string;
  /** Chamado com visita para o qual a localizacao foi enviada. */
  protocol: string;
  latitude: number;
  longitude: number;
  /** Precisao informada pelo aparelho, em metros. */
  accuracyMeters: number | null;
  source: LocationSource;
  status: LocationRequestStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  /** Quando o link do mapa foi gravado na OS/ocorrencia do SGP (so depois da aprovacao). */
  sgpPostedAt: string | null;
}

export interface CreateLocationRequestInput {
  customerId: string;
  contractId: string;
  protocol: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null | undefined;
  source: LocationSource;
  now?: Date;
}

/** Nota gravada no envio pendente que um envio mais novo do mesmo chamado substituiu. */
export const SUPERSEDED_NOTE = "Substituido por um novo envio do cliente.";

export interface LocationRequestRepository {
  /** Cria um envio pendente; o pendente anterior do mesmo contrato/chamado vira "recusado/substituido" (vale so o ultimo, o historico fica). */
  create(input: CreateLocationRequestInput): Promise<LocationRequestRecord>;
  findById(id: string): Promise<LocationRequestRecord | null>;
  /** Do mais novo para o mais antigo. Sem status = todos. */
  list(status: LocationRequestStatus | undefined, limit: number): Promise<LocationRequestRecord[]>;
  /** Ultimo envio do cliente para o contrato/chamado (para a tela mostrar "aguardando analise"/"confirmada"). */
  latestFor(customerId: string, contractId: string, protocol: string): Promise<LocationRequestRecord | null>;
  /** Envios do contrato nas ultimas horas (limite de abuso). */
  countRecent(customerId: string, contractId: string, since: Date): Promise<number>;
  /** Marca como aprovado/recusado so se ainda estiver pendente. Devolve false se nao estava. */
  review(id: string, status: "approved" | "rejected", adminId: string, note: string | null, now: Date): Promise<boolean>;
  markSgpPosted(id: string, now: Date): Promise<void>;
}

interface Row {
  id: string;
  customer_id: string;
  contract_id: string;
  protocol: string;
  latitude: number | string;
  longitude: number | string;
  accuracy_m: number | string | null;
  source: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  sgp_posted_at: string | null;
}

const COLUMNS =
  "id, customer_id, contract_id, protocol, latitude, longitude, accuracy_m, source, status, created_at, reviewed_at, reviewed_by, review_note, sgp_posted_at";

function mapRow(row: Row): LocationRequestRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    contractId: row.contract_id,
    protocol: row.protocol,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracyMeters: row.accuracy_m === null ? null : Number(row.accuracy_m),
    source: row.source as LocationSource,
    status: row.status as LocationRequestStatus,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
    sgpPostedAt: row.sgp_posted_at
  };
}

export class SqliteLocationRequestRepository implements LocationRequestRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(input: CreateLocationRequestInput): Promise<LocationRequestRecord> {
    const id = randomUUID();
    const createdAt = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        "UPDATE location_requests SET status = 'rejected', reviewed_at = ?, review_note = ? WHERE customer_id = ? AND contract_id = ? AND protocol = ? AND status = 'pending'"
      )
      .run(createdAt, SUPERSEDED_NOTE, input.customerId, input.contractId, input.protocol);
    this.db
      .prepare(
        `INSERT INTO location_requests (id, customer_id, contract_id, protocol, latitude, longitude, accuracy_m, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(id, input.customerId, input.contractId, input.protocol, input.latitude, input.longitude, input.accuracyMeters ?? null, input.source, createdAt);
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<LocationRequestRecord | null> {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM location_requests WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? mapRow(row) : null;
  }

  async list(status: LocationRequestStatus | undefined, limit: number): Promise<LocationRequestRecord[]> {
    const rows = (
      status
        ? this.db.prepare(`SELECT ${COLUMNS} FROM location_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit)
        : this.db.prepare(`SELECT ${COLUMNS} FROM location_requests ORDER BY created_at DESC LIMIT ?`).all(limit)
    ) as unknown as Row[];
    return rows.map(mapRow);
  }

  async latestFor(customerId: string, contractId: string, protocol: string): Promise<LocationRequestRecord | null> {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM location_requests WHERE customer_id = ? AND contract_id = ? AND protocol = ? ORDER BY created_at DESC LIMIT 1`)
      .get(customerId, contractId, protocol) as unknown as Row | undefined;
    return row ? mapRow(row) : null;
  }

  async countRecent(customerId: string, contractId: string, since: Date): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM location_requests WHERE customer_id = ? AND contract_id = ? AND created_at >= ?")
      .get(customerId, contractId, since.toISOString()) as unknown as { total: number };
    return Number(row.total);
  }

  async review(id: string, status: "approved" | "rejected", adminId: string, note: string | null, now: Date): Promise<boolean> {
    const result = this.db
      .prepare("UPDATE location_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'pending'")
      .run(status, now.toISOString(), adminId, note, id);
    return Number(result.changes) > 0;
  }

  async markSgpPosted(id: string, now: Date): Promise<void> {
    this.db.prepare("UPDATE location_requests SET sgp_posted_at = ? WHERE id = ?").run(now.toISOString(), id);
  }
}

export class MysqlLocationRequestRepository implements LocationRequestRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateLocationRequestInput): Promise<LocationRequestRecord> {
    const id = randomUUID();
    const createdAt = (input.now ?? new Date()).toISOString();
    await this.pool.execute(
      "UPDATE location_requests SET status = 'rejected', reviewed_at = ?, review_note = ? WHERE customer_id = ? AND contract_id = ? AND protocol = ? AND status = 'pending'",
      [createdAt, SUPERSEDED_NOTE, input.customerId, input.contractId, input.protocol]
    );
    await this.pool.execute(
      `INSERT INTO location_requests (id, customer_id, contract_id, protocol, latitude, longitude, accuracy_m, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, input.customerId, input.contractId, input.protocol, input.latitude, input.longitude, input.accuracyMeters ?? null, input.source, createdAt]
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<LocationRequestRecord | null> {
    const [rows] = await this.pool.execute(`SELECT ${COLUMNS} FROM location_requests WHERE id = ?`, [id]);
    const row = (rows as Row[])[0];
    return row ? mapRow(row) : null;
  }

  async list(status: LocationRequestStatus | undefined, limit: number): Promise<LocationRequestRecord[]> {
    const [rows] = status
      ? await this.pool.query(`SELECT ${COLUMNS} FROM location_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?`, [status, limit])
      : await this.pool.query(`SELECT ${COLUMNS} FROM location_requests ORDER BY created_at DESC LIMIT ?`, [limit]);
    return (rows as Row[]).map(mapRow);
  }

  async latestFor(customerId: string, contractId: string, protocol: string): Promise<LocationRequestRecord | null> {
    const [rows] = await this.pool.execute(
      `SELECT ${COLUMNS} FROM location_requests WHERE customer_id = ? AND contract_id = ? AND protocol = ? ORDER BY created_at DESC LIMIT 1`,
      [customerId, contractId, protocol]
    );
    const row = (rows as Row[])[0];
    return row ? mapRow(row) : null;
  }

  async countRecent(customerId: string, contractId: string, since: Date): Promise<number> {
    const [rows] = await this.pool.execute(
      "SELECT COUNT(*) AS total FROM location_requests WHERE customer_id = ? AND contract_id = ? AND created_at >= ?",
      [customerId, contractId, since.toISOString()]
    );
    return Number((rows as Array<{ total: number }>)[0]?.total ?? 0);
  }

  async review(id: string, status: "approved" | "rejected", adminId: string, note: string | null, now: Date): Promise<boolean> {
    const [result] = await this.pool.execute(
      "UPDATE location_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'pending'",
      [status, now.toISOString(), adminId, note, id]
    );
    return Number((result as { affectedRows?: number }).affectedRows) > 0;
  }

  async markSgpPosted(id: string, now: Date): Promise<void> {
    await this.pool.execute("UPDATE location_requests SET sgp_posted_at = ? WHERE id = ?", [now.toISOString(), id]);
  }
}
