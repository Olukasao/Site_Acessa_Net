import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { hashPassword, hmacSha256, randomId, randomOtp, randomToken, safeEqual, sha256 } from "../security/hash.js";
import { isValidDocument, maskDocument, normalizeDocument } from "./cpf.js";
import { validateNewPassword } from "./passwordPolicy.js";
import type { InMemoryRateLimiter } from "./rateLimiter.js";
import { PersistentRateLimiter } from "./persistentRateLimiter.js";
import type { CpfResolverResult } from "./cpfResolver.js";
import type { AuthProfileRepository } from "../repositories/authProfileRepository.js";
import type { SessionRepository } from "../repositories/sessionRepository.js";
import type { PasswordResetRepository, PasswordResetRequestRecord } from "../repositories/passwordResetRepository.js";
import type { AuditLogRepository, AuthFailureReason } from "../repositories/auditLogRepository.js";
import type { Mailer } from "../email/mailer.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const REQUEST_RULE = { limit: 5, windowMs: 15 * 60 * 1000, cooldownMs: 60_000 };
const VERIFY_RULE = { limit: 10, windowMs: 15 * 60 * 1000, cooldownMs: 60_000 };

/** Teto de pedidos de OTP por CPF (persistido): vale para "esqueci a senha" E "primeiro acesso" -- protege a caixa de e-mail do titular. */
const OTP_REQUEST_PER_CPF_RULE = { limit: 5, windowMs: 60 * 60 * 1000 };
/** Tentativas de verificar codigo por CPF/hora, somando todos os codigos emitidos (5 codigos x 5 tentativas = 25 no maximo). */
const OTP_VERIFY_PER_CPF_RULE = { limit: 30, windowMs: 60 * 60 * 1000, cooldownMs: 15 * 60 * 1000 };
/** Consulta de e-mail mascarado: barata para o atacante e cara para o SGP -- limite bem mais apertado que o resto. */
const MASKED_EMAIL_IP_RULE = { limit: 6, windowMs: 10 * 60 * 1000, cooldownMs: 10 * 60 * 1000 };
const MASKED_EMAIL_CPF_RULE = { limit: 5, windowMs: 60 * 60 * 1000 };
const FIRST_ACCESS_IP_RULE = { limit: 6, windowMs: 10 * 60 * 1000, cooldownMs: 10 * 60 * 1000 };
/** Validade do token de verificacao de primeiro acesso = a do reset_token (10 min), uso unico. */

const NO_EMAIL_MESSAGE =
  "Não conseguimos enviar o código de verificação por e-mail. Fale com o nosso suporte pelo WhatsApp para atualizar o seu cadastro e liberar o primeiro acesso.";

const GENERIC_SENT_MESSAGE = "Se os dados informados estiverem cadastrados, enviaremos as instruções de recuperação.";
const GENERIC_CODE_INVALID_MESSAGE = "Código inválido.";
const GENERIC_UNAVAILABLE_MESSAGE = "Não foi possível concluir agora. Tente novamente em alguns instantes.";

/** Mesma senha inicial generica bloqueada pelo fluxo de primeiro acesso (ver localPasswordAuthService.ts). */
const GENERIC_INITIAL_PASSWORD = "acessanet";

export interface MaskedEmailResult {
  maskedEmail: string;
}

/**
 * Resultado do pedido de codigo de PRIMEIRO ACESSO.
 *  - sent: codigo enviado (ou ja enviado ha menos de 60s) para o e-mail mascarado.
 *  - has_password: este documento ja tem senha -- o cliente deve fazer login (ou "esqueci a senha").
 *  - unavailable: nao foi possivel enviar codigo -- documento nao encontrado, cliente sem e-mail no cadastro,
 *    ou falha de envio. MESMA resposta nos tres casos (nao revela qual), orientando o contato com o suporte.
 */
export type FirstAccessRequestResult =
  | { status: "sent"; maskedEmail: string }
  | { status: "has_password"; message: string }
  | { status: "unavailable"; message: string };

/**
 * Fluxo "esqueci minha senha": CPF/CNPJ -> OTP por e-mail -> reset_token -> nova
 * senha. Nunca revela se um documento existe (mensagem generica sempre igual) e
 * nunca usa um e-mail vindo do frontend -- o e-mail e sempre resolvido no
 * backend a partir do CPF/CNPJ, via SGP (ver auth/cpfResolver.ts).
 */
