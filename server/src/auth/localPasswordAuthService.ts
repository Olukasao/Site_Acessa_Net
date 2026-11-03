import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { hashPassword, verifyPassword, hmacSha256, randomId, sha256 } from "../security/hash.js";
import { isValidDocument, maskDocument, normalizeDocument } from "./cpf.js";
import { validateNewPassword } from "./passwordPolicy.js";
import { TokenService } from "./tokenService.js";
import type { InMemoryRateLimiter } from "./rateLimiter.js";
import { PersistentRateLimiter } from "./persistentRateLimiter.js";
import type { PasswordResetRepository } from "../repositories/passwordResetRepository.js";
import type { CpfResolverResult } from "./cpfResolver.js";
import type { AuthProfileRepository } from "../repositories/authProfileRepository.js";
import type { SessionRepository } from "../repositories/sessionRepository.js";
import type { LoginAttemptRepository, LoginAttemptRule } from "../repositories/loginAttemptRepository.js";
import type { AuditLogRepository, AuthFailureReason } from "../repositories/auditLogRepository.js";

const CHECK_RULE: LoginAttemptRule = { maxAttempts: 15, windowMs: 10 * 60 * 1000, softDelayStartAt: 8 };
const LOGIN_RULE: LoginAttemptRule = { maxAttempts: 5, windowMs: 10 * 60 * 1000, softDelayStartAt: 3 };
const SETUP_RULE: LoginAttemptRule = { maxAttempts: 5, windowMs: 15 * 60 * 1000, softDelayStartAt: 3 };

/**
 * Limites POR CPF/CNPJ, com contador persistido (sobrevivem a reinicio e valem de qualquer IP). Chave = HMAC do
 * documento. Trade-off conhecido: quem sabe o CPF de outra pessoa consegue gastar o teto dela e atrapalhar o
 * login dela por alguns minutos (negacao de servico localizada) -- aceito em troca de barrar chute distribuido
 * de senha; por isso o bloqueio de falhas e curto (15 min) e os tetos de uso normal sao folgados.
 */
const CHECK_CPF_RULE = { limit: 30, windowMs: 15 * 60 * 1000, cooldownMs: 5 * 60 * 1000 };
const LOGIN_CPF_RULE = { limit: 40, windowMs: 15 * 60 * 1000, cooldownMs: 5 * 60 * 1000 };
/** Falhas de senha por CPF, independente de IP: a 20a falha na hora bloqueia por 15 min (limit 19 = bloqueia ao exceder) (cada nova falha apos o bloqueio renova). */
const LOGIN_FAILURE_CPF_RULE = { limit: 19, windowMs: 60 * 60 * 1000, cooldownMs: 15 * 60 * 1000 };
const SETUP_CPF_RULE = { limit: 10, windowMs: 15 * 60 * 1000, cooldownMs: 5 * 60 * 1000 };
const SETUP_TOKEN_REQUIRED_MESSAGE =
  "Para criar sua senha, confirme primeiro o código enviado ao seu e-mail. Atualize o aplicativo/recarregue a página e tente novamente.";
const SETUP_TOKEN_INVALID_MESSAGE = "Verificação expirada ou inválida. Solicite um novo código para criar sua senha.";

const DOCUMENT_EMPTY_MESSAGE = "Informe seu CPF ou CNPJ.";
const DOCUMENT_INVALID_MESSAGE = "CPF ou CNPJ inválido.";
const GENERIC_INVALID_CREDENTIALS_MESSAGE = "CPF/CNPJ ou senha incorretos.";
const GENERIC_UNAVAILABLE_MESSAGE = "Não foi possível acessar sua conta agora. Tente novamente em alguns instantes.";
const GENERIC_RATE_LIMIT_MESSAGE = "Muitas tentativas foram realizadas. Aguarde alguns minutos e tente novamente.";

/** Senha inicial generica usada so para bloquear reescolha (nao existe "senha inicial do SGP" aqui, ao contrario do AcessaNet app). */
const GENERIC_INITIAL_PASSWORD = "acessanet";

export interface LocalAuthResult {
  accessToken: string;
  refreshToken: string;
  customer: {
    id: string;
    name: string;
    maskedCpf: string;
    maskedPhone?: string;
  };
  contracts: Array<{
    id: string;
    addressLine: string;
    city: string;
    state: string;
    planName: string;
    status: string;
  }>;
}

