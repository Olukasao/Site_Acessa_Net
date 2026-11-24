import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { closeContext, liveContexts } from "./adapters/huaweiOnt.mjs";
import { safeError } from "./safe.mjs";

/**
 * Painel do roteador ao vivo (Workspace): o navegador do agente JA entra logado no roteador do cliente e o funcionario ve e controla essa
 * pagina numa janela (transmissao de tela por SSE + eventos de mouse/teclado por POST). A senha de administrador e o IP do cliente NUNCA saem
 * deste processo. Nada de proxy: tokens e scripts de cada fabricante continuam funcionando porque quem fala com o roteador e o proprio navegador.
 */
const VIEW_W = 1280;
const VIEW_H = 800;
const IDLE_MS = 5 * 60_000; // sem nenhum comando do funcionario
const MAX_MS = 20 * 60_000; // teto de uma sessao
const GRACE_MS = 25_000; // janela fechada (sem ninguem assistindo): sai do painel
const MAX_SESSIONS = 5;
const HOME = { huawei: "/index.asp" }; // pagina inicial com menu, por fabricante (padrao: "/")

const messages = {
  CONTRACT_NOT_FOUND: "Contrato não encontrado no SGP.",
  CONTRACT_SUSPENDED: "Contrato suspenso: o SGP não mostra a conexão.",
  CONTRACT_CANCELED: "Contrato cancelado.",
  ROUTER_OFFLINE: "Cliente sem conexão agora (offline).",
  ROUTER_NOT_IDENTIFIED: "Não foi possível identificar o roteador deste cliente.",
  ROUTER_UNSUPPORTED: "Roteador do próprio cliente: o Workspace não tem acesso.",
  ROUTER_UNREACHABLE: "O roteador não respondeu. Tente de novo em instantes.",
  ROUTER_AUTH_FAILED: "O roteador recusou o acesso de administrador.",
  ROUTER_REQUIRES_VALIDATION: "Este modelo de roteador ainda não é suportado.",
  ROUTER_DRY_RUN: "O agente está em modo seguro (não entra em roteadores).",
  SGP_UNAVAILABLE: "O SGP não respondeu agora.",
  BUSY: "Muitos painéis abertos ao mesmo tempo. Feche um e tente de novo.",
  INTERNAL: "Não foi possível abrir o painel agora."
};
export const panelMessage = (code) => messages[code] ?? messages.INTERNAL;

const safeEq = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
};

export class PanelHub {
  /** manager: RouterManager (openPanelSession). */
  constructor({ manager, log = console, idleMs = IDLE_MS, maxMs = MAX_MS, graceMs = GRACE_MS } = {}) {
    this.manager = manager;
    this.log = log;
    this.idleMs = idleMs;
    this.maxMs = maxMs;
    this.graceMs = graceMs;
    this.sessions = new Map(); // token -> sessao
    this.opening = new Map(); // contrato -> Promise (dois cliques nao abrem dois logins)
    this.timer = setInterval(() => void this.sweep(), 5000);
    this.timer.unref?.();
  }

  byContract(contractId) {
    return [...this.sessions.values()].find((s) => s.contractId === contractId && !s.closing) ?? null;
  }

  /** Abre (ou reaproveita) o painel do contrato. Devolve { token, vendor, model, contractId }. Lanca erro com `.code`. */
  async open(contractId, { operator = null, label = "" } = {}) {
    const contract = String(contractId ?? "").replace(/\D/g, "").slice(0, 12);
    if (!contract) throw Object.assign(new Error("contrato invalido"), { code: "CONTRACT_NOT_FOUND" });
    const existing = this.byContract(contract);
    if (existing) {
      existing.touch();
      return existing.info();
    }
    if (this.opening.has(contract)) return this.opening.get(contract);
    if (this.sessions.size >= MAX_SESSIONS) throw Object.assign(new Error("muitos paineis"), { code: "BUSY" });
    const promise = this.#create(contract, { operator, label }).finally(() => this.opening.delete(contract));
    this.opening.set(contract, promise);
    return promise;
  }

