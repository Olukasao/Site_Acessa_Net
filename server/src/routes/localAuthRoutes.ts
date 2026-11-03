import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContainer } from "../container.js";
import { parseBody } from "./validation.js";

const documentFieldSchema = z
  .object({
    cpf: z.string().max(18).optional(),
    documento: z.string().max(18).optional(),
    document: z.string().max(18).optional()
  })
  .transform((body) => ({
    documento: body.documento ?? body.document ?? body.cpf ?? ""
  }));

/**
 * Primeiro acesso: so aceita o token de verificacao devolvido por /verify-reset-code (apos OTP valido enviado
 * por /first-access/request). "setupToken" ausente cai em 400 SETUP_TOKEN_REQUIRED (clientes antigos).
 */
const setupSchema = documentFieldSchema.and(
  z.object({
    setupToken: z.string().min(20).max(256).optional(),
    verificationToken: z.string().min(20).max(256).optional(),
    newPassword: z.string().min(1).max(128),
    confirmPassword: z.string().min(1).max(128).optional()
  })
);

const loginSchema = documentFieldSchema.and(
  z.object({
    password: z.string().min(1).max(128)
  })
);

const verifyResetCodeSchema = documentFieldSchema.and(
  z.object({
    code: z.string().min(6).max(6)
  })
);

const resetPasswordSchema = z.object({
  resetToken: z.string().min(20).max(256),
  newPassword: z.string().min(1).max(128),
  confirmPassword: z.string().min(1).max(128)
});

function clientIp(request: FastifyRequest) {
  return request.ip || "unknown";
}

function userAgent(request: FastifyRequest) {
  const value = request.headers["user-agent"];
  return Array.isArray(value) ? value[0] : value;
}

export async function registerLocalAuthRoutes(app: FastifyInstance, container: AppContainer) {
  app.post("/api/auth/local/check", async (request) => {
    const body = parseBody(documentFieldSchema, request.body);
    return container.localPasswordAuthService.checkAccess({ cpf: body.documento, ip: clientIp(request) });
  });

  /** Primeiro acesso, passo 1: envia o codigo (OTP) para o e-mail cadastrado no SGP. Nao revela se o CPF existe. */
  app.post("/api/auth/local/first-access/request", async (request) => {
    const body = parseBody(documentFieldSchema, request.body);
    return container.passwordResetService.requestFirstAccess({ cpf: body.documento, ip: clientIp(request) });
  });

  /** Primeiro acesso, passo 3: cria a senha com o token de verificacao. NAO devolve sessao -- o cliente faz login em seguida. */
  app.post("/api/auth/local/setup", async (request) => {
    const body = parseBody(setupSchema, request.body);
    return container.localPasswordAuthService.setupPassword({
      cpf: body.documento,
      setupToken: body.setupToken ?? body.verificationToken,
      newPassword: body.newPassword,
      confirmPassword: body.confirmPassword,
      ip: clientIp(request),
      userAgent: userAgent(request)
    });
  });

  app.post("/api/auth/local/login", async (request) => {
    const body = parseBody(loginSchema, request.body);
    const result = await container.localPasswordAuthService.login({
      cpf: body.documento,
      password: body.password,
      ip: clientIp(request),
      userAgent: userAgent(request)
    });
    const payload = container.localPasswordAuthService.tokens.verifyAccessToken(result.accessToken);
    const session = await container.authSessions.findById(payload.sessionId);
    await container.centralActivityService.safeRecordLogin({
      sessionId: payload.sessionId,
      customerId: payload.sub,
      cpfHash: session?.cpfHash ?? "",
      request,
      customerName: result.customer.name,
      cpfMasked: result.customer.maskedCpf,
      contractId: result.contracts[0]?.id,
      metadata: { contractsCount: result.contracts.length }
    });
    return result;
  });

  app.post("/api/auth/local/forgot-password", async (request) => {
    const body = parseBody(documentFieldSchema, request.body);
    return container.passwordResetService.requestReset({ cpf: body.documento, ip: clientIp(request) });
  });

  /**
   * Endpoint auxiliar so pra exibir o e-mail mascarado na Etapa 2 da tela.
   * Diferente de forgot-password, ESTE endpoint revela se o CPF/CNPJ existe (404
   * quando nao existe) -- e um trade-off deliberado entre a UX pedida
   * ("Enviamos um codigo para lu***@gmail.com") e anti-enumeracao total.
   * Mitigado por rate limit PROPRIO, por IP (6/10 min) e por CPF (5/h), ambos
   * com 429 (ver PasswordResetService.getMaskedEmail) -- antes este comentario
   * dizia isso mas nao existia limite nenhum. Se quiser anti-enumeracao total,
   * o frontend pode parar de chamar este endpoint e mostrar so uma frase
   * generica na Etapa 2.
   */
  app.post("/api/auth/local/forgot-password/masked-email", async (request) => {
    const body = parseBody(documentFieldSchema, request.body);
    return container.passwordResetService.getMaskedEmail({ cpf: body.documento, ip: clientIp(request) });
  });

  app.post("/api/auth/local/verify-reset-code", async (request) => {
    const body = parseBody(verifyResetCodeSchema, request.body);
    return container.passwordResetService.verifyCode({ cpf: body.documento, code: body.code, ip: clientIp(request) });
  });

  app.post("/api/auth/local/reset-password", async (request) => {
    const body = parseBody(resetPasswordSchema, request.body);
    await container.passwordResetService.resetPassword({
      resetToken: body.resetToken,
      newPassword: body.newPassword,
      confirmPassword: body.confirmPassword,
      ip: clientIp(request)
    });
    return { ok: true };
  });
}
