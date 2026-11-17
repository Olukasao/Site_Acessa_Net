import { PendingValidationAdapter } from "./base.mjs";
import { HuaweiOntAdapter } from "./huaweiOnt.mjs";
import { StavixRealtekAdapter } from "./stavixRealtek.mjs";
import { TplinkXx230Adapter } from "./tplinkXx230.mjs";

// O que falta para cada fabricante virar "supported". Preencher a partir de um roteador de bancada
// (modelo e firmware exatos), olhando o painel no navegador com as ferramentas de desenvolvedor.
const COMMON = [
  "modelo e versao de firmware exatos do roteador de bancada",
  "fluxo de login do painel (formulario, cookie/token, protecao CSRF)",
  "onde ficam SSID e senha de 2.4 GHz e 5 GHz e como o painel salva",
  "como reler a configuracao para confirmar a troca"
];

const ADAPTERS = {
  // TP-Link: validado o XX230v (HTTP, porta 80, Band Steering ligado); outros modelos ficam "em validacao"
  tplink: new TplinkXx230Adapter(),
  // Huawei: validado o EG8145V5-V2; outros modelos Huawei ficam "em validacao" (supportsModel)
  huawei: new HuaweiOntAdapter(),
  // Stavix: validado o MP-G421R (HTTP, porta 80, painel Realtek/Boa); os outros modelos Stavix usam o mesmo painel
  stavix: new StavixRealtekAdapter(),
  mercusys: new PendingValidationAdapter("mercusys", [...COMMON, "credencial de administrador nao informada"])
};

export function adapterFor(vendor) {
  return ADAPTERS[vendor] ?? null;
}

export function listAdapters() {
  return Object.values(ADAPTERS).map((a) => ({ vendor: a.vendor, ...a.capabilities(), validatedModels: a.validatedModels }));
}

export function allAdapters() {
  return Object.values(ADAPTERS);
}

/** So para testes: troca/inclui um adaptador. */
export function registerAdapter(adapter) {
  ADAPTERS[adapter.vendor] = adapter;
}