  async #create(contract, { operator, label }) {
    const opened = await this.manager.openPanelSession(contract);
    const { session } = opened;
    const token = randomBytes(24).toString("hex");
    const s = new PanelSession({ token, contractId: contract, operator, label: String(label ?? "").slice(0, 80), opened, hub: this });
    this.sessions.set(token, s);
    const live = liveContexts.get(session.context);
    if (live) live.keepAlive = true; // o faxineiro de navegadores nao fecha um painel aberto
    try {
      await s.start();
    } catch (error) {
      await this.close(token, "falha ao iniciar");
      throw error;
    }
    this.log.info?.(`[router-agent] painel aberto: contrato ${contract} (${opened.vendorLabel ?? opened.vendor}${opened.model ? ` ${opened.model}` : ""})`);
    return s.info();
  }

  get(token) {
    const s = this.sessions.get(String(token ?? ""));
    return s && !s.closing ? s : null;
  }

  async close(token, why = "encerrado") {
    const s = this.sessions.get(token);
    if (!s || s.closing) return false;
    s.closing = true;
    this.sessions.delete(token);
    try {
      await s.stop();
    } catch (error) {
      this.log.warn?.(`[router-agent] painel ${s.contractId}: ${safeError(error, 120)}`);
    }
    // o contexto ja foi devolvido ao faxineiro normal (sai do painel pelo adaptador e fecha)
    this.log.info?.(`[router-agent] painel fechado: contrato ${s.contractId} (${why}) apos ${Math.round((Date.now() - s.since) / 1000)} s`);
    return true;
  }

  async sweep() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (s.closing) continue;
      if (now - s.since > this.maxMs) await this.close(s.token, "tempo maximo");
      else if (now - s.lastInput > this.idleMs) await this.close(s.token, "sem uso");
      else if (s.viewers.size === 0 && s.leftAt && now - s.leftAt > this.graceMs) await this.close(s.token, "janela fechada");
    }
  }

  async closeAll() {
    clearInterval(this.timer);
    await Promise.all([...this.sessions.keys()].map((t) => this.close(t, "agente encerrando")));
  }

  list() {
    return [...this.sessions.values()].map((s) => ({ contractId: s.contractId, operator: s.operator, since: s.since, vendor: s.opened.vendorLabel, model: s.opened.model }));
  }
}

class PanelSession {
  constructor({ token, contractId, operator, label, opened, hub }) {
    Object.assign(this, { token, contractId, operator, label, opened, hub });
    this.since = Date.now();
    this.lastInput = Date.now();
    this.viewers = new Set(); // respostas SSE abertas
    this.leftAt = Date.now(); // ainda ninguem abriu a janela
    this.closing = false;
    this.page = opened.session.page;
    this.cdp = null;
    this.lastFrame = null;
  }
  info() {
    return { token: this.token, contractId: this.contractId, vendor: this.opened.vendorLabel, model: this.opened.model };
  }
  touch() {
    this.lastInput = Date.now();
  }

