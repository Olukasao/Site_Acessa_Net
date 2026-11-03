import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export type PushSendResult = "ok" | "invalid_token" | "retry";

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** Dados entregues ao app (ex.: route, protocol). Valores sempre string, exigencia do FCM. */
  data: Record<string, string>;
  /** Canal de notificacao Android ("chamados", "faturas"). */
  channelId: string;
}

export type PushSendFn = (message: PushMessage) => Promise<PushSendResult>;

export interface PushLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface FcmClient {
  /** false = sem credencial: nada e enviado e o notificador nem consulta o SGP. */
  readonly enabled: boolean;
  send: PushSendFn;
}

interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Mostra so o comeco/fim do token -- o token completo nunca vai para log. */
export function maskToken(token: string) {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function parseServiceAccount(raw: string): ServiceAccount | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const projectId = typeof data.project_id === "string" ? data.project_id : "";
    const clientEmail = typeof data.client_email === "string" ? data.client_email : "";
    const privateKey = typeof data.private_key === "string" ? data.private_key.replace(/\\n/g, "\n") : "";
    if (!projectId || !clientEmail || !privateKey.includes("PRIVATE KEY")) return null;
    return { projectId, clientEmail, privateKey };
  } catch {
    return null;
  }
}

/** Le a credencial de FCM_SERVICE_ACCOUNT_JSON (JSON) ou FCM_SERVICE_ACCOUNT_FILE (caminho). Nunca loga o conteudo. */
export function loadServiceAccount(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
): { account: ServiceAccount | null; reason?: string } {
  const json = env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  const file = env.FCM_SERVICE_ACCOUNT_FILE?.trim();
  if (!json && !file) return { account: null, reason: "sem credencial FCM_SERVICE_ACCOUNT_JSON/FCM_SERVICE_ACCOUNT_FILE" };
  let raw = json;
  if (!raw && file) {
    try {
      raw = readFile(file);
    } catch {
      return { account: null, reason: "FCM_SERVICE_ACCOUNT_FILE ilegivel" };
    }
  }
  const account = parseServiceAccount(raw ?? "");
  return account ? { account } : { account: null, reason: "credencial FCM invalida (faltam project_id/client_email/private_key)" };
}

function b64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

export function signServiceAccountJwt(account: ServiceAccount, nowSeconds: number) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 })
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

export interface FcmClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
  now?: () => number;
  log?: PushLogger;
}

export function createFcmClient(options: FcmClientOptions = {}): FcmClient {
  const env = options.env ?? process.env;
  const log = options.log;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const { account, reason } = loadServiceAccount(env, options.readFile);
  if (!account) {
    log?.warn({ tag: "PUSH", reason }, "[PUSH] FCM desligado: notificacoes push nao serao enviadas");
    return { enabled: false, send: async () => "retry" };
  }

  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token;
    const assertion = signServiceAccountJwt(account!, Math.floor(now() / 1000));
    const response = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`oauth_http_${response.status}`);
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("oauth_sem_token");
    cached = { token: data.access_token, expiresAt: now() + (data.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  const send: PushSendFn = async (message) => {
    try {
      const bearer = await accessToken();
      const response = await doFetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: { priority: "HIGH", notification: { channel_id: message.channelId } }
          }
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (response.ok) return "ok";

      let errorStatus = "";
      let details = "";
      try {
        const body = (await response.json()) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
        errorStatus = body.error?.status ?? "";
        details = body.error?.details?.map((item) => item.errorCode ?? "").join(",") ?? "";
      } catch {
        /* corpo nao-JSON */
      }
      if (response.status === 401) cached = null;
      const invalid =
        response.status === 404 ||
        errorStatus === "NOT_FOUND" ||
        errorStatus === "INVALID_ARGUMENT" ||
        details.includes("UNREGISTERED") ||
        details.includes("INVALID_ARGUMENT") ||
        details.includes("SENDER_ID_MISMATCH");
      if (invalid) return "invalid_token";
      log?.warn({ tag: "PUSH", status: response.status, errorStatus, token: maskToken(message.token) }, "[PUSH] FCM recusou/adiou o envio");
      return "retry";
    } catch (error) {
      log?.warn(
        { tag: "PUSH", error: error instanceof Error ? error.message.slice(0, 120) : "erro", token: maskToken(message.token) },
        "[PUSH] falha de rede/credencial ao enviar"
      );
      return "retry";
    }
  };

  return { enabled: true, send };
}
