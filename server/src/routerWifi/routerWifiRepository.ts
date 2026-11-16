import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, ResultSetHeader } from "mysql2/promise";

/**
 * Fila de tarefas do "Gerenciar meu Wi-Fi". A Central (Hostinger) so guarda a tarefa; quem fala com o SGP e com o
 * roteador e o agente interno (server/router-agent), que busca as tarefas aqui. A senha nova fica so como texto
 * cifrado com a chave publica do agente e e apagada quando a tarefa termina.
 */
export type RouterJobKind = "status" | "change_password";
export const ROUTER_JOB_PROGRESS = ["connecting", "authenticating", "updating", "verifying"] as const;
export const ROUTER_JOB_FINAL = ["completed", "failed", "unsupported", "unconfirmed"] as const;
export type RouterJobState = "pending" | (typeof ROUTER_JOB_PROGRESS)[number] | (typeof ROUTER_JOB_FINAL)[number];
export type WifiBand = "2.4GHz" | "5GHz";

export const isFinalState = (state: RouterJobState) => (ROUTER_JOB_FINAL as readonly string[]).includes(state);

export interface RouterJobRecord {
  id: string;
  customerId: string;
  contractId: string;
  kind: RouterJobKind;
  bands: WifiBand[];
  /** Senha nova cifrada (RSA-OAEP) para o agente. Nulo depois que a tarefa termina. */
  secretEnc: string | null;
  state: RouterJobState;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  /** O cliente disse se conseguiu conectar com a nova senha (so quando o roteador nao deixa conferir). */
  customerConfirmation: "connected" | "not_connected" | null;
  confirmedAt: string | null;
  /** Protocolo do chamado aberto quando o cliente disse que nao conseguiu conectar. */
  ticketProtocol: string | null;
  notifiedAt: string | null;
}

export type InventoryManagement = "available" | "offline" | "unsupported" | "requires_validation" | "unreachable" | "not_identified";

export interface InventoryEntry {
  contractId: string;
  vendor: string | null;
  model: string | null;
  management: InventoryManagement;
  /** Dono/nome do certificado do roteador (dado publico do aparelho), para descobrir novos fabricantes. */
  certSubject?: string | null;
  certFp?: string | null;
}

export interface InventoryCount {
  vendor: string | null;
  model: string | null;
  management: string;
  total: number;
}

export interface AgentStatus {
  agentId: string;
  lastSeenAt: string;
  dryRun: boolean;
  version: string | null;
}

export interface CreateRouterJobInput {
  customerId: string;
  contractId: string;
  kind: RouterJobKind;
  bands: WifiBand[];
  secretEnc: string | null;
  now?: Date;
}

export interface RouterJobUpdate {
  state: RouterJobState;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
  now: Date;
}

export interface RouterWifiRepository {
  create(input: CreateRouterJobInput): Promise<RouterJobRecord>;
  findById(id: string): Promise<RouterJobRecord | null>;
  /** Tarefa ainda nao terminada do contrato (uma por vez). */
  findOpen(contractId: string, kind: RouterJobKind): Promise<RouterJobRecord | null>;
  /** Ultima tarefa terminada do contrato. */
  latestFinished(contractId: string, kind: RouterJobKind): Promise<RouterJobRecord | null>;
  /** Pega ate `limit` tarefas pendentes para o agente (cada uma so pode ser pega por um agente). */
  claim(agentId: string, limit: number, now: Date): Promise<RouterJobRecord[]>;
  /** Atualiza so se a tarefa for desse agente e ainda nao tiver terminado. Estado final apaga o segredo. */
  update(id: string, agentId: string, update: RouterJobUpdate): Promise<boolean>;
  /** Encerra o que ficou parado: pendente velho (agente fora) e em andamento velho (resultado nao confirmado). */
  expireStale(now: Date, pendingMaxMs: number, runningMaxMs: number): Promise<number>;
  /** Ultimas tarefas (painel administrativo). */
  list(limit: number): Promise<RouterJobRecord[]>;
  /** Tarefas criadas a partir de `since` (relatorio do painel). */
  listSince(since: Date, limit: number): Promise<RouterJobRecord[]>;
  /** Resposta do cliente a "Conseguiu conectar?". So vale uma vez, no proprio pedido, enquanto estiver "nao confirmado". */
  confirm(id: string, customerId: string, confirmation: "connected" | "not_connected", now: Date): Promise<boolean>;
  setTicket(id: string, protocol: string): Promise<void>;
  /** Marca o aviso de "senha alterada" como enviado; false se outro processo ja marcou (nunca avisa duas vezes). */
  markNotified(id: string, now: Date): Promise<boolean>;
  /** Troca de senha deste contrato que ainda espera a resposta do cliente. */
  findAwaitingConfirmation(contractId: string, since: Date): Promise<RouterJobRecord | null>;
  /** Sinal de vida do agente (cada busca de tarefas). */
  touchAgent(agentId: string, dryRun: boolean, version: string | null, now: Date): Promise<void>;
  lastAgent(): Promise<AgentStatus | null>;
  upsertInventory(entries: InventoryEntry[], now: Date): Promise<number>;
  inventorySummary(): Promise<{ counts: InventoryCount[]; total: number; lastSeenAt: string | null }>;
}

