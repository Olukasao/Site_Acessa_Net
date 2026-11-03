import { AppError } from "../errors.js";
import { InMemoryRateLimiter } from "./rateLimiter.js";
import type { PersistentRateRule, RateLimitRepository } from "../repositories/rateLimitRepository.js";

const RATE_MESSAGE = "Muitas tentativas foram realizadas. Aguarde alguns minutos e tente novamente.";

/**
 * Limite por chave (tipicamente por CPF) com contador gravado no banco.
 * Sem repositorio (testes unitarios) cai num limitador em memoria; se o banco
 * falhar em runtime, tambem cai pro de memoria (fail-open controlado -- o
 * login nao pode ficar fora do ar porque a tabela de contadores deu erro).
 */
export class PersistentRateLimiter {
  private readonly fallback = new InMemoryRateLimiter();
  private sincePrune = 0;

  constructor(private readonly repo?: RateLimitRepository) {}

  private tooMany(retryAfterSeconds: number): never {
    throw new AppError(429, "RATE_LIMITED", RATE_MESSAGE, { retryAfterSeconds });
  }

  /** Conta um evento e barra (429) quando o limite estoura ou a chave esta em bloqueio. */
  async consume(key: string, rule: PersistentRateRule): Promise<void> {
    if (this.repo) {
      try {
        const outcome = await this.repo.hit(key, rule);
        this.maybePrune();
        if (outcome.blocked) this.tooMany(outcome.retryAfterSeconds);
        return;
      } catch (error) {
        if (error instanceof AppError) throw error;
      }
    }
    this.fallback.consume(key, { limit: rule.limit, windowMs: rule.windowMs, cooldownMs: rule.cooldownMs ?? rule.windowMs });
  }

  /** Conta um evento SEM barrar este (usado para contar falhas; o bloqueio vale na proxima checagem). */
  async record(key: string, rule: PersistentRateRule): Promise<void> {
    try {
      await this.consume(key, rule);
    } catch (error) {
      if (!(error instanceof AppError && error.code === "RATE_LIMITED")) throw error;
    }
  }

  /** Barra se a chave ja esta bloqueada, sem contar. */
  async assertNotBlocked(key: string): Promise<void> {
    if (!this.repo) return;
    try {
      const outcome = await this.repo.peek(key);
      if (outcome.blocked) this.tooMany(outcome.retryAfterSeconds);
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
  }

  async reset(key: string): Promise<void> {
    this.fallback.forget(key);
    try {
      await this.repo?.reset(key);
    } catch {
      /* ignora */
    }
  }

  private maybePrune() {
    this.sincePrune += 1;
    if (this.sincePrune < 500 || !this.repo) return;
    this.sincePrune = 0;
    void this.repo.prune(new Date(Date.now() - 24 * 60 * 60 * 1000)).catch(() => undefined);
  }
}
