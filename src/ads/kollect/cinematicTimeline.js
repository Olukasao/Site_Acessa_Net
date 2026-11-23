import { gsap } from "gsap";
import { GLOBE_R, MERIDIAN_PHASES, meridianRx } from "./AdScene";

const RIM = 2 * Math.PI * GLOBE_R + 1; // comprimento do contorno, para o traço se desenhar

// Timeline única, em "segundos de roteiro" (volta de 13 s); timeScale ajusta.
//
//  0.0–3.0  REVELAÇÃO   o contorno do globo se desenha e a grade aparece; a figure
//                       sobe em silhueta; KOLLECT / YOUR WORLD nascem das máscaras
//                       (marca legível antes de 2 s); a luz acende.
//  3.0–6.2  UNIVERSO    o padrão da marca aparece e corre; câmera deriva em 2.5D
//                       (globo e figure em ritmos diferentes).
//  6.2–9.2  IDENTIDADE  a assinatura sai; a câmera entra nos olhos da figure e volta.
//  9.2–12.1 KOLLECT YOUR WORLD  a assinatura volta e o key visual fica parado.
// 12.1–13.0 a luz apaga, o globo se desfaz, fade para preto: a volta
//           seguinte começa exatamente desse estado, sem corte.
export const BASE_DURATION = 13;

export function buildKollectTimeline(root, { duration = BASE_DURATION, loop = true, speed = 1 } = {}) {
  const q = gsap.utils.selector(root);
  const tl = gsap.timeline({ repeat: loop ? -1 : 0, defaults: { ease: "power3.out" } });
  const lines = q(".k-mask img");

  // Estado inicial de cada volta.
  tl.set(q(".k-fade"), { autoAlpha: 1 }, 0)
    .set(q(".k-globe"), { scale: 0.92, xPercent: 0 }, 0)
    .set(q(".k-globe__rim"), { strokeDasharray: RIM, strokeDashoffset: RIM }, 0)
    .set(q(".k-globe__grid"), { autoAlpha: 0 }, 0)
    .set(q(".k-hero"), { yPercent: 10 }, 0)
    .set(q(".k-hero__silhouette"), { opacity: 1 }, 0)
    .set(q(".k-stage"), { scale: 1, xPercent: 0 }, 0)
    .set(lines, { yPercent: 105 }, 0)
    .set(q(".k-sign"), { autoAlpha: 1, y: 0 }, 0)
    .set(q(".k-credit"), { autoAlpha: 0 }, 0)
    .set([q(".k-pattern"), q(".k-kana")], { autoAlpha: 0 }, 0);

  // REVELAÇÃO
  tl.to(q(".k-fade"), { autoAlpha: 0, duration: 0.7, ease: "power1.out" }, 0)
    .to(q(".k-globe__rim"), { strokeDashoffset: 0, duration: 1.7, ease: "power2.inOut" }, 0.15)
    .to(q(".k-globe"), { scale: 1, duration: 2.6, ease: "power2.out" }, 0.15)
    .to(q(".k-globe__grid"), { autoAlpha: 1, duration: 1.1, ease: "power1.inOut" }, 1.0)
    .to(q(".k-hero"), { yPercent: 0, duration: 2.6, ease: "power2.out" }, 0.35)
    .to(lines[0], { yPercent: 0, duration: 0.9, ease: "power4.out" }, 1.05)
    .to(lines[1], { yPercent: 0, duration: 0.9, ease: "power4.out" }, 1.4)
    .to(q(".k-hero__silhouette"), { opacity: 0, duration: 0.9, ease: "power2.inOut" }, 2.1)
    .to(q(".k-kana"), { autoAlpha: 1, duration: 0.8, ease: "power1.out" }, 2.5)
    .to(q(".k-credit"), { autoAlpha: 1, duration: 0.6, ease: "power1.out" }, 2.6);

  // UNIVERSO
  tl.to(q(".k-pattern"), { autoAlpha: 1, duration: 1.4, ease: "power1.inOut" }, 3.0)
    .to(q(".k-stage"), { scale: 1.04, xPercent: -2, duration: 3.2, ease: "sine.inOut" }, 3.0)
    .to(q(".k-globe"), { xPercent: 4, duration: 3.2, ease: "sine.inOut" }, 3.0);

  // IDENTIDADE
  tl.to(q(".k-sign"), { autoAlpha: 0, y: 18, duration: 0.5, ease: "power2.in" }, 6.2)
    .to(q(".k-stage"), { scale: 1.7, xPercent: 0, duration: 1.5, ease: "power3.inOut" }, 6.3)
    .to(q(".k-globe"), { xPercent: 0, duration: 1.5, ease: "power3.inOut" }, 6.3)
    .to(q(".k-stage"), { scale: 1, duration: 1.3, ease: "power3.inOut" }, 8.3);

  // KOLLECT YOUR WORLD
  tl.set(lines, { yPercent: 105 }, 9.1)
    .set(q(".k-sign"), { autoAlpha: 1, y: 0 }, 9.1)
    .set(q(".k-credit"), { autoAlpha: 0 }, 9.1)
    .to(lines[0], { yPercent: 0, duration: 0.9, ease: "power4.out" }, 9.2)
    .to(lines[1], { yPercent: 0, duration: 0.9, ease: "power4.out" }, 9.5)
    .to(q(".k-credit"), { autoAlpha: 1, duration: 0.6, ease: "power1.out" }, 10.1);

  // Apaga a luz e fecha a volta
  tl.to(q(".k-hero__silhouette"), { opacity: 1, duration: 0.5, ease: "power2.in" }, 12.0)
    .to(lines, { yPercent: -105, duration: 0.5, ease: "power2.in", stagger: 0.06 }, 12.05)
    .to(q(".k-credit"), { autoAlpha: 0, duration: 0.3 }, 12.05)
    .to([q(".k-pattern"), q(".k-kana"), q(".k-globe__grid")], { autoAlpha: 0, duration: 0.5 }, 12.1)
    .to(q(".k-globe__rim"), { strokeDashoffset: -RIM, duration: 0.8, ease: "power2.in" }, 12.1)
    .to(q(".k-fade"), { autoAlpha: 1, duration: 0.5, ease: "power1.in" }, BASE_DURATION - 0.5);

  tl.timeScale((BASE_DURATION / Math.max(duration, 4)) * speed);
  return tl;
}

// Movimento ambiente, independente da timeline: o padrão da marca corre em
// faixas alternadas (como no key visual) e a lua dá voltas na órbita.
export function startAmbient(root) {
  const q = gsap.utils.selector(root);
  q(".k-pattern__row span").forEach((strip, i) => {
    const row = strip.parentElement;
    // Largura exata de uma logo do padrão (62% da altura da faixa x proporção da logo).
    const tile = row.clientHeight * 0.62 * (1600 / 273);
    if (!tile) return;
    const dir = i % 2 === 0 ? -1 : 1;
    gsap.fromTo(
      strip,
      { x: dir < 0 ? 0 : -tile },
      { x: dir < 0 ? -tile : 0, duration: 16 + (i % 3) * 4, ease: "none", repeat: -1 }
    );
  });
  // Globo girando: cada meridiano muda de largura conforme a fase.
  const meridians = q(".k-globe__mer");
  if (meridians.length) {
    const spin = { t: 0 };
    gsap.to(spin, {
      t: Math.PI,
      duration: 14,
      ease: "none",
      repeat: -1,
      onUpdate: () => {
        meridians.forEach((el, i) => el.setAttribute("rx", meridianRx(MERIDIAN_PHASES[i] + spin.t).toFixed(2)));
      },
    });
  }
}