/**
 * Autenticacao por CPF/CNPJ + senha PROPRIA deste backend (nao existe endpoint
 * SGP de login por senha confirmado -- ver docs/SGP_INTEGRATION.md no repo
 * AcessaNet app). A senha nunca e persistida em texto puro (scrypt via
 * security/hash.ts) e o documento nunca e persistido em texto puro (so o hash
 * HMAC). "checkAccess"/"setupPassword" sempre revalidam o CPF/CNPJ contra o SGP,
 * entao so quem realmente e cliente Acessanet consegue criar uma senha.
 */
export class LocalPasswordAuthService {
  readonly tokens: TokenService;

  constructor(
    private readonly config: AppConfig,
    private readonly cpfResolver: { resolve: (cpf: string) => Promise<CpfResolverResult | null> },
    private readonly authProfiles: AuthProfileRepository,
    private readonly sessions: SessionRepository,
    private readonly loginAttempts: LoginAttemptRepository,
    private readonly auditLog: AuditLogRepository,
    private readonly rateLimiter: InMemoryRateLimiter,
    /** Limites por CPF com contador persistido. Omitido = so em memoria. */
    private readonly persistentLimiter: PersistentRateLimiter = new PersistentRateLimiter(),
    /** Necessario para validar o token de verificacao do primeiro acesso (emitido por PasswordResetService.verifyCode). */
    private readonly passwordResets?: PasswordResetRepository
  ) {
    this.tokens = new TokenService(config);
  }

  /**
   * B1: hashes de refresh token recem-rotacionados (por sessao), para distinguir a corrida benigna de duas abas
   * enviando o MESMO token velho (<= 30s, so 401) do reuso real de um token antigo (revoga a sessao inteira).
   */
  private readonly recentlyRotated = new Map<string, { hash: string; at: number }>();

  private cpfHash(digits: string) {
    return hmacSha256(digits, this.config.cpfHashSecret);
  }

  private ipHash(ip: string) {
    return sha256(ip || "unknown");
  }

  /**
   * Passo 1 do login: informa se este CPF/CNPJ ja tem senha criada, sem devolver nenhuma sessao.
   *
   * Menos informativo que antes: NAO consulta mais o SGP (era um oraculo de "este CPF e cliente" via 404 e
   * amplificava chamadas ao SGP). So le o banco local: CPF inexistente e cliente que ainda nao criou senha
   * respondem igual ({hasPassword:false}) e o cliente cai no fluxo de primeiro acesso, onde o SGP e consultado
   * atras de limites e de prova de posse. Trade-off: quem digita um CPF errado so descobre no passo do codigo
   * por e-mail (mensagem "fale com o suporte"); e ainda e possivel saber se um CPF JA TEM senha (necessario p/ a
   * UX de escolher entre "digite a senha" e "primeiro acesso") -- mitigado por limite por IP e por CPF.
   */
  async checkAccess(input: { cpf: string; ip: string }): Promise<{ hasPassword: boolean }> {
    const digits = normalizeDocument(input.cpf);

    this.rateLimiter.consume(`local_check:ip:${input.ip}`, { limit: 30, windowMs: 60_000, cooldownMs: 60_000 });

    if (!digits) {
      throw new AppError(400, "DOCUMENT_REQUIRED", DOCUMENT_EMPTY_MESSAGE);
    }

    if (!isValidDocument(digits)) {
      throw new AppError(400, "DOCUMENT_INVALID", DOCUMENT_INVALID_MESSAGE);
    }

    const cpfHash = this.cpfHash(digits);
    await this.persistentLimiter.consume(`local_check:cpf:${cpfHash}`, CHECK_CPF_RULE);

    const profile = await this.authProfiles.findByCpfHash(cpfHash);
    return { hasPassword: Boolean(profile?.passwordHash) };
  }

  /**
   * Primeiro acesso: define a senha SOMENTE com um token de verificacao emitido apos OTP valido enviado ao e-mail
   * cadastrado no SGP (PasswordResetService.requestFirstAccess -> verifyCode). O token e ligado ao CPF, de uso
   * unico e vale 10 min. NAO devolve sessao: o cliente faz login normal em seguida.
   */
  async setupPassword(input: {
    cpf: string;
    setupToken?: string | undefined;
    newPassword: string;
    confirmPassword?: string | undefined;
    ip: string;
    userAgent?: string | undefined;
  }): Promise<{ ok: true }> {
    const digits = normalizeDocument(input.cpf);
    const cpfHash = this.cpfHash(digits);
    const ipHash = this.ipHash(input.ip);
    const maskedCpf = digits ? maskDocument(digits) : "";

    this.rateLimiter.consume(`local_setup:ip:${input.ip}`, { limit: 10, windowMs: 60_000, cooldownMs: 60_000 });
    await this.persistentLimiter.consume(`local_setup:cpf:${cpfHash}`, SETUP_CPF_RULE);

    const blocked = await this.loginAttempts.isBlocked(cpfHash, ipHash);
    if (blocked.blocked) {
      throw new AppError(429, "RATE_LIMITED", GENERIC_RATE_LIMIT_MESSAGE, { retryAfterSeconds: blocked.retryAfterSeconds });
    }

    if (!digits) {
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, SETUP_RULE, "DOCUMENT_INVALID");
      throw new AppError(400, "DOCUMENT_REQUIRED", DOCUMENT_EMPTY_MESSAGE);
    }