export class PasswordResetService {
  constructor(
    private readonly config: AppConfig,
    private readonly cpfResolver: { resolve: (cpf: string) => Promise<CpfResolverResult | null> },
    private readonly authProfiles: AuthProfileRepository,
    private readonly sessions: SessionRepository,
    private readonly passwordResets: PasswordResetRepository,
    private readonly mailer: Mailer,
    private readonly auditLog: AuditLogRepository,
    private readonly rateLimiter: InMemoryRateLimiter,
    /** Limites por CPF com contador persistido. Omitido (testes) = apenas em memoria. */
    private readonly persistentLimiter: PersistentRateLimiter = new PersistentRateLimiter()
  ) {}

  private cpfHash(digits: string) {
    return hmacSha256(digits, this.config.cpfHashSecret);
  }

  private otpHash(code: string) {
    return hmacSha256(code, this.config.otpHashSecret);
  }

  private ipHash(ip: string) {
    return sha256(ip || "unknown");
  }

  /**
   * Passo 1: sempre devolve a mesma mensagem generica, exista ou nao o CPF/CNPJ,
   * tenha ou nao e-mail cadastrado, esteja ou nao em cooldown -- so isso
   * evita enumeracao de clientes. So dispara e-mail de verdade quando o documento
   * resolve no SGP, tem e-mail cadastrado e o cooldown de 60s ja passou.
   */
  async requestReset(input: { cpf: string; ip: string }): Promise<{ message: string }> {
    const digits = normalizeDocument(input.cpf);
    this.rateLimiter.consume(`password_reset_request:ip:${input.ip}`, REQUEST_RULE);

    if (!isValidDocument(digits)) {
      return { message: GENERIC_SENT_MESSAGE };
    }

    const cpfHash = this.cpfHash(digits);
    const ipHash = this.ipHash(input.ip);
    const maskedCpf = maskDocument(digits);

    // Teto por CPF (persistido). Estourou: mesma resposta generica, sem enviar nada nem consultar o SGP.
    if (!(await this.withinOtpRequestCap(cpfHash))) {
      return { message: GENERIC_SENT_MESSAGE };
    }

    let resolved: CpfResolverResult | null;
    try {
      resolved = await this.cpfResolver.resolve(digits);
    } catch {
      return { message: GENERIC_SENT_MESSAGE };
    }

    if (!resolved || !resolved.customer.email) {
      return { message: GENERIC_SENT_MESSAGE };
    }

    const latest = await this.passwordResets.findLatestByCpfHash(cpfHash);
    if (latest && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      return { message: GENERIC_SENT_MESSAGE };
    }

    const code = randomOtp();
    const request = await this.passwordResets.createRequest({
      id: randomId("pwreset"),
      cpfHash,
      otpHash: this.otpHash(code),
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      ipHash
    });

    try {
      await this.mailer.sendOtpEmail({ to: resolved.customer.email, name: resolved.customer.name, code });
    } catch {
      await this.passwordResets.markOtpUsed(request.id, new Date());
      await this.auditLog.record({
        eventType: "PASSWORD_RESET_REQUESTED",
        customerId: resolved.customer.id,
        cpfHash,
        cpfMasked: maskedCpf,
        ipHash,
        status: "FAILED",
        failureReason: "EMAIL_SEND_FAILED"
      });
      return { message: GENERIC_SENT_MESSAGE };
    }

    await this.auditLog.record({
      eventType: "PASSWORD_RESET_REQUESTED",
      customerId: resolved.customer.id,
      cpfHash,
      cpfMasked: maskedCpf,
      ipHash,
      status: "SUCCESS"
    });

    return { message: GENERIC_SENT_MESSAGE };
  }

