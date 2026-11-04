import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { describeSendError, SmtpMailer, type MailerLogEntry } from "../src/email/mailer.js";

const smtp = {
  enabled: true,
  host: "smtp.provedor-secreto.example",
  port: 465,
  secure: true,
  user: "envio@dominio-secreto.example",
  pass: "senha-super-secreta",
  from: "Acessanet <envio@dominio-secreto.example>"
} as unknown as AppConfig["smtp"];

const input = { to: "cliente.fulana@hotmail.com", name: "Fulana", code: "123456" };

/** Transporte falso que sempre falha com o valor dado (stub simples: vi.fn() gera "unhandled rejection" ao rejeitar). */
function failingTransport(reason: unknown) {
  return {
    async sendMail() {
      throw reason;
    },
    async verify() {
      return true;
    }
  } as never;
}

async function sendAndCatch(mailer: SmtpMailer): Promise<unknown> {
  try {
    await mailer.sendOtpEmail(input);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("SmtpMailer: diagnostico de falha de envio", () => {
  it("registra a causa (codigo e resposta SMTP) e mantem o erro generico para o chamador", async () => {
    const logs: MailerLogEntry[] = [];
    const transport = failingTransport(
      Object.assign(new Error("falha"), {
        code: "EENVELOPE",
        responseCode: 421,
        command: "RCPT TO",
        response: "421 4.7.0 Hourly sending limit exceeded for envio@dominio-secreto.example"
      })
    );

    const erro = await sendAndCatch(new SmtpMailer(smtp, (entry) => logs.push(entry), transport));

    expect(erro).toBeInstanceOf(AppError);
    expect((erro as AppError).statusCode).toBe(502);
    expect((erro as AppError).code).toBe("EMAIL_SEND_FAILED");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "smtp_send_failed", code: "EENVELOPE", responseCode: 421, command: "RCPT TO", toDomain: "hotmail.com" });
    expect(logs[0]?.response).toContain("Hourly sending limit exceeded");
  });

  it("nao vaza senha, host, usuario nem e-mail do cliente no log", async () => {
    const logs: MailerLogEntry[] = [];
    const transport = failingTransport(
      Object.assign(new Error("Invalid login: smtp.provedor-secreto.example senha-super-secreta"), {
        code: "EAUTH",
        responseCode: 535,
        response:
          "535 Auth failed for envio@dominio-secreto.example on smtp.provedor-secreto.example (senha-super-secreta) to cliente.fulana@hotmail.com"
      })
    );

    const erro = await sendAndCatch(new SmtpMailer(smtp, (entry) => logs.push(entry), transport));

    expect((erro as AppError).code).toBe("EMAIL_SEND_FAILED");
    const text = JSON.stringify(logs);
    for (const segredo of ["senha-super-secreta", "smtp.provedor-secreto.example", "envio@dominio-secreto.example", "cliente.fulana@hotmail.com", "cliente.fulana", "123456"]) {
      expect(text).not.toContain(segredo);
    }
    expect(logs[0]?.code).toBe("EAUTH");
  });

  it("um logger que lanca excecao nao quebra o fluxo", async () => {
    const logger = () => {
      throw new Error("logger quebrado");
    };
    const erro = await sendAndCatch(new SmtpMailer(smtp, logger, failingTransport(new Error("boom"))));
    expect(erro).toBeInstanceOf(AppError);
    expect((erro as AppError).code).toBe("EMAIL_SEND_FAILED");
  });

  it("funciona sem logger e com erro sem campos conhecidos", async () => {
    const erro = await sendAndCatch(new SmtpMailer(smtp, undefined, failingTransport("texto solto")));
    expect((erro as AppError).code).toBe("EMAIL_SEND_FAILED");
    expect(describeSendError(undefined, "a@b.com", smtp)).toEqual({ event: "smtp_send_failed", toDomain: "b.com" });
  });

  it("limita o tamanho da resposta registrada", () => {
    const entry = describeSendError({ response: "x".repeat(5000) }, "a@b.com", smtp);
    expect(entry.response?.length).toBeLessThanOrEqual(200);
  });
});
