import { Agent, loadConfig } from "./agent.mjs";

const agent = new Agent(loadConfig());
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { agent.stopped = true; setTimeout(() => process.exit(0), 2000).unref(); });
agent.loop();