  /**
   * Teto de pedidos de OTP por CPF na janela. true = pode seguir. Conta TODO pedido (inclusive de CPF que nao
   * existe) para nao virar oraculo de "este CPF e cliente". Trade-off: quem sabe o CPF de outra pessoa consegue
   * esgotar o teto dela por 1h (negacao do "esqueci a senha" dela) -- aceito: o dano e so esperar a janela.
   */
  private async withinOtpRequestCap(cpfHash: string): Promise<boolean> {
    try {
      await this.persistentLimiter.consume(`otp_request:cpf:${cpfHash}`, OTP_REQUEST_PER_CPF_RULE);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === "RATE_LIMITED") return false;
      throw error;
    }
  }

  /**
   * Devolve o e-mail mascarado pro passo 2 da tela, sem nunca expor o endereco completo.
   * ATENCAO (trade-off deliberado, UX "Enviamos um codigo para lu***@gmail.com"): este endpoint DISTINGUE
   * documento inexistente (404) de existente. Mitigacao: limite por IP (6/10min) e por CPF (5/h), ambos
   * 429, o primeiro persistido junto com o do CPF; consultas ao SGP com cache, fan-out minimo e teto global.
   * O fluxo de primeiro acesso NAO usa este endpoint (a resposta de requestFirstAccess ja traz o e-mail
   * mascarado e nao distingue inexistente de sem e-mail).
   */
  async getMaskedEmail(input: { cpf: string; ip: string }): Promise<MaskedEmailResult> {
    const digits = normalizeDocument(input.cpf);
    this.rateLimiter.consume(`masked_email:ip:${input.ip}`, MASKED_EMAIL_IP_RULE);
    await this.persistentLimiter.consume(`masked_email:ip:${this.ipHash(input.ip)}`, MASKED_EMAIL_IP_RULE);

    if (!isValidDocument(digits)) {
      throw new AppError(404, "CUSTOMER_NOT_FOUND", "Não encontramos um cliente com os dados informados.");
    }

    await this.persistentLimiter.consume(`masked_email:cpf:${this.cpfHash(digits)}`, MASKED_EMAIL_CPF_RULE);

    let resolved: CpfResolverResult | null;
    try {
      resolved = await this.cpfResolver.resolve(digits);
    } catch {
      throw new AppError(502, "SGP_UNAVAILABLE", GENERIC_UNAVAILABLE_MESSAGE);
    }

    if (!resolved || !resolved.customer.maskedEmail) {
      throw new AppError(404, "CUSTOMER_NOT_FOUND", "Não encontramos um cliente com os dados informados.");
    }

    return { maskedEmail: resolved.customer.maskedEmail };
  }

  /**
   * PRIMEIRO ACESSO, passo 1: prova de posse. Envia o OTP de 6 digitos para o e-mail cadastrado no SGP (o MESMO
   * mecanismo do "esqueci a senha": validade 10 min, 5 tentativas, cooldown 60s, teto 5/h por CPF). O passo 2 e
   * verifyCode (devolve um token de uso unico) e o passo 3 e LocalPasswordAuthService.setupPassword.
   * Nunca usa e-mail vindo do cliente e nunca devolve sessao.
   */
  async requestFirstAccess(input: { cpf: string; ip: string }): Promise<FirstAccessRequestResult> {
    const digits = normalizeDocument(input.cpf);
    this.rateLimiter.consume(`first_access_request:ip:${input.ip}`, FIRST_ACCESS_IP_RULE);
    await this.persistentLimiter.consume(`first_access_request:ip:${this.ipHash(input.ip)}`, FIRST_ACCESS_IP_RULE);

    const unavailable: FirstAccessRequestResult = { status: "unavailable", message: NO_EMAIL_MESSAGE };
    if (!isValidDocument(digits)) {
      return unavailable;
    }

    const cpfHash = this.cpfHash(digits);
    const ipHash = this.ipHash(input.ip);
    const maskedCpf = maskDocument(digits);

    // Local, sem SGP: quem ja tem senha nao precisa de primeiro acesso (e nao recebe e-mail por isso).
    const profile = await this.authProfiles.findByCpfHash(cpfHash);
    if (profile?.passwordHash) {
      return { status: "has_password", message: "Este CPF ou CNPJ já tem senha cadastrada. Faça login ou use \"Esqueci minha senha\"." };
    }

    if (!(await this.withinOtpRequestCap(cpfHash))) {
      throw new AppError(429, "RATE_LIMITED", "Muitos códigos solicitados. Aguarde alguns minutos e tente novamente.");
    }

    let resolved: CpfResolverResult | null;
    try {
      resolved = await this.cpfResolver.resolve(digits);
    } catch {
      throw new AppError(502, "SGP_UNAVAILABLE", GENERIC_UNAVAILABLE_MESSAGE);
    }

    if (!resolved || !resolved.customer.email) {
      await this.auditLog.record({
        eventType: "PASSWORD_RESET_REQUESTED",
        customerId: resolved?.customer.id,
        cpfHash,
        cpfMasked: maskedCpf,
        ipHash,
        status: "FAILED",
        failureReason: resolved ? "EMAIL_UNAVAILABLE" : "CUSTOMER_NOT_FOUND"
      });
      return unavailable;
    }

    const maskedEmail = resolved.customer.maskedEmail ?? "";
    const latest = await this.passwordResets.findLatestByCpfHash(cpfHash);
    if (latest && !latest.otpUsedAt && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      return { status: "sent", maskedEmail };
    }

    const code = randomOtp();
    const request = await this.passwordResets.createRequest({
      id: randomId("pwreset"),
      cpfHash,
      otpHash: this.otpHash(code),
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      ipHash
    });

    try {
      await this.mailer.sendOtpEmail({ to: resolved.customer.email, name: resolved.customer.name, code });
    } catch {
      await this.passwordResets.markOtpUsed(request.id, new Date());
      await this.auditLog.record({
        eventType: "PASSWORD_RESET_REQUESTED",
        customerId: resolved.customer.id,
        cpfHash,
        cpfMasked: maskedCpf,
        ipHash,
        status: "FAILED",
        failureReason: "EMAIL_SEND_FAILED"
      });
      return unavailable;
    }

    await this.auditLog.record({
      eventType: "PASSWORD_RESET_REQUESTED",
      customerId: resolved.customer.id,
      cpfHash,
      cpfMasked: maskedCpf,
      ipHash,
      status: "SUCCESS"
    });

    return { status: "sent", maskedEmail };
  }

  /** Passo 2: valida o codigo e devolve um reset_token de uso unico (10 min) para o passo 3. */
  async verifyCode(input: { cpf: string; code: string; ip: string }): Promise<{ resetToken: string }> {
    const digits = normalizeDocument(input.cpf);
    this.rateLimiter.consume(`password_reset_verify:ip:${input.ip}`, VERIFY_RULE);

    if (!isValidDocument(digits)) {
      throw new AppError(400, "CODE_INVALID", GENERIC_CODE_INVALID_MESSAGE);
    }

    const cpfHash = this.cpfHash(digits);
    const ipHash = this.ipHash(input.ip);
    const maskedCpf = maskDocument(digits);

    await this.persistentLimiter.consume(`otp_verify:cpf:${cpfHash}`, OTP_VERIFY_PER_CPF_RULE);

    const request = await this.passwordResets.findActiveByCpfHash(cpfHash);
    if (!request) {
      await this.registerVerifyFailure(cpfHash, maskedCpf, ipHash, "OTP_NOT_FOUND");
      throw new AppError(400, "CODE_INVALID", GENERIC_CODE_INVALID_MESSAGE);
    }

    if (request.otpExpiresAt.getTime() <= Date.now()) {
      await this.passwordResets.markOtpUsed(request.id, new Date());
      await this.registerVerifyFailure(cpfHash, maskedCpf, ipHash, "OTP_EXPIRED");
      throw new AppError(400, "CODE_EXPIRED", "Código expirado. Solicite um novo código.");
    }

    if (request.otpAttempts >= OTP_MAX_ATTEMPTS) {
      await this.passwordResets.markOtpUsed(request.id, new Date());
      await this.registerVerifyFailure(cpfHash, maskedCpf, ipHash, "OTP_ATTEMPTS_EXCEEDED");
      throw new AppError(400, "TOO_MANY_ATTEMPTS", "Muitas tentativas. Solicite um novo código.");
    }

    // Reserva a tentativa ANTES de comparar, de forma atomica (UPDATE ... WHERE otp_attempts < 5): requisicoes
    // paralelas nao conseguem testar mais de 5 chutes por codigo.
    const attempts = await this.passwordResets.incrementOtpAttempts(request.id, OTP_MAX_ATTEMPTS);
    if (attempts === null) {
      await this.passwordResets.markOtpUsed(request.id, new Date());
      await this.registerVerifyFailure(cpfHash, maskedCpf, ipHash, "OTP_ATTEMPTS_EXCEEDED");
      throw new AppError(400, "TOO_MANY_ATTEMPTS", "Muitas tentativas. Solicite um novo código.");
    }

    const providedHash = this.otpHash(input.code.trim());
    const isMatch = safeEqual(providedHash, request.otpHash);

    if (!isMatch) {
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await this.passwordResets.markOtpUsed(request.id, new Date());
        await this.registerVerifyFailure(cpfHash, maskedCpf, ipHash, "OTP_ATTEMPTS_EXCEEDED");
        throw new AppError(400, "TOO_MANY_ATTEMPTS", "Muitas tentativas. Solicite um novo código.");
      }
      await this.registerVerifyFailure(cpfHash, maskedCpf, ipHash, "OTP_INVALID");
      throw new AppError(400, "CODE_INVALID", GENERIC_CODE_INVALID_MESSAGE);
    }

    const resetToken = randomToken();
    const resetTokenHash = sha256(resetToken);
    await this.passwordResets.setResetToken(request.id, resetTokenHash, new Date(Date.now() + RESET_TOKEN_TTL_MS));
    await this.passwordResets.markOtpUsed(request.id, new Date());

    await this.auditLog.record({
      eventType: "PASSWORD_RESET_CODE_VERIFIED",
      cpfHash,
      cpfMasked: maskedCpf,
      ipHash,
      status: "SUCCESS"
    });

    return { resetToken };
  }

  /** Passo 3: troca a senha usando o reset_token (uso unico, 10 min), invalida outras sessoes do cliente. */
  async resetPassword(input: { resetToken: string; newPassword: string; confirmPassword: string; ip: string }): Promise<void> {
    const ipHash = this.ipHash(input.ip);

    if (input.newPassword !== input.confirmPassword) {
      throw new AppError(400, "VALIDATION_ERROR", "As senhas não coincidem.");
    }

    const resetTokenHash = sha256(input.resetToken);
    const request = await this.passwordResets.findByResetTokenHash(resetTokenHash);

    if (!request || !request.resetTokenExpiresAt || request.resetTokenUsedAt) {
      await this.auditLog.record({
        eventType: "PASSWORD_RESET_COMPLETED",
        ipHash,
        status: "FAILED",
        failureReason: "RESET_TOKEN_INVALID"
      });
      throw new AppError(400, "RESET_TOKEN_INVALID", "Não foi possível redefinir a senha. Solicite a recuperação novamente.");
    }

    if (request.resetTokenExpiresAt.getTime() <= Date.now()) {
      await this.auditLog.record({
        eventType: "PASSWORD_RESET_COMPLETED",
        cpfHash: request.cpfHash,
        ipHash,
        status: "FAILED",
        failureReason: "RESET_TOKEN_EXPIRED"
      });
      throw new AppError(400, "RESET_TOKEN_EXPIRED", "Sessão de redefinição expirada. Solicite a recuperação novamente.");
    }

    validateNewPassword(input.newPassword, { initialPassword: GENERIC_INITIAL_PASSWORD });

    const profile = await this.authProfiles.getOrCreate({
      cpfHash: request.cpfHash,
      cpfLastDigits: "",
      sgpCustomerId: null
    });

    const passwordHash = await hashPassword(input.newPassword);
    const now = new Date();
    // Consumo atomico do token: duas requisicoes simultaneas com o mesmo token nao passam as duas.
    if (!(await this.passwordResets.claimResetToken(request.id, now))) {
      throw new AppError(400, "RESET_TOKEN_INVALID", "Não foi possível redefinir a senha. Solicite a recuperação novamente.");
    }
    await this.authProfiles.setPasswordHash(request.cpfHash, passwordHash, now);
    await this.sessions.revokeAllForCpfHash(request.cpfHash, now);

    await this.auditLog.record({
      eventType: "PASSWORD_RESET_COMPLETED",
      customerId: profile.sgpCustomerId ?? undefined,
      cpfHash: request.cpfHash,
      ipHash,
      status: "SUCCESS"
    });
  }

  private async registerVerifyFailure(cpfHash: string, cpfMasked: string, ipHash: string, reason: AuthFailureReason) {
    await this.auditLog.record({
      eventType: "PASSWORD_RESET_CODE_VERIFIED",
      cpfHash,
      cpfMasked,
      ipHash,
      status: "FAILED",
      failureReason: reason
    });
  }
}
