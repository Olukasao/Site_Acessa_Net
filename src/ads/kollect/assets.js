import logo from "../assets/kollect-logo.webp";
import yourWorld from "../assets/kollect-yourworld.webp";

// Assinatura oficial "KOLLECT YOUR WORLD" (recortada do key visual da marca, em
// alta). Trocar só por arquivos oficiais, sem redesenhar.
// Fotos que passam dentro do globo: tudo o que estiver em
// src/ads/assets/kollect-fotos/, em ordem de nome (ver o LEIA-ME da pasta).
const photoFiles = import.meta.glob("../assets/kollect-fotos/*.{webp,jpg,jpeg,png,avif}", {
  eager: true,
  import: "default",
});
const photos = Object.keys(photoFiles)
  .sort()
  .map((path) => photoFiles[path]);

export const kollectAssets = {
  logo,
  yourWorld,
  photos,
};
