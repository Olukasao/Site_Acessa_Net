// Inventario so-leitura dos roteadores (nao faz login em nenhum roteador).
// Uso: npm run inventory -- contratos.txt [--delay=4000] [--hours=1-6]
//   contratos.txt: um numero de contrato por linha. --hours: so roda nessa janela (hora de Sao Paulo), ex.: 1-6.
import { readFileSync } from "node:fs";
import { Agent, loadConfig } from "../src/agent.mjs";
import { parseWindow, runInventory } from "../src/inventory.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("informe o arquivo com os contratos (um por linha)"); process.exit(1); }
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const contracts = [...new Set(readFileSync(file, "utf8").split(/\s+/).filter((c) => /^\d{1,12}$/.test(c)))];
const cfg = loadConfig();
const agent = new Agent(cfg);
let stopping = false;
process.on("SIGINT", () => { stopping = true; console.log("\nparando depois do contrato atual..."); });
console.log(`${contracts.length} contratos, ${opt("delay", "4000")} ms entre cada${opt("hours", "") ? `, janela ${opt("hours", "")}h` : ""}. So leitura.`);
const stats = await runInventory({
  manager: agent.manager,
  central: (path, body) => agent.central(path, body),
  contracts,
  delayMs: Number(opt("delay", "4000")),
  window: parseWindow(opt("hours", "")),
  progressPath: `${process.env.ROUTER_INVENTORY_PROGRESS ?? "inventory-progress.json"}`,
  stop: () => stopping
});
console.log(JSON.stringify(stats, null, 2));
