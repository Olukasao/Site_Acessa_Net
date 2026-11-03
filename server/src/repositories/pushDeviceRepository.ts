import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "mysql2/promise";
import { sha256 } from "../security/hash.js";

export interface PushDeviceRecord {
  id: string;
  customerId: string;
  token: string;
  platform: string;
  appVersion: string | null;
  contractIds: string[];
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  disabledAt: Date | null;
}

export interface UpsertPushDeviceInput {
  customerId: string;
  token: string;
  platform: string;
  appVersion?: string | undefined;
  /** undefined = mantem os contratos ja gravados (ou [] num registro novo). */
  contractIds?: string[] | undefined;
  now?: Date;
}

export interface PushAppointmentState {
  appointmentKey: string;
  notifiedAt: Date;
}

export interface PushDeviceRepository {
  /** Upsert por token. Token de outro cliente e transferido para o atual; reativa se estava desativado. */
  upsertDevice(input: UpsertPushDeviceInput): Promise<void>;
  /** Desativa o token SOMENTE se pertencer ao cliente. Idempotente; nunca diz se existia. */
  disableForCustomer(customerId: string, token: string, now?: Date): Promise<void>;
  /** Desativa o token (usado pelo notificador quando o FCM diz que e invalido). */
  disableToken(token: string, now?: Date): Promise<void>;
  listActiveDevices(): Promise<PushDeviceRecord[]>;
  getAppointmentState(customerId: string, ticketProtocol: string): Promise<PushAppointmentState | null>;
  saveAppointmentState(customerId: string, ticketProtocol: string, appointmentKey: string, now?: Date): Promise<void>;
  /** Estagio ja avisado de cada fatura do cliente (invoiceId -> 1 | 2). */
  getBillingStages(customerId: string): Promise<Map<string, number>>;
  saveBillingStage(customerId: string, invoiceId: string, stage: number, now?: Date): Promise<void>;
}

interface DeviceRow {
  id: string;
  customer_id: string;
  token: string;
  platform: string;
  app_version: string | null;
  contract_ids: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  disabled_at: string | null;
}

interface StateRow {
  appointment_key: string;
  notified_at: string;
}

function parseContractIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapDevice(row: DeviceRow): PushDeviceRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    token: row.token,
    platform: row.platform,
    appVersion: row.app_version,
    contractIds: parseContractIds(row.contract_ids),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastSeenAt: new Date(row.last_seen_at),
    disabledAt: row.disabled_at ? new Date(row.disabled_at) : null
  };
}

export class SqlitePushDeviceRepository implements PushDeviceRepository {
  constructor(private readonly db: DatabaseSync) {}

  async upsertDevice(input: UpsertPushDeviceInput): Promise<void> {
    const nowIso = (input.now ?? new Date()).toISOString();
    const existing = this.db.prepare("SELECT contract_ids FROM push_devices WHERE token = ?").get(input.token) as
      | { contract_ids: string }
      | undefined;
    const contractJson = JSON.stringify(input.contractIds ?? (existing ? parseContractIds(existing.contract_ids) : []));
    this.db
      .prepare(
        `INSERT INTO push_devices (id, customer_id, token, platform, app_version, contract_ids, created_at, updated_at, last_seen_at, disabled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(token) DO UPDATE SET
           customer_id = excluded.customer_id,
           platform = excluded.platform,
           app_version = excluded.app_version,
           contract_ids = excluded.contract_ids,
           updated_at = excluded.updated_at,
           last_seen_at = excluded.last_seen_at,
           disabled_at = NULL`
      )
      .run(randomUUID(), input.customerId, input.token, input.platform, input.appVersion ?? null, contractJson, nowIso, nowIso, nowIso);
  }

  async disableForCustomer(customerId: string, token: string, now = new Date()): Promise<void> {
    this.db
      .prepare("UPDATE push_devices SET disabled_at = ?, updated_at = ? WHERE token = ? AND customer_id = ? AND disabled_at IS NULL")
      .run(now.toISOString(), now.toISOString(), token, customerId);
  }

  async disableToken(token: string, now = new Date()): Promise<void> {
    this.db
      .prepare("UPDATE push_devices SET disabled_at = ?, updated_at = ? WHERE token = ? AND disabled_at IS NULL")
      .run(now.toISOString(), now.toISOString(), token);
  }

  async listActiveDevices(): Promise<PushDeviceRecord[]> {
    const rows = this.db.prepare("SELECT * FROM push_devices WHERE disabled_at IS NULL ORDER BY customer_id, id").all() as unknown as DeviceRow[];
    return rows.map(mapDevice);
  }

  async getAppointmentState(customerId: string, ticketProtocol: string): Promise<PushAppointmentState | null> {
    const row = this.db
      .prepare("SELECT appointment_key, notified_at FROM push_appointment_state WHERE customer_id = ? AND ticket_protocol = ?")
      .get(customerId, ticketProtocol) as StateRow | undefined;
    return row ? { appointmentKey: row.appointment_key, notifiedAt: new Date(row.notified_at) } : null;
  }

