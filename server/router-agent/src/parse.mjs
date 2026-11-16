// Leitura das paginas do painel web do SGP. Nao e API oficial: se o SGP mudar o layout, estas funcoes devolvem null
// (nunca "chutam" um valor) e a tarefa falha com SGP_UNAVAILABLE.

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const toText = (html) =>
  decode(String(html).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "));

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/**
 * /admin/servicos/internet/{id}/infodetail/?statusonly=1
 * Online:  "<h1> Online </h1> Detalhes: ... IP: <a>x.x.x.x</a> ... MAC: aa:bb:.. ... NAS: y.y.y.y ..."
 * Offline: "<h1> Offline </h1>"
 */
export function parseConnectionStatus(html) {
  const text = toText(html);
  const head = text.match(/\b(Online|Offline)\b/i)?.[1]?.toLowerCase();
  if (!head) return null;
  if (head === "offline") return { online: false, ip: null, mac: null, nas: null, uptime: null };
  const field = (label) => {
    const m = text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n]*)`, "i"));
    return m ? m[1].trim() : null;
  };
  const ip = field("IP");
  const mac = field("MAC");
  const nas = field("NAS");
  return {
    online: true,
    ip: ip && IPV4.test(ip) ? ip : null,
    mac: mac && MAC.test(mac) ? mac.toLowerCase().replace(/-/g, ":") : null,
    nas: nas && IPV4.test(nas) ? nas : null,
    uptime: field("Tempo")?.slice(0, 64) ?? null
  };
}

/** Opcoes do campo "Tipo equipamento" do SGP -> fabricante do adaptador. */
const VENDOR_BY_EQUIPMENT = [
  [/tp[\s-]?link/i, "tplink"],
  [/huawei/i, "huawei"],
  [/mercusys/i, "mercusys"],
  [/stavix/i, "stavix"],
  [/particular/i, "customer_owned"]
];

/** /admin/servicos/internet/{id}/  ->  fabricante pelo "Tipo equipamento" selecionado (ou null). */
export function parseEquipmentType(html) {
  const select = String(html).match(/<select[^>]*name="servicoi-tipo_equipamento"[\s\S]*?<\/select>/i)?.[0];
  if (!select) return { found: false, label: null, vendor: null };
  const selected = [...select.matchAll(/<option([^>]*)>([^<]*)<\/option>/gi)].find((o) => /\bselected\b/i.test(o[1]));
  const label = selected ? decode(selected[2]).trim() : "";
  if (!label || /^-+$/.test(label)) return { found: true, label: null, vendor: null };
  const vendor = VENDOR_BY_EQUIPMENT.find(([re]) => re.test(label))?.[1] ?? null;
  return { found: true, label: label.slice(0, 80), vendor };
}