    if (!isValidDocument(digits)) {
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, SETUP_RULE, "DOCUMENT_INVALID");
      throw new AppError(400, "DOCUMENT_INVALID", DOCUMENT_INVALID_MESSAGE);
    }

    if (!input.setupToken || !this.passwordResets) {
      throw new AppError(400, "SETUP_TOKEN_REQUIRED", SETUP_TOKEN_REQUIRED_MESSAGE);
    }

    if (input.confirmPassword !== undefined && input.confirmPassword !== input.newPassword) {
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, SETUP_RULE, "PASSWORD_MISMATCH");
      throw new AppError(400, "VALIDATION_ERROR", "As senhas não coincidem.");
    }

    try {
      validateNewPassword(input.newPassword, { initialPassword: GENERIC_INITIAL_PASSWORD, documentDigits: digits });
    } catch (error) {
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, SETUP_RULE, "PASSWORD_POLICY_REJECTED");
      throw error;
    }

    // Valida o token SEM consumi-lo (erro de politica acima nao queima o codigo do cliente).
    const request = await this.passwordResets.findByResetTokenHash(sha256(input.setupToken));
    const tokenOk =
      Boolean(request) &&
      request!.cpfHash === cpfHash &&
      !request!.resetTokenUsedAt &&
      Boolean(request!.resetTokenExpiresAt) &&
      request!.resetTokenExpiresAt!.getTime() > Date.now();
    if (!tokenOk) {
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, SETUP_RULE, "RESET_TOKEN_INVALID");
      throw new AppError(400, "SETUP_TOKEN_INVALID", SETUP_TOKEN_INVALID_MESSAGE);
    }

    const profile = await this.authProfiles.getOrCreate({ cpfHash, cpfLastDigits: digits.slice(-4), sgpCustomerId: null });
    if (profile.passwordHash) {
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, SETUP_RULE, "INVALID_CREDENTIALS");
      throw new AppError(409, "PASSWORD_ALREADY_SET", "Este CPF ou CNPJ já tem senha cadastrada. Faça login normalmente.");
    }

    // Consumo atomico: dois pedidos simultaneos com o mesmo token nao passam os dois.
    if (!(await this.passwordResets.claimResetToken(request!.id, new Date()))) {
      throw new AppError(400, "SETUP_TOKEN_INVALID", SETUP_TOKEN_INVALID_MESSAGE);
    }

    const passwordHash = await hashPassword(input.newPassword);
    const now = new Date();
    await this.authProfiles.setPasswordHash(cpfHash, passwordHash, now);
    await this.authProfiles.markFirstAccessCompleted(cpfHash, now);
    await this.loginAttempts.registerSuccess(cpfHash, ipHash);

    await this.auditLog.record({
      eventType: "FIRST_ACCESS_PASSWORD_CHANGE_SUCCESS",
      cpfHash,
      cpfMasked: maskedCpf,
      ipHash,
      userAgent: input.userAgent,
      status: "SUCCESS"
    });

    return { ok: true };
  }

  /** Login normal: CPF/CNPJ + senha propria ja criada. */
  async login(input: { cpf: string; password: string; ip: string; userAgent?: string | undefined }): Promise<LocalAuthResult> {
    const digits = normalizeDocument(input.cpf);
    const cpfHash = this.cpfHash(digits);
    const ipHash = this.ipHash(input.ip);
    const maskedCpf = digits ? maskDocument(digits) : "";

    this.rateLimiter.consume(`local_login:ip:${input.ip}`, { limit: 30, windowMs: 60_000, cooldownMs: 60_000 });

    if (isValidDocument(digits)) {
      await this.persistentLimiter.consume(`local_login:cpf:${cpfHash}`, LOGIN_CPF_RULE);
      // Falhas por CPF (qualquer IP): bloqueado = nem verifica a senha (nao gasta scrypt, nao confirma nada).
      await this.persistentLimiter.assertNotBlocked(`login_fail:cpf:${cpfHash}`);
    }

    const blocked = await this.loginAttempts.isBlocked(cpfHash, ipHash);
    if (blocked.blocked) {
      await this.auditLog.record({
        eventType: "RATE_LIMIT_TRIGGERED",
        cpfHash,
        cpfMasked: maskedCpf,
        ipHash,
        userAgent: input.userAgent,
        status: "FAILED",
        failureReason: "RATE_LIMITED"
      });
      throw new AppError(429, "RATE_LIMITED", GENERIC_RATE_LIMIT_MESSAGE, { retryAfterSeconds: blocked.retryAfterSeconds });
    }

    if (!isValidDocument(digits)) {
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, LOGIN_RULE, "DOCUMENT_INVALID");
      throw new AppError(401, "INVALID_CREDENTIALS", GENERIC_INVALID_CREDENTIALS_MESSAGE);
    }

    const profile = await this.authProfiles.findByCpfHash(cpfHash);

    if (!profile?.passwordHash) {
      await this.persistentLimiter.record(`login_fail:cpf:${cpfHash}`, LOGIN_FAILURE_CPF_RULE);
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, LOGIN_RULE, "INVALID_CREDENTIALS");
      throw new AppError(401, "INVALID_CREDENTIALS", GENERIC_INVALID_CREDENTIALS_MESSAGE);
    }

    const passwordValid = await verifyPassword(input.password, profile.passwordHash);
    if (!passwordValid) {
      await this.persistentLimiter.record(`login_fail:cpf:${cpfHash}`, LOGIN_FAILURE_CPF_RULE);
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, LOGIN_RULE, "INVALID_CREDENTIALS");
      throw new AppError(401, "INVALID_CREDENTIALS", GENERIC_INVALID_CREDENTIALS_MESSAGE);
    }

    let resolved: CpfResolverResult | null;
    try {
      resolved = await this.cpfResolver.resolve(digits);
    } catch {
      throw new AppError(502, "SGP_UNAVAILABLE", GENERIC_UNAVAILABLE_MESSAGE);
    }

    if (!resolved) {
      await this.registerFailure(cpfHash, ipHash, maskedCpf, input.userAgent, LOGIN_RULE, "CUSTOMER_NOT_FOUND");
      throw new AppError(404, "CUSTOMER_NOT_FOUND", "Não encontramos um cliente com os dados informados.");
    }

    await this.loginAttempts.registerSuccess(cpfHash, ipHash);
    await this.persistentLimiter.reset(`login_fail:cpf:${cpfHash}`);
    await this.authProfiles.recordSuccessfulLogin(cpfHash, ipHash, new Date());

    return this.createSession(resolved, cpfHash, ipHash, input.userAgent);
  }

  /** Troca de senha autenticada (Perfil > Seguranca). Identidade vem da sessao (cpfHash/customerId), nunca de um id enviado pelo cliente. */
  async changePassword(input: {
    customerId: string;
    cpfHash: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    ip: string;
    userAgent?: string | undefined;
  }): Promise<void> {
    const ipHash = this.ipHash(input.ip);

    this.rateLimiter.consume(`local_change_password:customer:${input.customerId}`, {
      limit: 10,
      windowMs: 60_000,
      cooldownMs: 60_000
    });

    if (input.newPassword !== input.confirmPassword) {
      throw new AppError(400, "VALIDATION_ERROR", "As senhas não coincidem.");
    }

    const profile = await this.authProfiles.findByCpfHash(input.cpfHash);
    if (!profile?.passwordHash) {
      throw new AppError(401, "INVALID_CREDENTIALS", GENERIC_INVALID_CREDENTIALS_MESSAGE);
    }

    const currentValid = await verifyPassword(input.currentPassword, profile.passwordHash);
    if (!currentValid) {
      await this.auditLog.record({
        eventType: "PASSWORD_CHANGED",
        customerId: input.customerId,
        cpfHash: input.cpfHash,
        ipHash,
        userAgent: input.userAgent,
        status: "FAILED",
        failureReason: "INVALID_CREDENTIALS"
      });
      throw new AppError(401, "INVALID_CREDENTIALS", "Senha atual incorreta.");
    }

    validateNewPassword(input.newPassword, {
      initialPassword: GENERIC_INITIAL_PASSWORD,
      currentPassword: input.currentPassword
    });

    const passwordHash = await hashPassword(input.newPassword);
    const now = new Date();
    await this.authProfiles.setPasswordHash(input.cpfHash, passwordHash, now);
    await this.sessions.revokeAllForCpfHash(input.cpfHash, now, input.sessionId);

    await this.auditLog.record({
      eventType: "PASSWORD_CHANGED",
      customerId: input.customerId,
      cpfHash: input.cpfHash,
      ipHash,
      userAgent: input.userAgent,
      status: "SUCCESS"
    });
  }

  async logout(customerId: string, sessionId: string) {
    const session = await this.sessions.findById(sessionId);
    if (session && session.customerId === customerId) {
      await this.sessions.revoke(sessionId, new Date());
      await this.auditLog.record({ eventType: "SESSION_REVOKED", customerId, status: "SUCCESS" });
    }
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = this.tokens.verifyRefreshToken(refreshToken);
    const session = await this.sessions.findById(payload.sessionId);

    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() || session.customerId !== payload.sub) {
      throw new AppError(401, "INVALID_REFRESH", "Sessao invalida.");
    }

    if (session.sessionTokenHash !== sha256(payload.tokenId)) {
      // Refresh token ja rotacionado sendo reapresentado = sinal de roubo/copia. Revoga a sessao inteira
      // (o dono legitimo refaz o login), exceto na corrida benigna de ate 30s com o token imediatamente anterior.
      const rotated = this.recentlyRotated.get(session.id);
      const benign = rotated && rotated.hash === sha256(payload.tokenId) && Date.now() - rotated.at < 30_000;
      if (!benign) {
        await this.sessions.revoke(session.id, new Date());
        this.recentlyRotated.delete(session.id);
        await this.auditLog.record({
          eventType: "SESSION_REVOKED",
          customerId: session.customerId,
          cpfHash: session.cpfHash,
          status: "FAILED",
          failureReason: "REFRESH_TOKEN_REUSE",
          metadata: { reason: "refresh_token_reuse" }
        });
      }
      throw new AppError(401, "INVALID_REFRESH", "Sessao invalida.");
    }

    const nextRefresh = this.tokens.issueRefreshToken(session.customerId, session.id);
    await this.sessions.updateTokenHash(session.id, nextRefresh.tokenHash);
    if (this.recentlyRotated.size > 2000) {
      for (const [id, entry] of this.recentlyRotated) {
        if (Date.now() - entry.at > 30_000) this.recentlyRotated.delete(id);
      }
    }
    this.recentlyRotated.set(session.id, { hash: session.sessionTokenHash, at: Date.now() });

    return {
      accessToken: this.tokens.issueAccessToken(session.customerId, session.id),
      refreshToken: nextRefresh.token
    };
  }

  private async createSession(
    resolved: CpfResolverResult,
    cpfHash: string,
    ipHash: string,
    userAgent: string | undefined
  ): Promise<LocalAuthResult> {
    const sessionId = randomId("authsess");
    const refresh = this.tokens.issueRefreshToken(resolved.customer.id, sessionId);
    const accessToken = this.tokens.issueAccessToken(resolved.customer.id, sessionId);

    await this.sessions.create({
      id: sessionId,
      sessionTokenHash: refresh.tokenHash,
      customerId: resolved.customer.id,
      cpfHash,
      expiresAt: new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000),
      ipHash,
      userAgent
    });

    await this.auditLog.record({
      eventType: "SESSION_CREATED",
      customerId: resolved.customer.id,
      cpfHash,
      ipHash,
      userAgent,
      status: "SUCCESS"
    });

    await this.auditLog.record({
      eventType: "LOGIN_SUCCESS",
      customerId: resolved.customer.id,
      cpfHash,
      ipHash,
      userAgent,
      status: "SUCCESS"
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      customer: {
        id: resolved.customer.id,
        name: resolved.customer.name,
        maskedCpf: resolved.customer.maskedCpf,
        maskedPhone: resolved.customer.maskedPhone
      },
      contracts: resolved.contracts.map((contract) => ({
        id: String(contract.id ?? ""),
        addressLine: String(contract.addressLine ?? ""),
        city: String(contract.city ?? ""),
        state: String(contract.state ?? ""),
        planName: String(contract.planName ?? "Plano Acessanet"),
        status: String(contract.status ?? "UNKNOWN")
      }))
    };
  }

  private async registerFailure(
    cpfHash: string,
    ipHash: string,
    maskedCpf: string,
    userAgent: string | undefined,
    rule: LoginAttemptRule,
    reason: AuthFailureReason
  ) {
    await this.loginAttempts.registerFailure(cpfHash, ipHash, rule);
    await this.auditLog.record({
      eventType: "LOGIN_FAILED",
      cpfHash,
      cpfMasked: maskedCpf,
      ipHash,
      userAgent,
      status: "FAILED",
      failureReason: reason
    });
  }
}
