// Para onde o agente pode se conectar. O destino vem SO do SGP (IP da sessao PPPoE do contrato) e precisa cair numa
// faixa liberada (padrao: CGNAT 100.64.0.0/10). Porta e protocolo vem da configuracao por fabricante, nunca do cliente.

const toInt = (ip) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

export function parseCidr(cidr) {
  const m = String(cidr).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) throw new Error(`faixa invalida: ${cidr}`);
  const bits = Number(m[2]);
  if (bits < 8 || bits > 32) throw new Error(`faixa larga demais ou invalida: ${cidr}`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: toInt(m[1]) & mask, mask };
}

export function ipAllowed(ip, cidrs) {
  if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(String(ip ?? "")) || ip.split(".").some((p) => Number(p) > 255)) return false;
  const n = toInt(ip);
  return cidrs.some(({ base, mask }) => (n & mask) === base);
}

/** Base do painel do roteador. Sem configuracao para o fabricante = nao conecta. */
export function routerBaseUrl(ip, vendor, endpoints, cidrs) {
  if (!ipAllowed(ip, cidrs)) return null;
  const ep = endpoints[vendor];
  if (!ep || !["http", "https"].includes(ep.protocol) || !Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) return null;
  return `${ep.protocol}://${ip}:${ep.port}`;
}

/**
 * Confere uma URL antes de cada pedido ao roteador: mesmo host e porta da base (redirecionamento para outro destino
 * e recusado; os adaptadores usam redirect "manual").
 */
export function sameOrigin(url, base) {
  try {
    const a = new URL(url);
    const b = new URL(base);
    return a.protocol === b.protocol && a.host === b.host && !a.username && !a.password;
  } catch {
    return false;
  }
}
