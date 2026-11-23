import logo from "../assets/kollect-logo.webp";
import yourWorld from "../assets/kollect-yourworld.webp";
import head from "../assets/kollect-head.webp";

// Imagens do comercial.
// - logo / yourWorld: assinatura oficial "KOLLECT YOUR WORLD" (recortada do key
//   visual da marca, em alta). Trocar só por arquivos oficiais, sem redesenhar.
// - hero: a figure protagonista. Hoje é o mascote da logo (o único personagem
//   oficial disponível). Para trocar por foto de produto: PNG/WebP com fundo
//   transparente, figure inteira de frente, >= 1200 px de altura, luz vinda da
//   esquerda, de cima (combina com a sombra projetada no layout). Defina `hero.photo` e a cena passa
//   a usar a foto no lugar do mascote, com a mesma silhueta e o mesmo movimento.
export const kollectAssets = {
  logo,
  yourWorld,
  hero: {
    mascot: head,
    photo: null,
    alt: "Mascote da Kollect",
  },
};
