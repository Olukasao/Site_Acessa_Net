import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAuth } from "../auth/authenticate.js";
import { AppError } from "../errors.js";
import { safeEqual } from "../security/hash.js";
import { parseBody, parseQuery } from "../routes/validation.js";

const contractQuery = z.object({ contractId: z.string().trim().min(1).max(64) });
const changeBody = z
  .object({
    contractId: z.string().trim().min(1).max(64),
    newPassword: z.string().min(1).max(200),
    bands: z.array(z.enum(["2.4GHz", "5GHz"])).min(1).max(2),
    currentPassword: z.string().min(1).max(200)
  })
  .strict();
const claimBody = z.object({ agentId: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/), max: z.number().int().min(1).max(10).default(3) }).strict();
const jobParams = z.object({ jobId: z.string().uuid() });

/**
 * "Gerenciar meu Wi-Fi" na Central do Assinante.
 * - Cliente: so informa o CONTRATO (conferido contra a sessao). IP, porta, roteador e credenciais nunca vem do navegador.
 * - Agente interno (server/router-agent): busca as tarefas e devolve o resultado, com token proprio (ROUTER_AGENT_TOKEN).
 */
export async function registerRouterWifiRoutes(app: FastifyInstance, container: AppContainer) {
  const service = container.routerWifiService;

  app.get("/api/customer/wifi/status", async (request) => {
    const auth = requireAuth(request);
    const { contractId } = parseQuery(contractQuery, request.query);
    return service.status(auth.customerId, contractId);
  });

  app.get("/api/customer/wifi/networks", async (request) => {
    const auth = requireAuth(request);
    const { contractId } = parseQuery(contractQuery, request.query);
    return service.networks(auth.customerId, contractId);
  });

  app.post("/api/customer/wifi/password", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseBody(changeBody, request.body);
    const job = await service.changePassword({
      customerId: auth.customerId,
      cpfHash: auth.cpfHash,
      ip: request.ip,
      contractId: body.contractId,
      newPassword: body.newPassword,
      bands: body.bands,
      currentPassword: body.currentPassword
    });
    // Registro sem a senha: so o fato, o contrato e as redes.
    request.log.info({ tag: "ROUTER_WIFI", jobId: job.id, contractId: body.contractId, bands: body.bands }, "[ROUTER_WIFI] troca de senha pedida");
    await container.centralActivityService.safeRecordAuthenticated({
      auth,
      request,
      eventType: "CUSTOM",
      page: "internet",
      contractId: body.contractId,
      metadata: { action: "WIFI_PASSWORD_CHANGE", bands: body.bands.join(",") }
    });
    reply.code(202);
    return { job };
  });

  app.get("/api/customer/wifi/jobs/:jobId", async (request) => {
    const auth = requireAuth(request);
    const { jobId } = parseQuery(jobParams, request.params);
    return { job: await service.getJob(auth.customerId, jobId) };
  });

  const token = container.config.routerWifi.agentToken;
  if (!token || token.length < 32) return;

  const requireAgent = (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !safeEqual(provided, token)) throw new AppError(401, "ROUTER_AGENT_TOKEN_REQUIRED", "Token ausente ou invalido.");
  };

  app.post("/api/internal/router-agent/claim", async (request) => {
    requireAgent(request);
    const body = parseBody(claimBody, request.body ?? {});
    return { jobs: await service.claim(body.agentId, body.max) };
  });

  app.post("/api/internal/router-agent/jobs/:jobId", async (request) => {
    requireAgent(request);
    const { jobId } = parseQuery(jobParams, request.params);
    return service.report(jobId, request.body);
  });
}
