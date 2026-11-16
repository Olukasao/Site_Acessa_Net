import { PendingValidationAdapter } from "./base.mjs";

// O que falta para cada fabricante virar "supported". Preencher a partir de um roteador de bancada
// (modelo e firmware exatos), olhando o painel no navegador com as ferramentas de desenvolvedor.
const COMMON = [
  "modelo e versao de firmware exatos do roteador de bancada",
  "fluxo de login do painel (formulario, cookie/token, protecao CSRF)",
  "onde ficam SSID e senha de 2.4 GHz e 5 GHz e como o painel salva",
  "como reler a configuracao para confirmar a troca"
];

const ADAPTERS = {
  tplink: new PendingValidationAdapter("tplink", [...COMMON, "painel pede so a senha (sem usuario): confirmar o formato do envio (alguns firmwares cifram a senha no navegador)"]),
  huawei: new PendingValidationAdapter("huawei", [...COMMON]),
  stavix: new PendingValidationAdapter("stavix", [...COMMON, "o SGP nao tem 'Stavix' no Tipo equipamento: definir como identificar (cadastro no SGP ou leitura do proprio roteador)"]),
  mercusys: new PendingValidationAdapter("mercusys", [...COMMON, "credencial de administrador nao informada"])
};

export function adapterFor(vendor) {
  return ADAPTERS[vendor] ?? null;
}

export function listAdapters() {
  return Object.values(ADAPTERS).map((a) => ({ vendor: a.vendor, ...a.capabilities(), validatedModels: a.validatedModels }));
}

/** So para testes: troca/inclui um adaptador. */
export function registerAdapter(adapter) {
  ADAPTERS[adapter.vendor] = adapter;
}
