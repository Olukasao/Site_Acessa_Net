import { buildApp } from "./app.js";
import { createContainer } from "./container.js";
import { createFcmClient } from "./push/fcmClient.js";
import { AppointmentNotifier } from "./push/appointmentNotifier.js";
import { OverdueNotifier } from "./push/overdueNotifier.js";
import { RatingNotifier } from "./push/ratingNotifier.js";
import { setAppointmentSourceLogger } from "./integrations/sgp/appointmentSourceLog.js";
import { startPonOutageSync, type PonOutageSyncLogEntry } from "./services/networkIncidentDetection/ponOutageSyncService.js";

async function start() {
  const container = createContainer();
  // Garante que o schema do banco exista antes de aceitar qualquer request
  // (so tem efeito real com DB_DRIVER=mysql -- ver dbReady em container.ts).
  await container.dbReady;
  const app = await buildApp(container);

  /**
   * Sync periodico de queda massiva de PON (regra 31/32 do pedido) -- so
   * roda quando OLT Cloud esta configurado. Formato de log pedido na regra
   * 34; nunca inclui CPF ou a lista de contratos (so contagens).
   */
  if (container.oltCloud) {
    startPonOutageSync(
      container.oltCloud.client,
      container.networkIncidents,
      container.config.ponOutageSync,
      (entry: PonOutageSyncLogEntry) => app.log.info({ tag: "OLT-INCIDENT", ...entry }, "[OLT-INCIDENT]")
    );
  }

  // Erros dentro de uma rota já passam pelo errorHandler do Fastify (ver
  // errors.ts) e nunca chegam aqui. Isto so cobre o que escapa do ciclo de
  // requisicao (ex.: uma promise solta em um setInterval/callback). Uma
  // rejeicao nao tratada so vira log -- nao derruba o processo por si so,
  // então nao pode virar reinicio "do nada" no PM2. Uma excecao sincrona nao
  // capturada deixa o processo em estado indefinido (regra do proprio
  // Node.js): logamos e saimos de propósito, para o PM2 reiniciar limpo em
  // vez do processo continuar servindo requisicoes num estado quebrado.
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    app.log.error({ err: error }, "Uncaught exception -- encerrando para o PM2 reiniciar");
    process.exit(1);
  });

  try {
    await app.listen({ port: container.config.port, host: "0.0.0.0" });
    app.log.info(`site-acessanet-server ouvindo na porta ${container.config.port}`);
    startPushNotifier(container, app.log);
    startCrashRetention(container, app.log);
    setAppointmentSourceLogger(app.log);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();

/** Push de visita agendada: so depois do listen, nunca derruba o servidor, desligado sem credencial FCM. */
function startPushNotifier(container: ReturnType<typeof createContainer>, log: { info: (o: Record<string, unknown>, m?: string) => void; warn: (o: Record<string, unknown>, m?: string) => void }) {
  try {
    if (process.env.PUSH_ENABLED === "false") {
      log.info({ tag: "PUSH" }, "[PUSH] desligado por PUSH_ENABLED=false");
      return;
    }
    const fcm = createFcmClient({ log });
    const notifier = new AppointmentNotifier({
      repo: container.pushDevices,
      tickets: container.providers.tickets,
      enabled: fcm.enabled,
      send: fcm.send,
      log,
      maxContractsPerCycle: Number(process.env.PUSH_MAX_CONTRACTS_PER_CYCLE) > 0 ? Number(process.env.PUSH_MAX_CONTRACTS_PER_CYCLE) : 150
    });
    const maxContracts = Number(process.env.PUSH_MAX_CONTRACTS_PER_CYCLE) > 0 ? Number(process.env.PUSH_MAX_CONTRACTS_PER_CYCLE) : 150;
    const overdue = new OverdueNotifier({
      repo: container.pushDevices,
      billing: container.providers.billing,
      enabled: fcm.enabled,
      send: fcm.send,
      log,
      maxContractsPerCycle: maxContracts
    });
    const rating = new RatingNotifier({
      repo: container.pushDevices,
      ratings: container.ticketRatings,
      tickets: container.providers.tickets,
      enabled: fcm.enabled && process.env.RATING_PUSH_ENABLED !== "false",
      send: fcm.send,
      log,
      maxContractsPerCycle: maxContracts,
      delayMs: Number(process.env.RATING_DELAY_MS) >= 0 && process.env.RATING_DELAY_MS ? Number(process.env.RATING_DELAY_MS) : 0
    });
    if (!fcm.enabled) return;
    rating.start(Number(process.env.RATING_POLL_INTERVAL_MS) >= 60_000 ? Number(process.env.RATING_POLL_INTERVAL_MS) : 300_000);
    const billingInterval = Number(process.env.PUSH_BILLING_INTERVAL_MS);
    overdue.start(billingInterval >= 60_000 ? billingInterval : 3_600_000);
    const interval = Number(process.env.PUSH_POLL_INTERVAL_MS);
    notifier.start(interval >= 10_000 ? interval : 300_000);
    log.info({ tag: "PUSH" }, "[PUSH] notificador de visitas agendadas iniciado");
  } catch (error) {
    log.warn({ tag: "PUSH", error: error instanceof Error ? error.message : "erro" }, "[PUSH] nao foi possivel iniciar");
  }
}

/** Erros do app: guarda 90 dias (APP_CRASH_RETENTION_DAYS) e apaga o resto uma vez por dia. */
function startCrashRetention(container: ReturnType<typeof createContainer>, log: { info: (o: Record<string, unknown>, m?: string) => void; warn: (o: Record<string, unknown>, m?: string) => void }) {
  const days = Number(process.env.APP_CRASH_RETENTION_DAYS) > 0 ? Number(process.env.APP_CRASH_RETENTION_DAYS) : 90;
  const purge = () => {
    container.appCrashes
      .purgeOlderThan(new Date(Date.now() - days * 24 * 60 * 60 * 1000))
      .then((removed) => {
        if (removed > 0) log.info({ tag: "CRASH", removed }, "[CRASH] ocorrencias antigas apagadas");
      })
      .catch((error) => log.warn({ tag: "CRASH", error: error instanceof Error ? error.message : "erro" }, "[CRASH] limpeza falhou"));
  };
  setTimeout(purge, 60_000).unref();
  setInterval(purge, 24 * 60 * 60 * 1000).unref();
}
