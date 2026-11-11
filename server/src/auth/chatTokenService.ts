import { createHmac } from "node:crypto";
import type { AppConfig } from "../config.js";

interface ChatTokenPayload {
  userType: "customer";
  sub: string;
  customerName: string;
  contractId: string;
  contractIds: string[];
  ticketIds?: string[];
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

/**
 * Token curto que identifica o cliente logado na acessanet-chat-api (JWT HS256 caseiro, como o resto deste backend).
 * Quem decide o `sub` e os contratos e SEMPRE este servidor, a partir da sessao -- o app nunca informa o cliente.
 */
export class ChatTokenService {
  constructor(private readonly chat: AppConfig["chat"], private readonly secret: string) {}

  issueCustomerToken(input: { customer: { id: string; name: string }; contracts: Array<{ id: string }>; contractId: string; ticketIds?: string[] }) {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.chat.ttlSeconds;
    const ticketIds = [...new Set((input.ticketIds ?? []).map((id) => id.trim()).filter(Boolean))];
    const payload: ChatTokenPayload = {
      userType: "customer",
      sub: input.customer.id,
      customerName: input.customer.name,
      contractId: input.contractId,
      contractIds: input.contracts.map((contract) => contract.id),
      ...(ticketIds.length ? { ticketIds } : {}),
      iss: this.chat.issuer,
      aud: this.chat.audience,
      iat: now,
      exp: expiresAt
    };
    return {
      chatToken: this.sign(payload),
      tokenType: "Bearer" as const,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      contractId: input.contractId
    };
  }

  private sign(payload: ChatTokenPayload) {
    const header = encode({ alg: "HS256", typ: "JWT" });
    const body = encode(payload);
    const signature = createHmac("sha256", this.secret).update(`${header}.${body}`).digest("base64url");
    return `${header}.${body}.${signature}`;
  }
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Segredo valido: pelo menos 32 caracteres (a mesma exigencia da chat-api). */
export const usableChatSecret = (secret: string | undefined): secret is string => typeof secret === "string" && secret.length >= 32;
