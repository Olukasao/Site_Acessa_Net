import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "mysql2/promise";

/**
 * Contador de janela fixa PERSISTIDO (sobrevive a reinicio do processo e e
 * compartilhado entre processos que usam o mesmo banco). Complementa o
 * InMemoryRateLimiter: o de memoria barra rajada por IP; este barra abuso
 * por CPF/CNPJ (chave = HMAC do documento, nunca o documento em claro).
 */
export interface PersistentRateRule {
  /** Maximo de eventos dentro da janela. O evento numero limit+1 ja e barrado. */
  limit: number;
  windowMs: number;
  /** Duracao do bloqueio apos estourar o limite. Default: ate o fim da janela. */
  cooldownMs?: number;
}

export interface PersistentRateOutcome {
  blocked: boolean;
  count: number;
  retryAfterSeconds: number;
}

export interface RateLimitRepository {
  /** Registra um evento na chave (incremento atomico) e diz se esta barrado. */
  hit(key: string, rule: PersistentRateRule, now?: Date): Promise<PersistentRateOutcome>;
  /** Consulta sem contar. */
  peek(key: string, now?: Date): Promise<PersistentRateOutcome>;
  reset(key: string): Promise<void>;
  /** Remove contadores ja vencidos (chamado de vez em quando). */
  prune(olderThan: Date): Promise<void>;
}

interface RateRow {
  hits: number;
  window_started_at: string;
  blocked_until: string | null;
}

function evaluate(row: RateRow | undefined, rule: PersistentRateRule | undefined, now: Date): PersistentRateOutcome {
  if (!row) return { blocked: false, count: 0, retryAfterSeconds: 0 };
  if (row.blocked_until) {
    const until = new Date(row.blocked_until).getTime();
    if (until > now.getTime()) {
      return { blocked: true, count: row.hits, retryAfterSeconds: Math.max(1, Math.ceil((until - now.getTime()) / 1000)) };
    }
  }
  return { blocked: false, count: row.hits, retryAfterSeconds: 0 };
}

/** Sync (node:sqlite) e single-process: o bloco ler+gravar abaixo nao tem await no meio, entao e atomico. */
export class SqliteRateLimitRepository implements RateLimitRepository {
  constructor(private readonly db: DatabaseSync) {}

  async hit(key: string, rule: PersistentRateRule, now = new Date()): Promise<PersistentRateOutcome> {
    const nowIso = now.toISOString();
    const expiredBefore = new Date(now.getTime() - rule.windowMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO rate_limit_counters (rl_key, hits, window_started_at, blocked_until) VALUES (?, 1, ?, NULL)
         ON CONFLICT(rl_key) DO UPDATE SET
           hits = CASE WHEN window_started_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?) THEN 1 ELSE hits + 1 END,
           blocked_until = CASE WHEN window_started_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?) THEN NULL ELSE blocked_until END,
           window_started_at = CASE WHEN window_started_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?) THEN ? ELSE window_started_at END`
      )
      .run(key, nowIso, expiredBefore, nowIso, expiredBefore, nowIso, expiredBefore, nowIso, nowIso);

    let row = this.db.prepare("SELECT hits, window_started_at, blocked_until FROM rate_limit_counters WHERE rl_key = ?").get(key) as
      | RateRow
      | undefined;
    if (row && row.hits > rule.limit && !(row.blocked_until && new Date(row.blocked_until) > now)) {
      const windowEnd = new Date(row.window_started_at).getTime() + rule.windowMs;
      const until = new Date(Math.max(rule.cooldownMs !== undefined ? now.getTime() + rule.cooldownMs : windowEnd, now.getTime() + 1000)).toISOString();
      this.db.prepare("UPDATE rate_limit_counters SET blocked_until = ? WHERE rl_key = ?").run(until, key);
      row = { ...row, blocked_until: until };
    }
    return evaluate(row, rule, now);
  }

  async peek(key: string, now = new Date()): Promise<PersistentRateOutcome> {
    const row = this.db.prepare("SELECT hits, window_started_at, blocked_until FROM rate_limit_counters WHERE rl_key = ?").get(key) as
      | RateRow
      | undefined;
    return evaluate(row, undefined, now);
  }

  async reset(key: string): Promise<void> {
    this.db.prepare("DELETE FROM rate_limit_counters WHERE rl_key = ?").run(key);
  }

  async prune(olderThan: Date): Promise<void> {
    const iso = olderThan.toISOString();
    this.db
      .prepare("DELETE FROM rate_limit_counters WHERE window_started_at < ? AND (blocked_until IS NULL OR blocked_until < ?)")
      .run(iso, iso);
  }
}

export class MysqlRateLimitRepository implements RateLimitRepository {
  constructor(private readonly pool: Pool) {}

  async hit(key: string, rule: PersistentRateRule, now = new Date()): Promise<PersistentRateOutcome> {
    const nowIso = now.toISOString();
    const expiredBefore = new Date(now.getTime() - rule.windowMs).toISOString();
    // O MySQL avalia as atribuicoes da esquerda p/ direita usando os valores JA atualizados: window_started_at fica por ultimo.
    await this.pool.execute(
      `INSERT INTO rate_limit_counters (rl_key, hits, window_started_at, blocked_until) VALUES (?, 1, ?, NULL)
       ON DUPLICATE KEY UPDATE
         hits = IF(window_started_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?), 1, hits + 1),
         blocked_until = IF(window_started_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?), NULL, blocked_until),
         window_started_at = IF(window_started_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?), ?, window_started_at)`,
      [key, nowIso, expiredBefore, nowIso, expiredBefore, nowIso, expiredBefore, nowIso, nowIso]
    );
    const [rows] = await this.pool.execute(
      "SELECT hits, window_started_at, blocked_until FROM rate_limit_counters WHERE rl_key = ?",
      [key]
    );
    let row = (rows as RateRow[])[0];
    if (row && row.hits > rule.limit && !(row.blocked_until && new Date(row.blocked_until) > now)) {
      const windowEnd = new Date(row.window_started_at).getTime() + rule.windowMs;
      const until = new Date(Math.max(rule.cooldownMs !== undefined ? now.getTime() + rule.cooldownMs : windowEnd, now.getTime() + 1000)).toISOString();
      await this.pool.execute("UPDATE rate_limit_counters SET blocked_until = ? WHERE rl_key = ?", [until, key]);
      row = { ...row, blocked_until: until };
    }
    return evaluate(row, rule, now);
  }

  async peek(key: string, now = new Date()): Promise<PersistentRateOutcome> {
    const [rows] = await this.pool.execute(
      "SELECT hits, window_started_at, blocked_until FROM rate_limit_counters WHERE rl_key = ?",
      [key]
    );
    return evaluate((rows as RateRow[])[0], undefined, now);
  }

  async reset(key: string): Promise<void> {
    await this.pool.execute("DELETE FROM rate_limit_counters WHERE rl_key = ?", [key]);
  }

  async prune(olderThan: Date): Promise<void> {
    const iso = olderThan.toISOString();
    await this.pool.execute(
      "DELETE FROM rate_limit_counters WHERE window_started_at < ? AND (blocked_until IS NULL OR blocked_until < ?)",
      [iso, iso]
    );
  }
}
