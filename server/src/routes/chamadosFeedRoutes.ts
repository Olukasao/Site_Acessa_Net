import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { AppError } from "../errors.js";
import { safeEqual } from "../security/hash.js";
import { parseParams, parseQuery } from "./validation.js";
import { marketingRange } from "./marketingFeedRoutes.js";

const listQuery = z.object({
  period: z.enum(["today", "7d", "30d", "90d", "custom"]).default("30d"),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["open", "scheduled", "in_progress", "closed"]).optional()
});
const protocolParams = z.object({ protocol: z.string().trim().min(1).max(60) });

/**
 * Chamados abertos pelo site (Central do Cliente), para a aba Chamados do Workspace
 * (sistema a sistema, mesmo token do feed de marketing). Diferente do resumo de
 * marketing: aqui VAI nome do cliente (o CPF continua mascarado) -- é uma lista de
 * atendimento para quem resolve os chamados, não um painel de visibilidade geral.
 * Por isso o chat interno restringe quem pode consultar (ver chamadosRoutes.js).
 * Sem MARKETING_FEED_TOKEN a rota nem existe.
 */
export async function registerChamadosFeedRoutes(app: FastifyInstance, container: AppContainer) {
  const token = container.config.marketingFeed.token;
  if (!token) return;
  const feedToken: string = token;

  function checkToken(request: { headers: { authorization?: string | undefined } }) {
    const header = request.headers.authorization;
    const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !safeEqual(provided, feedToken)) {
      throw new AppError(401, "FEED_TOKEN_REQUIRED", "Token ausente ou invalido.");
    }
  }

  app.get("/api/integracoes/marketing/chamados", async (request, reply) => {
    checkToken(request);
    const input = parseQuery(listQuery, request.query);
    const range = marketingRange(input);
    reply.header("Cache-Control", "no-store");
    return container.adminTicketService.listTickets({
      range,
      page: input.page,
      limit: input.limit,
      status: input.status,
      sort: "createdAt_desc"
    });
  });

  app.get("/api/integracoes/marketing/chamados/:protocol", async (request, reply) => {
    checkToken(request);
    const params = parseParams(protocolParams, request.params);
    reply.header("Cache-Control", "no-store");
    return container.adminTicketService.getDetail(params.protocol);
  });
}
