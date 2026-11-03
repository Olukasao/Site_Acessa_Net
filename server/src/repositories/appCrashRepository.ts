import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "mysql2/promise";

export const APP_CRASH_STATUSES = ["novo", "em_analise", "corrigido", "ignorado"] as const;
export type AppCrashStatus = (typeof APP_CRASH_STATUSES)[number];
export const APP_CRASH_KINDS = ["js", "native", "anr"] as const;
export type AppCrashKind = (typeof APP_CRASH_KINDS)[number];

export interface AppCrashInput {
  signature: string;
  kind: AppCrashKind;
  title: string;
  stack: string;
  appVersion: string;
  deviceId: string;
  deviceModel: string;
  androidVersion: string;
  createdAt: Date;
}

export interface AppCrashOccurrence {
  id: number;
  signature: string;
  kind: AppCrashKind;
  title: string;
  stack: string;
  appVersion: string;
  deviceId: string;
  deviceModel: string;
  androidVersion: string;
  createdAt: string;
}

export interface AppCrashStatusRecord {
  signature: string;
  status: AppCrashStatus;
  adminNotes: string | null;
  updatedAt: string;
}

export interface AppCrashRepository {
  insert(input: AppCrashInput): Promise<void>;
  /** Ocorrencias do periodo SEM a pilha (leve), da mais nova para a mais antiga. */
  listInRange(from: Date, to: Date, limit: number): Promise<Array<Omit<AppCrashOccurrence, "stack">>>;
  /** Ocorrencias de um erro, com pilha, da mais nova para a mais antiga. */
  listBySignature(signature: string, limit: number): Promise<AppCrashOccurrence[]>;
  getStatuses(signatures: string[]): Promise<Map<string, AppCrashStatusRecord>>;
  setStatus(signature: string, status: AppCrashStatus, adminNotes: string | null, now: Date): Promise<void>;
  /** Apaga ocorrencias antigas (e status de erros que nao tem mais ocorrencia). Devolve quantas ocorrencias apagou. */
  purgeOlderThan(before: Date): Promise<number>;
}

interface CrashRow {
  id: number;
  signature: string;
  kind: string;
  title: string;
  stack?: string;
  app_version: string;
  device_id: string;
  device_model: string;
  android_version: string;
  created_at: string;
}

interface StatusRow {
  signature: string;
  status: string;
  admin_notes: string | null;
  updated_at: string;
}

const LIGHT = "id, signature, kind, title, app_version, device_id, device_model, android_version, created_at";
const FULL = "id, signature, kind, title, stack, app_version, device_id, device_model, android_version, created_at";

function mapCrash(row: CrashRow): AppCrashOccurrence {
  return {
    id: Number(row.id),
    signature: row.signature,
    kind: row.kind as AppCrashKind,
    title: row.title,
    stack: row.stack ?? "",
    appVersion: row.app_version,
    deviceId: row.device_id,
    deviceModel: row.device_model,
    androidVersion: row.android_version,
    createdAt: row.created_at
  };
}

function mapStatus(row: StatusRow): AppCrashStatusRecord {
  return { signature: row.signature, status: row.status as AppCrashStatus, adminNotes: row.admin_notes, updatedAt: row.updated_at };
}

function insertParams(input: AppCrashInput) {
  return [
    input.signature,
    input.kind,
    input.title,
    input.stack,
    input.appVersion,
    input.deviceId,
    input.deviceModel,
    input.androidVersion,
    input.createdAt.toISOString()
  ];
}

const INSERT_SQL = `INSERT INTO app_crashes (signature, kind, title, stack, app_version, device_id, device_model, android_version, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class SqliteAppCrashRepository implements AppCrashRepository {
  constructor(private readonly db: DatabaseSync) {}

  async insert(input: AppCrashInput) {
    this.db.prepare(INSERT_SQL).run(...insertParams(input));
  }

  async listInRange(from: Date, to: Date, limit: number) {
    const rows = this.db
      .prepare(`SELECT ${LIGHT} FROM app_crashes WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
      .all(from.toISOString(), to.toISOString(), limit) as unknown as CrashRow[];
    return rows.map(mapCrash).map(({ stack: _stack, ...rest }) => rest);
  }

  async listBySignature(signature: string, limit: number) {
    const rows = this.db
      .prepare(`SELECT ${FULL} FROM app_crashes WHERE signature = ? ORDER BY created_at DESC LIMIT ?`)
      .all(signature, limit) as unknown as CrashRow[];
    return rows.map(mapCrash);
  }

  async getStatuses(signatures: string[]) {
    const map = new Map<string, AppCrashStatusRecord>();
    for (const signature of new Set(signatures)) {
      const row = this.db.prepare("SELECT signature, status, admin_notes, updated_at FROM app_crash_status WHERE signature = ?").get(signature) as StatusRow | undefined;
      if (row) map.set(signature, mapStatus(row));
    }
    return map;
  }

  async setStatus(signature: string, status: AppCrashStatus, adminNotes: string | null, now: Date) {
    this.db
      .prepare(
        `INSERT INTO app_crash_status (signature, status, admin_notes, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(signature) DO UPDATE SET status = excluded.status, admin_notes = excluded.admin_notes, updated_at = excluded.updated_at`
      )
      .run(signature, status, adminNotes, now.toISOString());
  }

  async purgeOlderThan(before: Date) {
    const result = this.db.prepare("DELETE FROM app_crashes WHERE created_at < ?").run(before.toISOString());
    this.db.prepare("DELETE FROM app_crash_status WHERE signature NOT IN (SELECT DISTINCT signature FROM app_crashes)").run();
    return Number(result.changes);
  }
}

export class MysqlAppCrashRepository implements AppCrashRepository {
  constructor(private readonly pool: Pool) {}

  async insert(input: AppCrashInput) {
    await this.pool.execute(INSERT_SQL, insertParams(input));
  }

  async listInRange(from: Date, to: Date, limit: number) {
    const [rows] = await this.pool.query(
      `SELECT ${LIGHT} FROM app_crashes WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
      [from.toISOString(), to.toISOString(), limit]
    );
    return (rows as CrashRow[]).map(mapCrash).map(({ stack: _stack, ...rest }) => rest);
  }

  async listBySignature(signature: string, limit: number) {
    const [rows] = await this.pool.query(`SELECT ${FULL} FROM app_crashes WHERE signature = ? ORDER BY created_at DESC LIMIT ?`, [signature, limit]);
    return (rows as CrashRow[]).map(mapCrash);
  }

  async getStatuses(signatures: string[]) {
    const map = new Map<string, AppCrashStatusRecord>();
    const unique = [...new Set(signatures)];
    if (unique.length === 0) return map;
    const [rows] = await this.pool.query("SELECT signature, status, admin_notes, updated_at FROM app_crash_status WHERE signature IN (?)", [unique]);
    for (const row of rows as StatusRow[]) map.set(row.signature, mapStatus(row));
    return map;
  }

  async setStatus(signature: string, status: AppCrashStatus, adminNotes: string | null, now: Date) {
    await this.pool.execute(
      `INSERT INTO app_crash_status (signature, status, admin_notes, updated_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), admin_notes = VALUES(admin_notes), updated_at = VALUES(updated_at)`,
      [signature, status, adminNotes, now.toISOString()]
    );
  }

  async purgeOlderThan(before: Date) {
    const [result] = await this.pool.execute("DELETE FROM app_crashes WHERE created_at < ?", [before.toISOString()]);
    await this.pool.execute("DELETE FROM app_crash_status WHERE signature NOT IN (SELECT DISTINCT signature FROM app_crashes)");
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }
}