  async saveAppointmentState(customerId: string, ticketProtocol: string, appointmentKey: string, now = new Date()): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO push_appointment_state (customer_id, ticket_protocol, appointment_key, notified_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(customer_id, ticket_protocol) DO UPDATE SET appointment_key = excluded.appointment_key, notified_at = excluded.notified_at`
      )
      .run(customerId, ticketProtocol, appointmentKey, now.toISOString());
  }

  async getBillingStages(customerId: string): Promise<Map<string, number>> {
    const rows = this.db.prepare("SELECT invoice_id, stage FROM push_billing_state WHERE customer_id = ?").all(customerId) as unknown as Array<{
      invoice_id: string;
      stage: number;
    }>;
    return new Map(rows.map((row) => [row.invoice_id, Number(row.stage)]));
  }

  async saveBillingStage(customerId: string, invoiceId: string, stage: number, now = new Date()): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO push_billing_state (customer_id, invoice_id, stage, notified_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(customer_id, invoice_id) DO UPDATE SET stage = excluded.stage, notified_at = excluded.notified_at`
      )
      .run(customerId, invoiceId, stage, now.toISOString());
  }
}

export class MysqlPushDeviceRepository implements PushDeviceRepository {
  constructor(private readonly pool: Pool) {}

  async upsertDevice(input: UpsertPushDeviceInput): Promise<void> {
    const nowIso = (input.now ?? new Date()).toISOString();
    const tokenHash = sha256(input.token);
    let contractIds = input.contractIds;
    if (!contractIds) {
      const [rows] = await this.pool.execute("SELECT contract_ids FROM push_devices WHERE token_hash = ?", [tokenHash]);
      const existing = (rows as Array<{ contract_ids: string }>)[0];
      contractIds = existing ? parseContractIds(existing.contract_ids) : [];
    }
    await this.pool.execute(
      `INSERT INTO push_devices (id, customer_id, token, token_hash, platform, app_version, contract_ids, created_at, updated_at, last_seen_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON DUPLICATE KEY UPDATE
         customer_id = VALUES(customer_id),
         platform = VALUES(platform),
         app_version = VALUES(app_version),
         contract_ids = VALUES(contract_ids),
         updated_at = VALUES(updated_at),
         last_seen_at = VALUES(last_seen_at),
         disabled_at = NULL`,
      [randomUUID(), input.customerId, input.token, tokenHash, input.platform, input.appVersion ?? null, JSON.stringify(contractIds), nowIso, nowIso, nowIso]
    );
  }

  async disableForCustomer(customerId: string, token: string, now = new Date()): Promise<void> {
    await this.pool.execute(
      "UPDATE push_devices SET disabled_at = ?, updated_at = ? WHERE token_hash = ? AND customer_id = ? AND disabled_at IS NULL",
      [now.toISOString(), now.toISOString(), sha256(token), customerId]
    );
  }

  async disableToken(token: string, now = new Date()): Promise<void> {
    await this.pool.execute("UPDATE push_devices SET disabled_at = ?, updated_at = ? WHERE token_hash = ? AND disabled_at IS NULL", [
      now.toISOString(),
      now.toISOString(),
      sha256(token)
    ]);
  }

  async listActiveDevices(): Promise<PushDeviceRecord[]> {
    const [rows] = await this.pool.execute(
      "SELECT id, customer_id, token, platform, app_version, contract_ids, created_at, updated_at, last_seen_at, disabled_at FROM push_devices WHERE disabled_at IS NULL ORDER BY customer_id, id"
    );
    return (rows as DeviceRow[]).map(mapDevice);
  }

  async getAppointmentState(customerId: string, ticketProtocol: string): Promise<PushAppointmentState | null> {
    const [rows] = await this.pool.execute(
      "SELECT appointment_key, notified_at FROM push_appointment_state WHERE customer_id = ? AND ticket_protocol = ?",
      [customerId, ticketProtocol]
    );
    const row = (rows as StateRow[])[0];
    return row ? { appointmentKey: row.appointment_key, notifiedAt: new Date(row.notified_at) } : null;
  }

  async saveAppointmentState(customerId: string, ticketProtocol: string, appointmentKey: string, now = new Date()): Promise<void> {
    await this.pool.execute(
      `INSERT INTO push_appointment_state (customer_id, ticket_protocol, appointment_key, notified_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE appointment_key = VALUES(appointment_key), notified_at = VALUES(notified_at)`,
      [customerId, ticketProtocol, appointmentKey, now.toISOString()]
    );
  }

  async getBillingStages(customerId: string): Promise<Map<string, number>> {
    const [rows] = await this.pool.execute("SELECT invoice_id, stage FROM push_billing_state WHERE customer_id = ?", [customerId]);
    return new Map((rows as Array<{ invoice_id: string; stage: number }>).map((row) => [row.invoice_id, Number(row.stage)]));
  }

  async saveBillingStage(customerId: string, invoiceId: string, stage: number, now = new Date()): Promise<void> {
    await this.pool.execute(
      `INSERT INTO push_billing_state (customer_id, invoice_id, stage, notified_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE stage = VALUES(stage), notified_at = VALUES(notified_at)`,
      [customerId, invoiceId, stage, now.toISOString()]
    );
  }
}
