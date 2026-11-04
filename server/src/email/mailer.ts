import nodemailer, { type Transporter } from "nodemailer";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { renderOtpEmailHtml, renderOtpEmailText } from "./otpEmailTemplate.js";

export interface Mailer {
  /** Lanca AppError("EMAIL_SEND_FAILED") em caso de falha -- nunca deixa detalhes de SMTP vazarem pro chamador. */
  sendOtpEmail(input: { to: string; name: string; code: string }): Promise<void>;
  /** So testa a conexao/autenticacao (transporter.verify()) -- nao envia nenhum e-mail. */
  verifyConnection(): Promise<{ ok: boolean; error?: string }>;
}

const OTP_EMAIL_SUBJECT = "Código de verificação Acessanet";

/** Entrada de diagnostico de uma falha de envio: so campos seguros (sem host, usuario, senha nem e-mail do destinatario). */
export interface MailerLogEntry {
  event: "smtp_send_failed";
  /** Codigo do nodemailer (ex.: EAUTH, ECONNECTION, ETIMEDOUT, EENVELOPE). */
  code?: string;
  /** Codigo de resposta SMTP (ex.: 421, 450, 550). */
  responseCode?: number;
  command?: string;
  /** Resposta curta do servidor SMTP, ja sem e-mails e sem host/usuario da configuracao. */
  response?: string;
  /** Apenas o dominio do destinatario (ex.: hotmail.com), util para achar bloqueio de um provedor. */
  toDomain?: string;
}

export type MailerLogger = (entry: MailerLogEntry) => void;

function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[oculto]");
  }
  out = out.replace(/[^\s@<>"']+@[^\s@<>"']+/g, "[e-mail]");
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
}

/** Extrai do erro do nodemailer apenas o que ajuda a achar a causa, sem vazar credenciais nem dados pessoais. */
export function describeSendError(error: unknown, to: string, config: AppConfig["smtp"]): MailerLogEntry {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown; command?: unknown; response?: unknown };
  const entry: MailerLogEntry = { event: "smtp_send_failed" };
  if (typeof e.code === "string") entry.code = e.code.slice(0, 32);
  if (typeof e.responseCode === "number") entry.responseCode = e.responseCode;
  if (typeof e.command === "string") entry.command = e.command.slice(0, 32);
  if (typeof e.response === "string") entry.response = redact(e.response, [config.host, config.user, config.pass]);
  const domain = to.split("@")[1];
  if (domain) entry.toDomain = domain.toLowerCase().slice(0, 100);
  return entry;
}

export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;

  constructor(
    private readonly config: AppConfig["smtp"],
    private readonly logger: MailerLogger = () => {},
    /** So para testes: permite injetar um transporte falso sem abrir conexao SMTP. */
    transporter?: Pick<Transporter, "sendMail" | "verify">
  ) {
    this.transporter = (transporter as Transporter | undefined) ?? nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass }
    });
  }

  async sendOtpEmail(input: { to: string; name: string; code: string }): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.config.from,
        to: input.to,
        subject: OTP_EMAIL_SUBJECT,
        text: renderOtpEmailText(input),
        html: renderOtpEmailHtml(input)
      });
    } catch (error) {
      // Nunca repassar o erro original ao chamador: pode conter host/usuario/detalhes do provedor SMTP.
      // So o diagnostico seguro vai para o log do servidor, para dar para descobrir a causa das falhas.
      try {
        this.logger(describeSendError(error, input.to, this.config));
      } catch {
        // Log nunca pode derrubar o fluxo de redefinicao de senha.
      }
      throw new AppError(502, "EMAIL_SEND_FAILED", "Nao foi possivel enviar o codigo agora. Tente novamente em instantes.");
    }
  }

  async verifyConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Falha desconhecida na verificacao SMTP." };
    }
  }
}

/** Usado quando SMTP_HOST/SMTP_USER/SMTP_PASS nao estao configurados (dev local sem credenciais reais). */
export class UnconfiguredMailer implements Mailer {
  async sendOtpEmail(): Promise<void> {
    throw new AppError(500, "SMTP_NOT_CONFIGURED", "Envio de e-mail nao configurado neste ambiente.");
  }

  async verifyConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "SMTP_HOST/SMTP_USER/SMTP_PASS ausentes." };
  }
}
