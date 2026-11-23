// Configuração do comercial "KOLLECT YOUR WORLD". Tudo o que muda com frequência fica aqui.
import { kollectAssets } from "./assets";

export const kollectConfig = {
  // Uma volta completa, em segundos. A timeline foi desenhada em 13 s e é
  // ajustada para o valor escolhido. Na espera do Wi-Fi vale o `seconds` de adsConfig.js.
  duration: 13,
  // 1 = normal; 1.2 = 20% mais rápido.
  transitionSpeed: 1,
  loop: true,

  assets: kollectAssets,

  texts: {
    // Lido por leitores de tela (a assinatura em si é a imagem oficial).
    signature: "KOLLECT YOUR WORLD.",
    credit: "Action figures, estátuas e colecionáveis de anime.",
    // Coluna vertical em katakana: "Kollect your world".
    katakana: "コレクト・ユア・ワールド",
  },

  colors: {
    ground: "#1F1F20",
    pattern: "#F3F1EC",
    paper: "#F3F1EC",
    world: "#E21B2D",
  },

  // Botões. Desligados no portal do Wi-Fi: antes do login o celular não abre
  // outro site. Só aparecem com `show: true` E um `href` preenchido (sem link inventado).
  cta: { show: false, label: "Conheça a Kollect", href: "" },
  instagram: { show: false, label: "Instagram", href: "" },
};
