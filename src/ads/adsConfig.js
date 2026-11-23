// Anúncios da tela de espera do Wi-Fi público (entre o cadastro e a liberação).
//
// Cada marca tem a sua vez, em tela cheia, na ordem desta lista. A internet só é
// liberada quando todas passaram: o tempo total de espera é a soma dos `seconds`.
// Para mudar a ordem, o tempo de cada marca ou tirar uma, edite só esta lista.
//
// Os anúncios NÃO devem levar o visitante para fora da página: antes do login o
// celular só alcança este site, e sair interromperia a liberação. Por isso os
// botões de ação ficam desligados aqui (ver kollect/config.js).

import AcessaNetAd from "./acessanet/AcessaNetAd";
import CinematicAd from "./kollect/CinematicAd";
import ProjectaAd from "./projecta/ProjectaAd";
import kollectLogo from "./assets/kollect-logo.webp";
import kollectHead from "./assets/kollect-head.webp";
import projectaLogo from "./assets/projecta-logo.webp";
import projectaHome from "./assets/projecta-home.webp";
import acessanetLogo from "../assets/logo-acessanet-3d.png";

export const adSlots = [
  { id: "acessanet", name: "AcessaNet", seconds: 10, Component: AcessaNetAd },
  { id: "kollect", name: "Kollect", seconds: 13, Component: CinematicAd },
  { id: "projecta", name: "Projecta", seconds: 10, Component: ProjectaAd },
];

export const totalAdSeconds = adSlots.reduce((sum, slot) => sum + slot.seconds, 0);

// Baixa as imagens enquanto a pessoa ainda preenche o cadastro.
export function preloadAdAssets() {
  [acessanetLogo, kollectLogo, kollectHead, projectaLogo, projectaHome].forEach((src) => {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  });
}
