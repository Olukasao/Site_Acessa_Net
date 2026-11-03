import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { requireAuth } from "../auth/authenticate.js";
import { OwnershipService } from "../security/ownership.js";
import { sha256 } from "../security/hash.js";
import { parseBody } from "./validation.js";

const tokenSchema = z
  .string()
  .min(20)
  .max(4096)
  .regex(/^\S+$/, "Token invalido.");

const registerSchema = z.object({
  token: tokenSchema,
  platform: z.literal("android"),
  appVersion: z.string().trim().min(1).max(64).optional(),
  contractIds: z.array(z.string().trim().regex(/^\d{1,20}$/)).max(20).optional()
});

const removeSchema = z.object({ token: tokenSchema });

const RATE_PER_CUSTOMER = { limit: 20, windowMs: 10 * 60_000 };
const RATE_PER_IP = { limit: 60, windowMs: 10 * 60_000 };

export async function registerPushRoutes(app: FastifyInstance, container: AppContainer) {
  const ownership = new OwnershipService(container.store, container.sgpClient);

  async function limit(request: Parameters<typeof requireAuth>[0], customerId: string) {
    await container.persistentLimiter.consume(`push_device:customer:${customerId}`, RATE_PER_CUSTOMER);
    await container.persistentLimiter.consume(`push_device:ip:${sha256(request.ip || "unknown")}`, RATE_PER_IP);
  }

  app.post("/v1/push/devices", async (request) => {
    const auth = requireAuth(request);
    await limit(request, auth.customerId);
    const body = parseBody(registerSchema, request.body);

    let contractIds: string[] | undefined;
    if (body.contractIds) {
      contractIds = [];
      for (const contractId of new Set(body.contractIds)) {
        try {
          await ownership.assertContract(auth.customerId, contractId);
          contractIds.push(contractId);
        } catch {
          // contrato de outro cliente (ou nao verificavel): ignorado em silencio.
        }
      }
    } else {
      contractIds = container.store
        .listContracts(auth.customerId)
        .map((contract) => contract.id)
        .filter((id) => /^\d+$/.test(id));
    }

    await container.pushDevices.upsertDevice({
      customerId: auth.customerId,
      token: body.token,
      platform: body.platform,
      appVersion: body.appVersion,
      contractIds
    });
    return { ok: true };
  });

  app.delete("/v1/push/devices", async (request) => {
    const auth = requireAuth(request);
    await limit(request, auth.customerId);
    const body = parseBody(removeSchema, request.body);
    await container.pushDevices.disableForCustomer(auth.customerId, body.token);
    return { ok: true };
  });
}
