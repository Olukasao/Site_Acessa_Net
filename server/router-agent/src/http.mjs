import { sameOrigin } from "./policy.mjs";

/**
 * Cliente HTTP que os adaptadores usam para falar com o roteador: so a origem liberada (IP do SGP + porta do
 * fabricante), sem seguir redirecionamento, com tempo limite e um teto de pedidos por tarefa.
 * TLS: nao desligamos a verificacao no processo. Se um firmware so tiver certificado autoassinado, isso e tratado
 * no adaptador daquele modelo (documentado), nunca com NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
export function routerHttp(baseUrl, { timeoutMs = 8000, maxRequests = 40, fetchImpl = fetch } = {}) {
  let count = 0;
  const cookies = new Map();
  return {
    baseUrl,
    async request(path, init = {}) {
      const url = new URL(path, baseUrl).toString();
      if (!sameOrigin(url, baseUrl)) throw Object.assign(new Error("destino fora do roteador"), { code: "ROUTER_UNREACHABLE" });
      if (++count > maxRequests) throw Object.assign(new Error("pedidos demais nesta tarefa"), { code: "INTERNAL" });
      try {
        const res = await fetchImpl(url, {
          ...init,
          redirect: "manual",
          headers: { ...(cookies.size ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs)
        });
        const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        for (const c of list) {
          const pair = c.split(";")[0];
          const i = pair.indexOf("=");
          if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
        }
        return res;
      } catch (error) {
        if (error?.code) throw error;
        throw Object.assign(new Error("roteador nao respondeu"), { code: "ROUTER_UNREACHABLE" });
      }
    }
  };
}
