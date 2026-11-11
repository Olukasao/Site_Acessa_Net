import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAuth } from "../auth/authenticate.js";
import { AppError } from "../errors.js";
import { sha256 } from "../security/hash.js";
import { parseBody } from "./validation.js";

const bodySchema = z
  .object({
    contractId: z.string().trim().min(1).max(64).optional(),
    ticketId: z.string().trim().min(1).max(64).optional()
  })
  .strict();

const RATE_PER_CUSTOMER = { limit: 60, windowMs: 10 * 60_000 };
const RATE_PER_IP = { limit: 120, windowMs: 10 * 60_000 };

/**
 * Token do chat de atendimento. O cliente so recebe token para contratos da PROPRIA sessao, e o `ticketIds` (concessao
 * para a chat-api aceitar o chamado sem consultar o SGP de novo) so vai quando o chamado e mesmo do contrato dele.
 * Sem CHAT_TOKEN_SECRET a rota responde 503: o chat fica desligado e nada e emitido.
 */
export async function registerChatTokenRoutes(app: FastifyInstance, container: AppContainer) {
  app.post("/api/auth/chat-token", async (request) => {
    const auth = requireAuth(request);
    await container.persistentLimiter.consume(`chat_token:customer:${auth.customerId}`, RATE_PER_CUSTOMER);
    await container.persistentLimiter.consume(`chat_token:ip:${sha256(request.ip || "unknown")}`, RATE_PER_IP);

    if (!container.chatTokenService) {
      throw new AppError(503, "CHAT_NOT_CONFIGURED", "O chat de atendimento nao esta disponivel agora.");
    }

    const body = parseBody(bodySchema, request.body ?? {});
    const customer = container.store.getCustomer(auth.customerId);

    if (!customer) {
      throw new AppError(401, "AUTH_REQUIRED", "Sessao obrigatoria.");
    }

    const contracts = container.store.listContracts(auth.customerId);
    const contractId = body.contractId ?? (contracts.length === 1 ? contracts[0]?.id : undefined);

    if (!contractId) {
      throw new AppError(400, "CONTRACT_REQUIRED", "Informe o contrato para iniciar o chat.");
    }

    if (!contracts.some((contract) => contract.id === contractId)) {
      throw new AppError(403, "CONTRACT_FORBIDDEN", "Contrato nao pertence a sessao atual.");
    }

    let ticketIds: string[] | undefined;

    if (body.ticketId) {
      const ticket = await container.supportService.getTicket(auth.customerId, body.ticketId);

      if (!ticket || ticket.contractId !== contractId) {
        throw new AppError(403, "TICKET_FORBIDDEN", "Chamado nao pertence a sessao atual.");
      }

      ticketIds = [body.ticketId];
    }

    return container.chatTokenService.issueCustomerToken({ customer, contracts, contractId, ...(ticketIds ? { ticketIds } : {}) });
  });
}
