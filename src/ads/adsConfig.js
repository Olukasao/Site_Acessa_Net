// Anúncios da tela de espera do Wi-Fi público (entre o cadastro e a liberação).
//
// Cada marca tem a sua vez, em tela cheia, na ordem desta lista. A internet só é
// liberada quando todas passaram: o tempo total de espera é a soma dos `seconds`.
// Para mudar a ordem, o tempo de cada marca ou tirar uma, edite só esta lista.
//
// Botões de cada marca: `label` é a ação (curta, cabe no celular) e `goes` diz para
// onde a pessoa vai, na mensagem da barra. Antes do login o celular só alcança este
// site, então o clique NÃO abre o link na hora. Ele vira o destino da pessoa depois
// de conectar: quando a contagem acaba, o roteador libera a internet e manda direto
// para o link escolhido. Botão com `href` vazio não aparece (nunca inventar link).

import AcessaNetAd from "./acessanet/AcessaNetAd";
import CinematicAd from "./kollect/CinematicAd";
import ProjectaAd from "./projecta/ProjectaAd";
import AnuncieAd from "./anuncie/AnuncieAd";
import kollectLogo from "./assets/kollect-logo.webp";
import kollectWorld from "./assets/kollect-yourworld.webp";
import projectaLogo from "./assets/projecta-logo.webp";
import projectaHome from "./assets/projecta-home.webp";
import acessanetLogo from "../assets/logo-acessanet-3d.png";
import { whatsappLink } from "../data/site";

export const adSlots = [
  {
    id: "acessanet",
    name: "AcessaNet",
    seconds: 10,
    Component: AcessaNetAd,
    links: [
      {
        kind: "whatsapp",
        label: "Contratar",
        goes: "o WhatsApp da AcessaNet",
        href: whatsappLink("Olá! Vi o anúncio no Wi-Fi grátis e quero contratar a internet da AcessaNet."),
      },
      { kind: "instagram", label: "Instagram", goes: "o Instagram da AcessaNet", href: "https://www.instagram.com/acessanet_/" },
      { kind: "site", label: "Site", goes: "o site da AcessaNet", href: "https://acessanet.com.br/" },
    ],
  },
  {
    id: "kollect",
    name: "Kollect",
    seconds: 13,
    Component: CinematicAd,
    links: [
      { kind: "instagram", label: "Instagram", goes: "o Instagram da Kollect", href: "https://www.instagram.com/kollectbr/" },
      { kind: "whatsapp", label: "Comprar", goes: "o WhatsApp da Kollect", href: "https://api.whatsapp.com/send?phone=5511932085937" },
      { kind: "links", label: "Links", goes: "os links da Kollect", href: "https://linktr.ee/KollectBr" },
    ],
  },
  {
    id: "projecta",
    name: "Projecta",
    seconds: 10,
    Component: ProjectaAd,
    links: [
      { kind: "site", label: "Imóveis", goes: "o site da Projecta", href: "https://projectaempreendimentos.com.br/" },
      { kind: "instagram", label: "Instagram", goes: "o Instagram da Projecta", href: "https://www.instagram.com/projectaempreendimentos/" },
      // Número do WhatsApp que está no site da própria Projecta.
      { kind: "whatsapp", label: "WhatsApp", goes: "o WhatsApp da Projecta", href: "https://wa.me/5511993878619" },
    ],
  },
  {
    // Venda do próprio espaço: sempre o último.
    id: "anuncie",
    name: "Anuncie aqui",
    seconds: 7,
    Component: AnuncieAd,
    links: [
      // Quem quer anunciar fala com o mesmo WhatsApp da AcessaNet.
      {
        kind: "whatsapp",
        label: "Quero anunciar",
        goes: "o WhatsApp da AcessaNet",
        href: whatsappLink("Olá! Vi o Wi-Fi grátis da AcessaNet e quero anunciar minha loja/marca nele."),
      },
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
