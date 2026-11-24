import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { PanelHub, createPanelServer } from "../src/panel.mjs";
import { acquireBrowser, closeContext, liveContexts, liveSessions, shutdownBrowsers } from "../src/adapters/huaweiOnt.mjs";

// Painel falso: um "roteador" local com campo de texto e botao. Prova a transmissao de tela, mouse, teclado e encerramento.
const browserPath = process.env.ROUTER_BROWSER_PATH;
const skip = !browserPath || !existsSync(browserPath) ? "sem navegador (ROUTER_BROWSER_PATH)" : false;

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const TOKEN = "c".repeat(40);

test("painel ao vivo: abre, transmite, recebe mouse/teclado, nega sem token e fecha saindo do painel", { skip, timeout: 60_000 }, async () => {
  let loggedOut = 0;
  const fake = http.createServer((req, res) => {
    if (req.url === "/logout") { loggedOut++; res.end("bye"); return; }
    res.setHeader("Content-Type", "text/html");
    res.end(`<body style="margin:0"><input id=t style="position:absolute;left:100px;top:100px;width:300px;height:40px"><button id=b style="position:absolute;left:100px;top:200px;width:200px;height:60px" onclick="document.title='clicou:'+document.getElementById('t').value">ok</button></body>`);
  });
  const fakePort = await listen(fake);
  const { chromium } = await import("playwright-core");
  const origin = `http://127.0.0.1:${fakePort}`;
  const manager = {
    async openPanelSession(contrato) {
      assert.equal(contrato, "3005");
      const browser = await acquireBrowser((o) => chromium.launch(o), { headless: true, executablePath: browserPath });
      const context = await browser.newContext({});
      liveContexts.set(context, { browser, since: Date.now() });
      const page = await context.newPage();
      await page.goto(origin + "/");
      const session = { browser, context, page, origin };
      liveSessions.set(context, { page, origin });
      return { vendor: "fake", vendorLabel: "Fake", model: "X1", session, close: async () => { await page.request?.get(origin + "/logout").catch(() => {}); loggedOut += 0; await fetch(origin + "/logout"); } };
    }
  };
  const hub = new PanelHub({ manager, graceMs: 800, idleMs: 60_000 });
  const srv = createPanelServer({ hub, controlToken: TOKEN, port: 0, host: "127.0.0.1", log: {} });
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    // sem token de controle: negado
    assert.equal((await fetch(`${base}/panel/open`, { method: "POST", body: "{}" })).status, 403);
    const call = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const [a, b] = await Promise.all([call("/panel/open", { contractId: "3005", label: "Teste" }), call("/panel/open", { contractId: "3005" })]);
    assert.equal(a.ok, true);
    assert.equal(b.token, a.token); // dois cliques = uma sessao so
    assert.equal(a.vendor, "Fake");
    assert.match(a.token, /^[0-9a-f]{48}$/);
    assert.equal((await fetch(`${base}/v/${"0".repeat(48)}`)).status, 404);
    const html = await (await fetch(`${base}/v/${a.token}`)).text();
    assert.match(html, /EventSource/);

    const ac = new AbortController();
    const res = await fetch(`${base}/s/${a.token}`, { signal: ac.signal });
    const reader = res.body.getReader();
    let buf = "";
    let frame = null;
    const dec = new TextDecoder();
    const limit = Date.now() + 15_000;
    while (!frame && Date.now() < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const m = /data: (\{.*?\})\n\n/s.exec(buf);
      if (m) frame = JSON.parse(m[1]);
    }
    assert.ok(frame && frame.data.length > 500, "recebeu um quadro da tela");
    assert.equal(Buffer.from(frame.data, "base64").subarray(0, 2).toString("hex"), "ffd8"); // JPEG

    const input = (ev) => fetch(`${base}/i/${a.token}`, { method: "POST", body: JSON.stringify(ev) });
    await input({ t: "d", b: 0, c: 1, x: 200, y: 120 });
    await input({ t: "u", b: 0, c: 1, x: 200, y: 120 });
    for (const ch of "ab1") { await input({ t: "k", key: ch }); await input({ t: "K", key: ch }); }
    await input({ t: "d", b: 0, c: 1, x: 150, y: 230 });
    await input({ t: "u", b: 0, c: 1, x: 150, y: 230 });
    const session = [...hub.sessions.values()][0];
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await session.page.title(), "clicou:ab1"); // clique no campo, digitou e clicou no botao
    ac.abort();

    // janela fechada (ninguem assistindo): sai do painel sozinho depois da tolerancia
    const t0 = Date.now();
    while (hub.sessions.size && Date.now() - t0 < 12_000) await new Promise((r) => setTimeout(r, 200));
    assert.equal(hub.sessions.size, 0);
    assert.ok(loggedOut >= 1, "saiu do painel (logout)");
    assert.equal(liveContexts.size, 0);
    assert.equal((await fetch(`${base}/v/${a.token}`)).status, 404);
  } finally {
    await hub.closeAll();
    srv.close();
    fake.close();
    for (const c of [...liveContexts.keys()]) await closeContext(c);
    await shutdownBrowsers();
  }
});

test("mensagens de erro do painel nao vazam detalhes", async () => {
  const hub = new PanelHub({ manager: { openPanelSession: async () => { throw Object.assign(new Error("100.64.1.2 senha=abc"), { code: "ROUTER_OFFLINE" }); } } });
  const srv = createPanelServer({ hub, controlToken: TOKEN, port: 0, host: "127.0.0.1", log: {} });
  await new Promise((r) => srv.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/panel/open`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ contractId: "1" }) }).then((x) => x.json());
    assert.equal(r.ok, false);
    assert.equal(r.code, "ROUTER_OFFLINE");
    assert.doesNotMatch(JSON.stringify(r), /100\.64|senha/);
  } finally {
    await hub.closeAll();
    srv.close();
  }
});
