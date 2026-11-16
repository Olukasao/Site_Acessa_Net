import type { SgpUraClient } from "../integrations/sgp/sgpClient.js";
import { findCustomerEmail } from "../integrations/sgp/sgpMapper.js";
import type { Mailer } from "../email/mailer.js";
import type { PushDeviceRepository } from "../repositories/pushDeviceRepository.js";
import type { PushLogger, PushSendFn } from "../push/fcmClient.js";
import type { InMemoryStore } from "../repositories/inMemoryStore.js";
import type { RouterJobRecord } from "./routerWifiRepository.js";

export const WIFI_PUSH_TITLE = "A senha do seu Wi-Fi foi alterada";
export const WIFI_PUSH_BODY = "Não foi você? Fale com a gente agora pelo atendimento.";
const WIFI_CHANNEL = "chamados";

/**
 * Alerta de seguranca: depois de trocar a senha do Wi-Fi pela Central, o titular recebe push (celulares dele) e e-mail
 * (cadastro do SGP). Se alguem entrar na conta do cliente e trocar a senha, o dono fica sabendo na hora.
 * Nunca lanca e nunca leva a senha, o IP ou o roteador no aviso.
 */
export class WifiChangeNotifier {
  constructor(
    private readonly deps: {
      repo: PushDeviceRepository;
      store: InMemoryStore;
      sgpClient: SgpUraClient | undefined;
      mailer: Mailer;
      pushEnabled: boolean;
      send: PushSendFn;
      log?: PushLogger;
    }
  ) {}

  async notifyChanged(job: RouterJobRecord): Promise<void> {
    await Promise.allSettled([this.push(job), this.email(job)]);
  }

  private async push(job: RouterJobRecord) {
    if (!this.deps.pushEnabled) return;
    try {
      const devices = (await this.deps.repo.listActiveDevices()).filter((d) => d.customerId === job.customerId && (d.contractIds.length === 0 || d.contractIds.includes(job.contractId)));
      for (const device of devices) {
        const result = await this.deps.send({ token: device.token, title: WIFI_PUSH_TITLE, body: WIFI_PUSH_BODY, data: { route: "/cliente/atendimento", kind: "wifi_changed" }, channelId: WIFI_CHANNEL });
        if (result === "invalid_token") await this.deps.repo.disableToken(device.token);
      }
    } catch (error) {
      this.deps.log?.warn({ tag: "WIFI", error: error instanceof Error ? error.message : "erro" }, "[WIFI] push de senha alterada falhou");
    }
  }

  private async email(job: RouterJobRecord) {
    if (!this.deps.mailer.sendWifiChangedEmail || !this.deps.sgpClient) return;
    try {
      const contracts = await this.deps.sgpClient.consultCustomerByContract(job.contractId);
      const to = findCustomerEmail(contracts);
      if (!to) return;
      const name = this.deps.store.getCustomer(job.customerId)?.name ?? "";
      const when = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(job.finishedAt ?? Date.now()));
      await this.deps.mailer.sendWifiChangedEmail({ to, name, when, bands: job.bands.map((b) => b.replace("GHz", " GHz")).join(" e ") });
    } catch (error) {
      this.deps.log?.warn({ tag: "WIFI", error: error instanceof Error ? error.message : "erro" }, "[WIFI] e-mail de senha alterada falhou");
    }
  }
}
