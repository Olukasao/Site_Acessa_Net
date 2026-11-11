import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { AppError } from "../errors.js";
import { safeEqual } from "../security/hash.js";
import { createFcmClient, maskToken, type PushSendFn } from "../push/fcmClient.js";
import { parseBody } from "./validation.js";

const bodySchema = z
  .object({
    customerId: z.string().trim().min(1).max(191),
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(200),
    conversationId: z.number().int().positive().optional()
  })
  .strict();

/** Um cliente nao recebe mais que isto por minuto (a chat-api avisa a cada mensagem do atendente). */
const RATE_PER_CUSTOMER = { limit: 6, windowMs: 60_000 };
const RATE_GLOBAL = { limit: 300, windowMs: 60_000 };

let senderOverride: PushSendFn | null = null;
/** So para testes: troca o envio real (FCM) por uma funcao falsa. */
export const setChatPushSender = (send: PushSendFn | null) => {
  senderOverride = send;
};

/**
 * Aviso no celular do cliente quando um atendente abre ou responde o chat. Quem chama e a acessanet-chat-api
 * (sistema a sistema, token proprio em CHAT_PUSH_TOKEN). Sem o token a rota nem existe. A chat-api so informa
 * QUEM avisar e o texto; os aparelhos vem do cadastro deste servidor, e o texto nunca leva dados do cliente.
 */
export async function registerChatPushRoutes(app: FastifyInstance, container: AppContainer) {
  const secret = container.config.chat.pushToken;
  if (!secret || secret.length < 32) return;

  let fcm: ReturnType<typeof createFcmClient> | null = null;
  const sender = (): { enabled: boolean; send: PushSendFn } => {
    if (senderOverride) return { enabled: true, send: senderOverride };
    fcm ??= createFcmClient({ log: app.log as never });
    return fcm;
  };

  app.post("/api/integracoes/atendimento/push", async (request, reply) => {
    const header = request.headers.authorization;
    const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !safeEqual(provided, secret)) {
      throw new AppError(401, "CHAT_PUSH_TOKEN_REQUIRED", "Token ausente ou invalido.");
    }

    const input = parseBody(bodySchema, request.body);
    await container.persistentLimiter.consume("chat_push:global", RATE_GLOBAL);
    await container.persistentLimiter.consume(`chat_push:customer:${input.customerId}`, RATE_PER_CUSTOMER);
    reply.header("Cache-Control", "no-store");

    const fcmClient = sender();
    if (!fcmClient.enabled) return { sent: 0, skipped: "push_disabled" };

    const devices = (await container.pushDevices.listActiveDevices()).filter((device) => device.customerId === input.customerId);
    let sent = 0;

    for (const device of devices) {
      let result: Awaited<ReturnType<PushSendFn>>;
      try {
        result = await fcmClient.send({
          token: device.token,
          title: input.title,
          body: input.body,
          data: { route: "/cliente/chamados", action: "chat", ...(input.conversationId ? { conversationId: String(input.conversationId) } : {}) },
          channelId: "chamados"
        });
      } catch {
        result = "retry";
      }

      if (result === "ok") sent += 1;
      else if (result === "invalid_token") {
        await container.pushDevices.disableToken(device.token);
        app.log.info({ tag: "CHAT_PUSH", token: maskToken(device.token) }, "[CHAT_PUSH] token invalido desativado");
      }
    }

    return { sent, devices: devices.length };
  });
}
