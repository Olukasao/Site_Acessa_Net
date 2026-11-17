import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, ResultSetHeader } from "mysql2/promise";

/**
 * Fila de tarefas do "Gerenciar meu Wi-Fi". A Central (Hostinger) so guarda a tarefa; quem fala com o SGP e com o
 * roteador e o agente interno (server/router-agent), que busca as tarefas aqui. A senha nova fica so como texto
 * cifrado com a chave publica do agente e e apagada quando a tarefa termina.
 */
export type RouterJobKind = "status" | "change_password" | "change_ssid";
/** Tipos que mudam o Wi-Fi do cliente (nunca dois ao mesmo tempo no mesmo contrato). */
export const CHANGE_KINDS: RouterJobKind[] = ["change_password", "change_ssid"];
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
  /** Ha dados memorizados (senha cifrada na Central) para abrir o chamado se a troca nao funcionar. */
  hasFallback: boolean;
  /** null = ainda nao tratado; "opening" = alguem esta abrindo o chamado; "done" = chamado aberto; "gave_up" = desistiu apos 24 h. */
  fallbackState: "opening" | "done" | "gave_up" | null;
  fallbackTries: number;
  /** Parametros que nao sao segredo (ex.: novos nomes das redes). */
  params: Record<string, unknown> | null;
}

export interface LastPasswordRecord {
  contractId: string;
  customerId: string;
  /** Senha cifrada com a chave da Central. So volta em claro depois de o cliente confirmar a senha da Central. */
  passwordEnc: string;
  bands: WifiBand[];
  jobId: string;
  setAt: string;
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
  /** Parametros sem segredo (ex.: { names: { "2.4GHz": "Casa" } }). */
  params?: Record<string, unknown> | null;
  /** Senha nova cifrada com a chave da propria Central, so para abrir o chamado se a troca automatica nao funcionar. */
  fallbackEnc?: string | null;
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
  /** Alguma troca (senha ou nome) ainda nao terminada no contrato. */
  findOpenChange(contractId: string): Promise<RouterJobRecord | null>;
  /** Ultimas trocas (senha e nome) do contrato, da mais nova para a mais antiga. */
  listChanges(contractId: string, limit: number): Promise<RouterJobRecord[]>;
  saveLastPassword(record: LastPasswordRecord): Promise<void>;
  getLastPassword(contractId: string): Promise<LastPasswordRecord | null>;
  deleteLastPassword(contractId: string): Promise<void>;
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
  /** Dados memorizados (cifrados) de uma tarefa. */
  getFallbackEnc(id: string): Promise<string | null>;
  /** Troca de senha que nao funcionou e ainda nao virou chamado (criada nas ultimas 24 h). */
  listFallbackPending(since: Date, staleOpeningBefore: Date, limit: number): Promise<RouterJobRecord[]>;
  /** Reserva a abertura do chamado de uma tarefa (so um processo consegue). Uma reserva velha (processo caiu no meio) pode ser retomada. */
  claimFallback(id: string, now: Date, staleOpeningBefore: Date): Promise<boolean>;
  /** Chamado aberto: guarda o protocolo e apaga os dados memorizados. */
  finishFallback(id: string, protocol: string): Promise<void>;
  /** Nao deu para abrir o chamado agora: libera para tentar de novo (os dados continuam memorizados). */
  releaseFallback(id: string): Promise<void>;
  /** Nao vai abrir chamado (ex.: contrato suspenso/cancelado): marca "gave_up" e apaga os dados memorizados. */
  giveUpFallback(id: string): Promise<void>;
  /** Apaga os dados memorizados de quem passou do prazo (e marca "gave_up" se nunca virou chamado). */
  purgeFallbackBefore(before: Date): Promise<number>;
  /** Encerra por conta do sistema (ex.: agente fora do ar) uma tarefa ainda nao pega por nenhum agente. */
  failBySystem(id: string, errorCode: string, now: Date): Promise<boolean>;
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
  fallback_enc: string | null;
  fallback_state: string | null;
  fallback_tries: number | string | null;
  params_json: string | null;
}

