import { Agent, loadConfig } from "./agent.mjs";
import { shutdownBrowsers } from "./adapters/huaweiOnt.mjs";
import { PanelHub, createPanelServer } from "./panel.mjs";

const agent = new Agent(loadConfig());
// Painel ao vivo do roteador para o Workspace (so liga com ROUTER_PANEL_TOKEN no agent.env; so o chat-interno, no mesmo servidor, controla)
const panelToken = process.env.ROUTER_PANEL_TOKEN;
const panelHub = panelToken && panelToken.length >= 32 ? new PanelHub({ manager: agent.manager }) : null;
if (panelHub) createPanelServer({ hub: panelHub, controlToken: panelToken, port: Number(process.env.ROUTER_PANEL_PORT || 8796) });
let encerrando = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (encerrando) return;
    encerrando = true;
    agent.stopped = true;
    // fecha os navegadores antes de sair: um navegador orfao seguraria vaga de sessao no roteador
    await Promise.race([(panelHub?.closeAll() ?? Promise.resolve()).catch(() => undefined), new Promise((r) => setTimeout(r, 15000))]);
    await Promise.race([shutdownBrowsers().catch(() => undefined), new Promise((r) => setTimeout(r, 6000))]);
    process.exit(0);
  });
}
agent.loop();
