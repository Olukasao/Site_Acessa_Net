import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { AppError } from "../errors.js";
import { safeEqual } from "../security/hash.js";
import { parseQuery } from "./validation.js";

const query = z.object({
  period: z.enum(["today", "7d", "30d", "90d", "custom"]).default("30d"),
  from: z.string().optional(),
  to: z.string().optional()
});

const MAX_RANGE_DAYS = 366;
const CACHE_MS = 30_000;

function parseDate(value: string | undefined, fallback: Date) {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

export function marketingRange(input: z.infer<typeof query>, now = new Date()) {
  let to = now;
  let from = new Date(now);
  if (input.period === "custom") {
    to = parseDate(input.to, now);
    from = parseDate(input.from, new Date(to.getTime() - 30 * 86_400_000));
  } else if (input.period === "today") {
    from.setHours(0, 0, 0, 0);
    to = new Date(from);
    to.setDate(to.getDate() + 1);
  } else {
    from.setDate(from.getDate() - (input.period === "7d" ? 7 : input.period === "90d" ? 90 : 30));
  }
  if (from >= to) throw new AppError(400, "INVALID_RANGE", "O periodo informado e invalido.");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new AppError(400, "RANGE_TOO_LARGE", `O periodo maximo e de ${MAX_RANGE_DAYS} dias.`);
  return { from, to };
}

/**
 * Resumo agregado do site para a aba Marketing do Workspace (sistema a sistema, sem sessao de admin).
 * O chat interno consulta com um token proprio e repassa so aos usuarios autorizados.
 * Devolve apenas numeros e rotulos agregados: nenhum nome, CPF, e-mail ou telefone.
 * Sem MARKETING_FEED_TOKEN a rota nem existe.
 */
export async function registerMarketingFeedRoutes(app: FastifyInstance, container: AppContainer) {
  const token = container.config.marketingFeed.token;
  if (!token) return;

  const cache = new Map<string, { at: number; body: unknown }>();

  app.get("/api/integracoes/marketing/resumo", async (request, reply) => {
    const header = request.headers.authorization;
    const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !safeEqual(provided, token)) {
      throw new AppError(401, "FEED_TOKEN_REQUIRED", "Token ausente ou invalido.");
    }
    const input = parseQuery(query, request.query);
    const range = marketingRange(input);
    // Evita refazer dezenas de consultas quando varias telas pedem ao mesmo tempo.
    const key = `${input.period}|${input.period === "custom" ? `${range.from.toISOString()}|${range.to.toISOString()}` : ""}`;
    const hit = cache.get(key);
    reply.header("Cache-Control", "no-store");
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
    const overview = await container.centralActivityService.overview(range);
    const body = await container.marketingStats.summary(range, overview);
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 50) cache.clear();
    return body;
  });
}
