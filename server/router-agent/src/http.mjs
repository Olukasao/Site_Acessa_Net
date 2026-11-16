import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { sameOrigin } from "./policy.mjs";

/**
 * Cliente HTTP que os adaptadores usam para falar com o roteador: so a origem liberada (IP do SGP + porta do
 * fabricante), sem seguir redirecionamento, com tempo limite e um teto de pedidos por tarefa.
 *
 * TLS: os roteadores usam certificado de fabrica (autoassinado ou de CA propria, emitido para um nome e nao para o IP),
 * entao a validacao normal sempre falharia. Em vez de desligar a validacao, cada fabricante/modelo tem a lista de
 * impressoes digitais (SHA-256) dos certificados aceitos ("pins"). Certificado fora da lista = conexao recusada.
 * Nunca usamos NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
export const fingerprintOf = (cert) => String(cert?.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();

function pinnedAgent() {
  // A cadeia nunca valida (certificado de fabrica); quem decide e o pin, conferido em checkPin e de novo em cada conexao.
  return new https.Agent({ keepAlive: false, rejectUnauthorized: false });
}

/** Dados publicos do certificado do roteador (dono e impressao digital), sem enviar nada alem do aperto de mao TLS. */
export function peekCertificate(baseUrl, timeoutMs = 8000) {
  const u = new URL(baseUrl);
  return new Promise((resolve) => {
    const socket = tls.connect({ host: u.hostname, port: Number(u.port || 443), rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const label = [cert?.subject?.O, cert?.subject?.CN].filter(Boolean).join(" / ").slice(0, 120);
      resolve({ ok: true, subject: label || null, fingerprint: fingerprintOf(cert) || null });
    });
    socket.on("error", () => resolve({ ok: false, subject: null, fingerprint: null }));
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, subject: null, fingerprint: null });
    });
  });
}

/** Le o certificado e confere o pin, sem mandar nada alem do aperto de mao TLS. */
export function checkPin(baseUrl, pins, timeoutMs = 8000) {
  const u = new URL(baseUrl);
  return new Promise((resolve) => {
    const socket = tls.connect({ host: u.hostname, port: Number(u.port || 443), rejectUnauthorized: false, servername: undefined, timeout: timeoutMs }, () => {
      const fp = fingerprintOf(socket.getPeerCertificate());
      socket.end();
      resolve({ ok: (pins ?? []).map((p) => p.replace(/:/g, "").toLowerCase()).includes(fp), fingerprint: fp });
    });
    socket.on("error", () => resolve({ ok: false, fingerprint: null, unreachable: true }));
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, fingerprint: null, unreachable: true });
    });
  });
}

/**
 * `anyCert`: SO para RECONHECER o aparelho (um GET na pagina de login publica, sem enviar senha nem cookie): aceita certificado fora da
 * lista de pins. Nunca usado em login nem em alteracao.
 */
export function routerHttp(baseUrl, { timeoutMs = 8000, maxRequests = 40, pins = [], transport, anyCert = false } = {}) {
  let count = 0;
  const cookies = new Map();
  const isHttps = baseUrl.startsWith("https:");
  const agent = isHttps ? pinnedAgent() : undefined;
  const allowed = new Set((pins ?? []).map((p) => String(p).replace(/:/g, "").toLowerCase()));
  let pinned = !isHttps || Boolean(transport) || anyCert;
  const ensurePinned = async () => {
    if (pinned) return;
    const r = await checkPin(baseUrl, pins, timeoutMs);
    if (r.unreachable) throw Object.assign(new Error("roteador nao respondeu"), { code: "ROUTER_UNREACHABLE" });
    if (!r.ok) throw Object.assign(new Error("certificado do roteador fora da lista"), { code: "ROUTER_CERT_UNKNOWN", fingerprint: r.fingerprint });
    pinned = true;
  };

  const send =
    transport ??
    ((url, init) =>
      new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = (isHttps ? https : http).request(
          { host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? "GET", headers: init.headers, agent, timeout: timeoutMs },
          (res) => {
            const chunks = [];
            res.on("data", (d) => chunks.push(d));
            res.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf8");
              resolve({ status: res.statusCode, headers: res.headers, text: async () => body });
            });
          }
        );
        // segunda conferencia, na propria conexao: certificado diferente derruba antes da resposta ser usada
        req.on("socket", (sock) => sock.once("secureConnect", () => {
          if (!anyCert && !allowed.has(fingerprintOf(sock.getPeerCertificate()))) sock.destroy(Object.assign(new Error("certificado do roteador fora da lista"), { code: "ROUTER_CERT_UNKNOWN" }));
        }));
        req.on("error", reject);
        req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ROUTER_UNREACHABLE" })));
        if (init.body) req.write(init.body);
        req.end();
      }));

  return {
    baseUrl,
    pins,
    anyCert,
    async request(path, init = {}) {
      const url = new URL(path, baseUrl).toString();
      if (!sameOrigin(url, baseUrl)) throw Object.assign(new Error("destino fora do roteador"), { code: "ROUTER_UNREACHABLE" });
      if (++count > maxRequests) throw Object.assign(new Error("pedidos demais nesta tarefa"), { code: "INTERNAL" });
      const headers = { ...(cookies.size ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(init.headers ?? {}) };
      await ensurePinned();
      if (init.body) headers["Content-Length"] = String(Buffer.byteLength(init.body));
      try {
        const res = await send(url, { ...init, headers, redirect: "manual" });
        const setCookie = res.headers?.["set-cookie"] ?? (typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : []);
        for (const c of [].concat(setCookie ?? [])) {
          const pair = String(c).split(";")[0];
          const i = pair.indexOf("=");
          if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
        }
        return res;
      } catch (error) {
        if (error?.code === "ROUTER_CERT_UNKNOWN") throw error;
        if (["INTERNAL", "ROUTER_UNREACHABLE"].includes(error?.code)) throw error;
        throw Object.assign(new Error("roteador nao respondeu"), { code: "ROUTER_UNREACHABLE" });
      }
    }
  };
}