interface Row {
  id: string;
  customer_id: string;
  contract_id: string;
  kind: string;
  bands: string;
  secret_enc: string | null;
  state: string;
  result_json: string | null;
  error_code: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  customer_confirmation: string | null;
  confirmed_at: string | null;
  ticket_protocol: string | null;
  notified_at: string | null;
}

const COLUMNS =
  "id, customer_id, contract_id, kind, bands, secret_enc, state, result_json, error_code, agent_id, created_at, updated_at, claimed_at, finished_at, customer_confirmation, confirmed_at, ticket_protocol, notified_at";
const OPEN_STATES = "('pending','connecting','authenticating','updating','verifying')";
const FINAL_STATES = "('completed','failed','unsupported','unconfirmed')";

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: Row): RouterJobRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    contractId: row.contract_id,
    kind: row.kind as RouterJobKind,
    bands: parseJson<WifiBand[]>(row.bands, []),
    secretEnc: row.secret_enc,
    state: row.state as RouterJobState,
    result: parseJson<Record<string, unknown> | null>(row.result_json, null),
    errorCode: row.error_code,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    customerConfirmation: row.customer_confirmation === "connected" || row.customer_confirmation === "not_connected" ? row.customer_confirmation : null,
    confirmedAt: row.confirmed_at,
    ticketProtocol: row.ticket_protocol,
    notifiedAt: row.notified_at
  };
}

/** As duas implementacoes usam o mesmo SQL; so muda como executar. */
interface Exec {
  all(sql: string, params: unknown[]): Promise<Row[]>;
  run(sql: string, params: unknown[]): Promise<number>;
}

class SqlRouterWifiRepository implements RouterWifiRepository {
  constructor(private readonly db: Exec) {}

  async create(input: CreateRouterJobInput): Promise<RouterJobRecord> {
    const id = randomUUID();
    const now = (input.now ?? new Date()).toISOString();
    await this.db.run(
      "INSERT INTO router_wifi_jobs (id, customer_id, contract_id, kind, bands, secret_enc, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      [id, input.customerId, input.contractId, input.kind, JSON.stringify(input.bands), input.secretEnc, now, now]
    );
    return (await this.findById(id))!;
  }

