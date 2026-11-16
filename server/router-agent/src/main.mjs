import { Agent, loadConfig } from "./agent.mjs";
import { shutdownBrowsers } from "./adapters/huaweiOnt.mjs";

const agent = new Agent(loadConfig());
let encerrando = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (encerrando) return;
    encerrando = true;
    agent.stopped = true;
    // fecha os navegadores antes de sair: um navegador orfao seguraria vaga de sessao no roteador
    await Promise.race([shutdownBrowsers().catch(() => undefined), new Promise((r) => setTimeout(r, 6000))]);
    process.exit(0);
  });
}
agent.loop();
