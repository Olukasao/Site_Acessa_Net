// Anúncios da tela de espera do Wi-Fi público (entre o cadastro e a liberação).
//
// Cada marca tem a sua vez, em tela cheia, na ordem desta lista. A internet só é
// liberada quando todas passaram: o tempo total de espera é a soma dos `seconds`.
// Para mudar a ordem, o tempo de cada marca ou tirar uma, edite só esta lista.
//
// Botões de cada marca (Instagram, Site): antes do login o celular só alcança este
// site, então o clique NÃO abre o link na hora. Ele vira o destino da pessoa depois
// de conectar: quando a contagem acaba, o roteador libera a internet e manda direto
// para o link escolhido. Botão com `href` vazio não aparece (nunca inventar link).

import AcessaNetAd from "./acessanet/AcessaNetAd";
import CinematicAd from "./kollect/CinematicAd";
import ProjectaAd from "./projecta/ProjectaAd";
import kollectLogo from "./assets/kollect-logo.webp";
import kollectWorld from "./assets/kollect-yourworld.webp";
import projectaLogo from "./assets/projecta-logo.webp";
import projectaHome from "./assets/projecta-home.webp";
import acessanetLogo from "../assets/logo-acessanet-3d.png";

export const adSlots = [
  {
    id: "acessanet",
    name: "AcessaNet",
    seconds: 10,
    Component: AcessaNetAd,
    links: [
      { kind: "instagram", label: "Instagram", href: "" },
      { kind: "site", label: "Site", href: "https://acessanet.com.br/" },
    ],
  },
  {
    id: "kollect",
    name: "Kollect",
    seconds: 13,
    Component: CinematicAd,
    links: [
      { kind: "instagram", label: "Instagram", href: "" },
      { kind: "site", label: "Site", href: "" },
    ],
  },
  {
    id: "projecta",
    name: "Projecta",
    seconds: 10,
    Component: ProjectaAd,
    links: [
      { kind: "instagram", label: "Instagram", href: "https://www.instagram.com/projectaempreendimentos/" },
      { kind: "site", label: "Site", href: "https://projectaempreendimentos.com.br/" },
    ],
  },
];

export const totalAdSeconds = adSlots.reduce((sum, slot) => sum + slot.seconds, 0);

// Baixa as imagens enquanto a pessoa ainda preenche o cadastro.
export function preloadAdAssets() {
  [acessanetLogo, kollectLogo, kollectWorld, projectaLogo, projectaHome].forEach((src) => {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  });
}
