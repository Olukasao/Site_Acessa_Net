import { describe, expect, it } from "vitest";
import { getClientConnectionStatus } from "../src/integrations/oltcloud/oltClientConnectionStatus.js";
import type { OltCloudClient } from "../src/integrations/oltcloud/oltCloudClient.js";

function fakeClient(raw: Record<string, unknown>[]): OltCloudClient {
  return {
    listEquipment: async () => raw
  } as unknown as OltCloudClient;
}

describe("getClientConnectionStatus", () => {
  it("ignora equipamento de OUTRO contrato que so bateu por substring no filtro da API", async () => {
    // equipment/list?external_client_contract_id=5932 pode devolver tambem o contrato "35932"
    // (confirmado ao vivo) -- nunca deve ser aceito como se fosse o cliente pesquisado.
    const client = fakeClient([
      { external_client_contract_id: "35932", status: "Offline" },
      { external_client_contract_id: "5932", status: "Online" }
    ]);

    const result = await getClientConnectionStatus(client, "5932");

    expect(result.status).toBe("ONLINE");
    expect(result.deviceCount).toBe(1);
  });

  it("devolve UNKNOWN quando nenhum equipamento bate exatamente com o contrato", async () => {
    const client = fakeClient([{ external_client_contract_id: "35932", status: "Online" }]);

    const result = await getClientConnectionStatus(client, "5932");

    expect(result.status).toBe("UNKNOWN");
    expect(result.deviceCount).toBe(0);
  });

  it("OFFLINE se qualquer equipamento do cliente estiver offline, mesmo com outros online", async () => {
    const client = fakeClient([
      { external_client_contract_id: "5594", status: "Online" },
      { external_client_contract_id: "5594", status: "Offline" }
    ]);

    const result = await getClientConnectionStatus(client, "5594");

    expect(result.status).toBe("OFFLINE");
    expect(result.deviceCount).toBe(2);
  });
});

describe("status do equipamento: online so quando a OLT diz online", () => {
  it("valores desconhecidos (Ativo, active, vazio) nunca viram ONLINE", async () => {
    const { getClientConnectionStatus } = await import("../src/integrations/oltcloud/oltClientConnectionStatus.js");
    for (const status of ["Ativo", "active", "provisioned", "", "unknown"]) {
      const client = { listEquipment: async () => [{ external_client_contract_id: "3005", status }] } as never;
      expect((await getClientConnectionStatus(client, "3005")).status).toBe("UNKNOWN");
    }
  });

  it("LOS / dying gasp contam como offline; um online e um desconhecido ficam desconhecidos", async () => {
    const { getClientConnectionStatus } = await import("../src/integrations/oltcloud/oltClientConnectionStatus.js");
    for (const status of ["LOS", "Dying Gasp", "offline"]) {
      const client = { listEquipment: async () => [{ external_client_contract_id: "3005", status }] } as never;
      expect((await getClientConnectionStatus(client, "3005")).status).toBe("OFFLINE");
    }
    const mixed = { listEquipment: async () => [{ external_client_contract_id: "3005", status: "Online" }, { external_client_contract_id: "3005", status: "Ativo" }] } as never;
    expect((await getClientConnectionStatus(mixed, "3005")).status).toBe("UNKNOWN");
  });
});