  async start() {
    const ctx = this.opened.session.context;
    await this.page.setViewportSize({ width: VIEW_W, height: VIEW_H });
    // a pagina inicial com o menu completo (a de Wi-Fi, onde o login termina, nao tem navegacao)
    const home = HOME[this.opened.vendor] ?? "/";
    await this.page.goto(`${this.opened.session.origin}${home}`, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    // aba nova aberta pelo painel passa a ser a mostrada
    ctx.on("page", (p) => {
      p.setDefaultTimeout(20000);
      this.#follow(p).catch(() => undefined);
    });
    await this.#follow(this.page);
  }

  async #follow(page) {
    if (this.closing) return;
    await this.#stopCast();
    this.page = page;
    await page.setViewportSize({ width: VIEW_W, height: VIEW_H }).catch(() => undefined);
    const cdp = await page.context().newCDPSession(page);
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (f) => {
      this.lastFrame = { data: f.data, w: f.metadata?.deviceWidth ?? VIEW_W, h: f.metadata?.deviceHeight ?? VIEW_H };
      this.#broadcast(this.lastFrame);
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 72, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1 });
  }

  async #stopCast() {
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      await Promise.race([cdp.send("Page.stopScreencast").catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
      await cdp.detach().catch(() => undefined);
    }
  }

  #broadcast(f) {
    const line = `data: ${JSON.stringify(f)}\n\n`;
    for (const res of this.viewers) {
      // espectador lento: pula quadros em vez de acumular
      if (!res.writableNeedDrain) res.write(line);
    }
  }

  addViewer(res) {
    this.viewers.add(res);
    this.leftAt = 0;
    this.touch();
    if (this.lastFrame) res.write(`data: ${JSON.stringify(this.lastFrame)}\n\n`);
    res.on("close", () => {
      this.viewers.delete(res);
      if (this.viewers.size === 0) this.leftAt = Date.now();
    });
  }

  /** Eventos do funcionario: { t: 'm'|'d'|'u'|'w'|'k'|'K'|'nav' ... }. Coordenadas ja na escala do navegador do agente. */
  async input(ev) {
    this.touch();
    const p = this.page;
    const num = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
    try {
      if (ev.t === "m") await p.mouse.move(num(ev.x, VIEW_W), num(ev.y, VIEW_H));
      else if (ev.t === "d" || ev.t === "u") {
        const button = ["left", "middle", "right"][Number(ev.b)] ?? "left";
        await p.mouse.move(num(ev.x, VIEW_W), num(ev.y, VIEW_H));
        const clickCount = Math.max(1, Math.min(3, Number(ev.c) || 1));
        if (ev.t === "d") await p.mouse.down({ button, clickCount });
        else await p.mouse.up({ button, clickCount });
      } else if (ev.t === "w") await p.mouse.wheel(Math.max(-2000, Math.min(2000, Number(ev.dx) || 0)), Math.max(-2000, Math.min(2000, Number(ev.dy) || 0)));
      else if (ev.t === "k" || ev.t === "K") {
        const key = String(ev.key ?? "").slice(0, 20);
        if (!key) return;
        await (ev.t === "k" ? p.keyboard.down(key) : p.keyboard.up(key));
      } else if (ev.t === "text") await p.keyboard.insertText(String(ev.text ?? "").slice(0, 200));
      else if (ev.t === "home") await p.goto(`${this.opened.session.origin}${HOME[this.opened.vendor] ?? "/"}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      else if (ev.t === "reload") await p.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
      else if (ev.t === "back") await p.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch {
      // tecla desconhecida, pagina navegando...: ignora (o proximo quadro mostra o estado real)
    }
  }

  async stop() {
    for (const res of this.viewers) res.end();
    this.viewers.clear();
    await this.#stopCast();
    const live = liveContexts.get(this.opened.session.context);
    if (live) live.keepAlive = false;
    await this.opened.close(); // sai do painel pelo logout do adaptador e fecha o navegador do contexto
    await closeContext(this.opened.session.context).catch(() => undefined);
  }
}

const VIEWER_HTML = (token, label) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Roteador do cliente</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#0f1419;color:#e6e9ee;font:13px system-ui,sans-serif;overflow:hidden}
#bar{height:36px;display:flex;align-items:center;gap:8px;padding:0 10px;background:#1a212b;border-bottom:1px solid #2b3542;box-sizing:border-box}
#bar b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#bar span{flex:1}
button{background:#263243;color:#e6e9ee;border:1px solid #3a4658;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}
button:hover{background:#2f3d52}#fim{background:#5a2330;border-color:#7d3342}
#wrap{position:absolute;top:36px;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center}
canvas{background:#000;max-width:100%;max-height:100%;outline:none;cursor:default}
#st{position:absolute;top:36px;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none;color:#9aa6b6}
</style></head><body>
<div id="bar"><b id="rot"></b><span></span><button id="ini">Início</button><button id="vol">Voltar</button><button id="rec">Atualizar</button><button id="fim">Encerrar</button></div>
<div id="wrap"><canvas id="c" width="${VIEW_W}" height="${VIEW_H}" tabindex="0"></canvas></div>
<div id="st" id="msg">Conectando ao painel…</div>
<script>
const T=${JSON.stringify(token)};document.getElementById("rot").textContent=${JSON.stringify(label || "Roteador do cliente")};
const c=document.getElementById("c"),g=c.getContext("2d"),st=document.getElementById("st");
const post=(o)=>fetch("/i/"+T,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o),keepalive:true}).catch(()=>{});
let fw=${VIEW_W},fh=${VIEW_H};
const es=new EventSource("/s/"+T);
es.onmessage=(e)=>{const f=JSON.parse(e.data);const im=new Image();im.onload=()=>{if(c.width!==f.w||c.height!==f.h){c.width=f.w;c.height=f.h;}fw=f.w;fh=f.h;g.drawImage(im,0,0);st.style.display="none"};im.src="data:image/jpeg;base64,"+f.data};
es.onerror=()=>{st.style.display="flex";st.textContent="Sessão encerrada. Pode fechar esta janela.";es.close()};
const pos=(e)=>{const r=c.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)*fw/r.width),y:Math.round((e.clientY-r.top)*fh/r.height)}};
let last=0;
c.addEventListener("mousemove",(e)=>{const n=performance.now();if(n-last<40)return;last=n;post({t:"m",...pos(e)})});
c.addEventListener("mousedown",(e)=>{c.focus();post({t:"d",b:e.button,c:e.detail,...pos(e)});e.preventDefault()});
c.addEventListener("mouseup",(e)=>{post({t:"u",b:e.button,c:e.detail,...pos(e)});e.preventDefault()});
c.addEventListener("contextmenu",(e)=>e.preventDefault());
c.addEventListener("wheel",(e)=>{post({t:"w",dx:e.deltaX,dy:e.deltaY});e.preventDefault()},{passive:false});
c.addEventListener("keydown",(e)=>{if(e.key==="Dead"||e.key==="Process")return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="v"){navigator.clipboard?.readText().then((t)=>t&&post({t:"text",text:t})).catch(()=>{});e.preventDefault();return}
 post({t:"k",key:e.key});e.preventDefault()});
c.addEventListener("keyup",(e)=>{if(e.key==="Dead"||e.key==="Process")return;post({t:"K",key:e.key});e.preventDefault()});
document.getElementById("ini").onclick=()=>post({t:"home"});
document.getElementById("vol").onclick=()=>post({t:"back"});
document.getElementById("rec").onclick=()=>post({t:"reload"});
const fechar=()=>fetch("/x/"+T,{method:"POST",keepalive:true}).catch(()=>{});
document.getElementById("fim").onclick=()=>{fechar();st.style.display="flex";st.textContent="Encerrando…"};
addEventListener("pagehide",fechar);
</script></body></html>`;

/** Servidor HTTP do agente. Rotas de controle (so do proprio servidor, com token) e rotas do visualizador (token da sessao na URL). */
export function createPanelServer({ hub, controlToken, host = "0.0.0.0", port = 8796, log = console }) {
  const readJson = (req, max = 4096) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (d) => {
        size += d.length;
        if (size > max) {
          reject(Object.assign(new Error("grande demais"), { status: 413 }));
          req.destroy();
        } else chunks.push(d);
      });
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(Object.assign(new Error("json invalido"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers });
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
  const loopback = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const path = url.pathname;
      // ---- controle: so do proprio servidor (chat-interno), com o token compartilhado ----
      if (path.startsWith("/panel/")) {
        const auth = String(req.headers.authorization ?? "");
        if (!loopback(req) || !controlToken || !safeEq(auth, `Bearer ${controlToken}`)) return json(res, 403, { error: "negado" });
        if (req.method === "POST" && path === "/panel/open") {
          const b = await readJson(req);
          try {
            const r = await hub.open(b.contractId, { operator: b.operator, label: b.label });
            return json(res, 200, { ok: true, ...r });
          } catch (error) {
            const code = error?.code && messages[error.code] ? error.code : "INTERNAL";
            if (code === "INTERNAL") log.error?.(`[router-agent] painel: ${safeError(error)}`);
            return json(res, 200, { ok: false, code, message: panelMessage(code), vendor: error?.vendor ?? null, model: error?.model ?? null });
          }
        }
        if (req.method === "POST" && path === "/panel/close") {
          const b = await readJson(req);
          const s = hub.byContract(String(b.contractId ?? "").replace(/\D/g, ""));
          return json(res, 200, { ok: s ? await hub.close(s.token, "pedido do Workspace") : false });
        }
        if (req.method === "GET" && path === "/panel/list") return json(res, 200, { sessions: hub.list() });
        return json(res, 404, { error: "nao encontrado" });
      }
      // ---- visualizador: o token da sessao (48 hex, so conhecido por quem o Workspace entregou) ----
      const m = /^\/(v|s|i|x)\/([0-9a-f]{48})$/.exec(path);
      const s = m ? hub.get(m[2]) : null;
      if (!m || !s) return send(res, 404, "Sessão encerrada ou inexistente.", { "Content-Type": "text/plain; charset=utf-8" });
      if (m[1] === "v" && req.method === "GET") {
        return send(res, 200, VIEWER_HTML(s.token, s.label), { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'", "X-Frame-Options": "DENY" });
      }
      if (m[1] === "s" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 3000\n\n");
        s.addViewer(res);
        return;
      }
      if (m[1] === "i" && req.method === "POST") {
        const ev = await readJson(req);
        await s.input(ev);
        return send(res, 204, "");
      }
      if (m[1] === "x" && req.method === "POST") {
        await hub.close(s.token, "encerrado pela janela");
        return send(res, 204, "");
      }
      return send(res, 405, "");
    } catch (error) {
      if (!res.headersSent) json(res, error?.status ?? 500, { error: "erro" });
      else res.end();
    }
  });
  server.requestTimeout = 0; // SSE
  server.listen(port, host, () => log.info?.(`[router-agent] painel ao vivo em ${host}:${port}`));
  return server;
}
