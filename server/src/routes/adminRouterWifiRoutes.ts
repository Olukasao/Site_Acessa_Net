import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAdminPermission } from "../auth/adminAuthenticate.js";
import { parseQuery } from "./validation.js";

const overviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  vendor: z.string().trim().max(32).optional(),
  state: z.enum(["pending", "connecting", "authenticating", "updating", "verifying", "completed", "failed", "unsupported", "unconfirmed"]).optional()
});

/** Painel "Roteadores / Wi-Fi": pedidos, taxa de sucesso por modelo, falhas, tempo medio, agente e inventario. So leitura. */
export async function registerAdminRouterWifiRoutes(app: FastifyInstance, container: AppContainer) {
  app.get("/admin/api/roteadores", async (request) => {
    const query = parseQuery(overviewQuery, request.query);
    requireAdminPermission(request, "roteadores.read");
    return container.routerWifiService.adminOverview(query.days, { vendor: query.vendor, state: query.state });
  });
}