const COLUMNS =
  "id, customer_id, contract_id, kind, bands, secret_enc, state, result_json, error_code, agent_id, created_at, updated_at, claimed_at, finished_at, customer_confirmation, confirmed_at, ticket_protocol, notified_at, fallback_enc, fallback_state, fallback_tries, params_json";
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
    notifiedAt: row.notified_at,
    hasFallback: Boolean(row.fallback_enc),
    fallbackState: row.fallback_state === "opening" || row.fallback_state === "done" || row.fallback_state === "gave_up" ? row.fallback_state : null,
    fallbackTries: Number(row.fallback_tries ?? 0),
    params: parseJson<Record<string, unknown> | null>(row.params_json, null)
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
      "INSERT INTO router_wifi_jobs (id, customer_id, contract_id, kind, bands, secret_enc, fallback_enc, params_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      [id, input.customerId, input.contractId, input.kind, JSON.stringify(input.bands), input.secretEnc, input.fallbackEnc ?? null, input.params ? JSON.stringify(input.params) : null, now, now]
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

  async findOpenChange(contractId: string) {
    const rows = await this.db.all(
      `SELECT ${COLUMNS} FROM router_wifi_jobs WHERE contract_id = ? AND kind IN ('change_password','change_ssid') AND state IN ${OPEN_STATES} ORDER BY created_at DESC LIMIT 1`,
      [contractId]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listChanges(contractId: string, limit: number) {
    const rows = await this.db.all(
      `SELECT ${COLUMNS} FROM router_wifi_jobs WHERE contract_id = ? AND kind IN ('change_password','change_ssid') ORDER BY created_at DESC LIMIT ?`,
      [contractId, limit]
    );
    return rows.map(mapRow);
  }

  async saveLastPassword(record: LastPasswordRecord) {
    const changed = await this.db.run(
      "UPDATE router_wifi_last_password SET customer_id = ?, password_enc = ?, bands = ?, job_id = ?, set_at = ? WHERE contract_id = ?",
      [record.customerId, record.passwordEnc, JSON.stringify(record.bands), record.jobId, record.setAt, record.contractId]
    );
    if (changed === 0) {
      await this.db.run("INSERT INTO router_wifi_last_password (contract_id, customer_id, password_enc, bands, job_id, set_at) VALUES (?, ?, ?, ?, ?, ?)", [
        record.contractId, record.customerId, record.passwordEnc, JSON.stringify(record.bands), record.jobId, record.setAt
      ]);
    }
  }

  async getLastPassword(contractId: string) {
    const rows = (await this.db.all("SELECT contract_id, customer_id, password_enc, bands, job_id, set_at FROM router_wifi_last_password WHERE contract_id = ?", [contractId])) as unknown as Array<{
      contract_id: string; customer_id: string; password_enc: string; bands: string; job_id: string; set_at: string;
    }>;
    const row = rows[0];
    return row ? { contractId: row.contract_id, customerId: row.customer_id, passwordEnc: row.password_enc, bands: parseJson<WifiBand[]>(row.bands, []), jobId: row.job_id, setAt: row.set_at } : null;
  }

  async deleteLastPassword(contractId: string) {
    await this.db.run("DELETE FROM router_wifi_last_password WHERE contract_id = ?", [contractId]);
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
         finished_at = ${final ? "?" : "finished_at"}, secret_enc = ${final ? "NULL" : "secret_enc"},
         fallback_enc = CASE WHEN ? = 'completed' THEN NULL ELSE fallback_enc END
       WHERE id = ? AND agent_id = ? AND state IN ${OPEN_STATES}`,
      [
        update.state,
        update.result === undefined || update.result === null ? null : JSON.stringify(update.result),
        update.errorCode ?? null,
        at,
        ...(final ? [at] : []),
        update.state,
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
         error_code = CASE WHEN ? = 'connected' THEN NULL ELSE error_code END,
         fallback_enc = CASE WHEN ? = 'connected' THEN NULL ELSE fallback_enc END
       WHERE id = ? AND customer_id = ? AND kind = 'change_password' AND state = 'unconfirmed' AND customer_confirmation IS NULL`,
      [confirmation, at, at, confirmation, confirmation, confirmation, id, customerId]
    );
    return changed > 0;
  }

  async getFallbackEnc(id: string) {
    const rows = (await this.db.all("SELECT fallback_enc FROM router_wifi_jobs WHERE id = ?", [id])) as unknown as Array<{ fallback_enc: string | null }>;
    return rows[0]?.fallback_enc ?? null;
  }

  async listFallbackPending(since: Date, staleOpeningBefore: Date, limit: number) {
    // a troca nao funcionou (falhou, sem suporte ou terminou sem saber se aplicou) e ainda nao virou chamado.
    // "Roteador aceitou" fica de fora: nesse caso quem decide e o cliente ("Conseguiu conectar?").
    const rows = await this.db.all(
      `SELECT ${COLUMNS} FROM router_wifi_jobs
        WHERE kind IN ('change_password','change_ssid') AND created_at >= ? AND (fallback_enc IS NOT NULL OR kind = 'change_ssid') AND ticket_protocol IS NULL
          AND (fallback_state IS NULL OR (fallback_state = 'opening' AND updated_at < ?)) AND fallback_tries < 30 AND customer_confirmation IS NULL
          AND (error_code IS NULL OR error_code NOT IN ('CONTRACT_SUSPENDED','CONTRACT_CANCELED')) AND (state IN ('failed','unsupported') OR (state = 'unconfirmed' AND (error_code IS NULL OR error_code <> 'ACCEPTED_NOT_VERIFIED')))
        ORDER BY created_at ASC LIMIT ?`,
      [since.toISOString(), staleOpeningBefore.toISOString(), limit]
    );
    return rows.map(mapRow);
  }

  async claimFallback(id: string, now: Date, staleOpeningBefore: Date) {
    // "opening" marca quem esta abrindo o chamado; se esse processo caiu (reinicio do servidor), a marca fica velha e outro retoma
    return (
      (await this.db.run(
        `UPDATE router_wifi_jobs SET fallback_state = 'opening', fallback_tries = fallback_tries + 1, updated_at = ?
          WHERE id = ? AND ticket_protocol IS NULL AND fallback_tries < 30 AND (fallback_state IS NULL OR (fallback_state = 'opening' AND updated_at < ?))`,
        [now.toISOString(), id, staleOpeningBefore.toISOString()]
      )) > 0
    );
  }

  async finishFallback(id: string, protocol: string) {
    await this.db.run("UPDATE router_wifi_jobs SET ticket_protocol = ?, fallback_state = 'done', fallback_enc = NULL WHERE id = ?", [protocol, id]);
  }

  async releaseFallback(id: string) {
    await this.db.run("UPDATE router_wifi_jobs SET fallback_state = NULL WHERE id = ? AND fallback_state = 'opening'", [id]);
  }

  async giveUpFallback(id: string) {
    await this.db.run("UPDATE router_wifi_jobs SET fallback_state = 'gave_up', fallback_enc = NULL WHERE id = ? AND ticket_protocol IS NULL", [id]);
  }

  async purgeFallbackBefore(before: Date) {
    const at = before.toISOString();
    await this.db.run("UPDATE router_wifi_jobs SET fallback_state = 'gave_up' WHERE fallback_enc IS NOT NULL AND ticket_protocol IS NULL AND (fallback_state IS NULL OR fallback_state = 'opening') AND created_at < ? AND state IN ('failed','unsupported','unconfirmed')", [at]);
    return this.db.run("UPDATE router_wifi_jobs SET fallback_enc = NULL WHERE fallback_enc IS NOT NULL AND created_at < ? AND state NOT IN ('pending','connecting','authenticating','updating','verifying')", [at]);
  }

  async failBySystem(id: string, errorCode: string, now: Date) {
    const at = now.toISOString();
    return (await this.db.run("UPDATE router_wifi_jobs SET state = 'failed', error_code = ?, secret_enc = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND state = 'pending'", [errorCode, at, at, id])) > 0;
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