  async findById(id: string) {
    const rows = await this.db.all(`SELECT ${COLUMNS} FROM router_wifi_jobs WHERE id = ?`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findOpen(contractId: string, kind: RouterJobKind) {
    const rows = await this.db.all(
      `SELECT ${COLUMNS} FROM router_wifi_jobs WHERE contract_id = ? AND kind = ? AND state IN ${OPEN_STATES} ORDER BY created_at DESC LIMIT 1`,
      [contractId, kind]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async latestFinished(contractId: string, kind: RouterJobKind) {
    const rows = await this.db.all(
      `SELECT ${COLUMNS} FROM router_wifi_jobs WHERE contract_id = ? AND kind = ? AND state IN ${FINAL_STATES} ORDER BY finished_at DESC LIMIT 1`,
      [contractId, kind]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async claim(agentId: string, limit: number, now: Date) {
    const candidates = await this.db.all(`SELECT ${COLUMNS} FROM router_wifi_jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?`, [limit]);
    const claimed: RouterJobRecord[] = [];
    const at = now.toISOString();
    for (const row of candidates) {
      // condicional: dois agentes ao mesmo tempo nunca pegam a mesma tarefa
      const changed = await this.db.run(
        "UPDATE router_wifi_jobs SET state = 'connecting', agent_id = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
        [agentId, at, at, row.id]
      );
      if (changed > 0) claimed.push({ ...mapRow(row), state: "connecting", agentId, claimedAt: at, updatedAt: at });
    }
    return claimed;
  }

  async update(id: string, agentId: string, update: RouterJobUpdate) {
    const at = update.now.toISOString();
    const final = isFinalState(update.state);
    const changed = await this.db.run(
      `UPDATE router_wifi_jobs SET state = ?, result_json = COALESCE(?, result_json), error_code = ?, updated_at = ?,
         finished_at = ${final ? "?" : "finished_at"}, secret_enc = ${final ? "NULL" : "secret_enc"}
       WHERE id = ? AND agent_id = ? AND state IN ${OPEN_STATES}`,
      [
        update.state,
        update.result === undefined || update.result === null ? null : JSON.stringify(update.result),
        update.errorCode ?? null,
        at,
        ...(final ? [at] : []),
        id,
        agentId
      ]
    );
    return changed > 0;
  }

  async expireStale(now: Date, pendingMaxMs: number, runningMaxMs: number) {
    const at = now.toISOString();
    const pendingBefore = new Date(now.getTime() - pendingMaxMs).toISOString();
    const runningBefore = new Date(now.getTime() - runningMaxMs).toISOString();
    const a = await this.db.run(
      "UPDATE router_wifi_jobs SET state = 'failed', error_code = 'AGENT_UNAVAILABLE', secret_enc = NULL, updated_at = ?, finished_at = ? WHERE state = 'pending' AND created_at < ?",
      [at, at, pendingBefore]
    );
    // Troca de senha que parou no meio: nao da para saber se o roteador aplicou. Nunca repetimos sozinhos.
    const b = await this.db.run(
      `UPDATE router_wifi_jobs SET state = CASE WHEN kind = 'change_password' THEN 'unconfirmed' ELSE 'failed' END,
         error_code = 'AGENT_TIMEOUT', secret_enc = NULL, updated_at = ?, finished_at = ?
       WHERE state IN ('connecting','authenticating','updating','verifying') AND claimed_at < ?`,
      [at, at, runningBefore]
    );
    return a + b;
  }

  async list(limit: number) {
    const rows = await this.db.all(`SELECT ${COLUMNS} FROM router_wifi_jobs ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map(mapRow);
  }

  async listSince(since: Date, limit: number) {
    const rows = await this.db.all(`SELECT ${COLUMNS} FROM router_wifi_jobs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`, [since.toISOString(), limit]);
    return rows.map(mapRow);
  }

  async confirm(id: string, customerId: string, confirmation: "connected" | "not_connected", now: Date) {
    const at = now.toISOString();
    // "conectou" fecha o pedido como concluido; "nao conectou" continua nao confirmado (e vira chamado)
    const changed = await this.db.run(
      `UPDATE router_wifi_jobs SET customer_confirmation = ?, confirmed_at = ?, updated_at = ?,
         state = CASE WHEN ? = 'connected' THEN 'completed' ELSE state END,
         error_code = CASE WHEN ? = 'connected' THEN NULL ELSE error_code END
       WHERE id = ? AND customer_id = ? AND kind = 'change_password' AND state = 'unconfirmed' AND customer_confirmation IS NULL`,
      [confirmation, at, at, confirmation, confirmation, id, customerId]
    );
    return changed > 0;
  }

  async setTicket(id: string, protocol: string) {
    await this.db.run("UPDATE router_wifi_jobs SET ticket_protocol = ? WHERE id = ?", [protocol, id]);
  }

  async markNotified(id: string, now: Date) {
    return (await this.db.run("UPDATE router_wifi_jobs SET notified_at = ? WHERE id = ? AND notified_at IS NULL", [now.toISOString(), id])) > 0;
  }

  async findAwaitingConfirmation(contractId: string, since: Date) {
    const rows = await this.db.all(
      `SELECT ${COLUMNS} FROM router_wifi_jobs WHERE contract_id = ? AND kind = 'change_password' AND state = 'unconfirmed'
         AND customer_confirmation IS NULL AND error_code IN ('ACCEPTED_NOT_VERIFIED','VERIFY_FAILED') AND finished_at >= ?
       ORDER BY finished_at DESC LIMIT 1`,
      [contractId, since.toISOString()]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async touchAgent(agentId: string, dryRun: boolean, version: string | null, now: Date) {
    const at = now.toISOString();
    const changed = await this.db.run("UPDATE router_agent_status SET last_seen_at = ?, dry_run = ?, version = ? WHERE agent_id = ?", [at, dryRun ? 1 : 0, version, agentId]);
    if (changed === 0) await this.db.run("INSERT INTO router_agent_status (agent_id, last_seen_at, dry_run, version) VALUES (?, ?, ?, ?)", [agentId, at, dryRun ? 1 : 0, version]);
  }

  async lastAgent() {
    const rows = (await this.db.all("SELECT agent_id, last_seen_at, dry_run, version FROM router_agent_status ORDER BY last_seen_at DESC LIMIT 1", [])) as unknown as Array<{ agent_id: string; last_seen_at: string; dry_run: number; version: string | null }>;
    const row = rows[0];
    return row ? { agentId: row.agent_id, lastSeenAt: row.last_seen_at, dryRun: Number(row.dry_run) === 1, version: row.version } : null;
  }

  async upsertInventory(entries: InventoryEntry[], now: Date) {
    const at = now.toISOString();
    let saved = 0;
    for (const e of entries) {
      const changed = await this.db.run(
        "UPDATE router_inventory SET vendor = ?, model = ?, management = ?, cert_subject = ?, cert_fp = ?, seen_at = ? WHERE contract_id = ?",
        [e.vendor, e.model, e.management, e.certSubject ?? null, e.certFp ?? null, at, e.contractId]
      );
      if (changed === 0) {
        await this.db.run("INSERT INTO router_inventory (contract_id, vendor, model, management, cert_subject, cert_fp, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          e.contractId, e.vendor, e.model, e.management, e.certSubject ?? null, e.certFp ?? null, at
        ]);
      }
      saved++;
    }
    return saved;
  }

  async inventorySummary() {
    const counts = (await this.db.all(
      "SELECT vendor, model, management, COUNT(*) AS total FROM router_inventory GROUP BY vendor, model, management ORDER BY total DESC",
      []
    )) as unknown as Array<{ vendor: string | null; model: string | null; management: string; total: number | string }>;
    const last = (await this.db.all("SELECT MAX(seen_at) AS seen_at FROM router_inventory", [])) as unknown as Array<{ seen_at: string | null }>;
    const mapped = counts.map((c) => ({ vendor: c.vendor, model: c.model, management: c.management, total: Number(c.total) }));
    return { counts: mapped, total: mapped.reduce((n, c) => n + c.total, 0), lastSeenAt: last[0]?.seen_at ?? null };
  }
}

export class SqliteRouterWifiRepository extends SqlRouterWifiRepository {
  constructor(db: DatabaseSync) {
    super({
      all: async (sql, params) => db.prepare(sql).all(...(params as never[])) as unknown as Row[],
      run: async (sql, params) => Number(db.prepare(sql).run(...(params as never[])).changes)
    });
  }
}

export class MysqlRouterWifiRepository extends SqlRouterWifiRepository {
  constructor(pool: Pool) {
    super({
      all: async (sql, params) => (await pool.query(sql, params))[0] as Row[],
      run: async (sql, params) => ((await pool.query(sql, params))[0] as ResultSetHeader).affectedRows
    });
  }
}
