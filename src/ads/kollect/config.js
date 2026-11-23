// Configuração do comercial da KOLLECT. Tudo o que muda com frequência fica aqui.
import { kollectAssets } from "./assets";

export const kollectConfig = {
  // Duração de uma volta completa do comercial, em segundos. A timeline foi
  // desenhada em 13 s e é acelerada/desacelerada para caber no valor escolhido.
  // Na tela de espera do Wi-Fi quem manda é o `seconds` de adsConfig.js.
  duration: 13,
  // 1 = normal; 1.2 = transições 20% mais rápidas.
  transitionSpeed: 1,
  loop: true,

  logo: kollectAssets.logo,
  // Troque `src` pelas fotos oficiais (de preferência PNG/WebP com fundo
  // transparente, ~900 px de altura). Sem foto, entra a figure estilizada do mascote.
  figures: kollectAssets.figures,

  texts: {
    scene1: "NÃO É APENAS UMA FIGURE.",
    scene2a: "É UMA HISTÓRIA.",
    scene2b: "UMA PAIXÃO.",
    scene3a: "SEU UNIVERSO.",
    scene3b: "SUA COLEÇÃO.",
    tagline: "BEYOND COLLECTING.",
    discover: "DESCUBRA A KOLLECT.",
  },

  colors: {
    black: "#050505",
    graphite: "#111115",
    white: "#F5F5F5",
    red: "#E21B2D",
  },

  // Botões. Ficam desligados no portal do Wi-Fi: antes do login o celular não
  // consegue abrir outro site. Só aparecem com `show: true` E um `href` preenchido.
  // Não há link oficial cadastrado: preencha com o endereço real da loja.
  cta: { show: false, label: "CONHEÇA A KOLLECT", href: "" },
  instagram: { show: false, label: "Instagram", href: "" },
};
