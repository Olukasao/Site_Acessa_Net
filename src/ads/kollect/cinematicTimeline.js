import { gsap } from "gsap";

// Timeline única do comercial. Os tempos abaixo são em "segundos de roteiro"
// (volta de 13 s); timeScale ajusta para a duração configurada.
//
//  0.0–2.2  Cena 1  linha vermelha, figure revelada pela luz lateral, "NÃO É APENAS UMA FIGURE."
//  2.2–4.7  Cena 2  segunda figure com luz de cima, "É UMA HISTÓRIA." / "UMA PAIXÃO."
//  4.7–8.3  Cena 3  montagem de caixas com movimento lateral, "SEU UNIVERSO. SUA COLEÇÃO."
//  8.3–12.4 Cena 4  escurece, logo revelada com brilho, "BEYOND COLLECTING." / "DESCUBRA A KOLLECT."
// 12.4–13.0 Cena 5  fade para preto: a volta seguinte começa do preto, sem corte.
export const BASE_DURATION = 13;

const words = (q, selector) => q(`${selector} .ad-word > span`);

export function buildKollectTimeline(root, { duration = BASE_DURATION, loop = true, speed = 1 } = {}) {
  const q = gsap.utils.selector(root);
  const tl = gsap.timeline({ repeat: loop ? -1 : 0, defaults: { ease: "power3.out" } });

  // Estado inicial de cada volta.
  tl.set(q(".k-scene"), { autoAlpha: 0, scale: 1 }, 0)
    .set(q(".ad-word > span"), { yPercent: 115 }, 0)
    .set(q(".k-fade"), { autoAlpha: 1 }, 0)
    .set(q(".k-line"), { autoAlpha: 1, scaleX: 0 }, 0)
    .set(q(".k-bars span"), { autoAlpha: 1, yPercent: 0 }, 0)
    .set(q(".k-discover"), { autoAlpha: 0, y: 14 }, 0)
    .set(q(".k-logo img"), { opacity: 0.8 }, 0);

  tl.to(q(".k-fade"), { autoAlpha: 0, duration: 0.6, ease: "power1.out" }, 0);

  // ---- Cena 1 -----------------------------------------------------------
  tl.to(q(".k-line"), { scaleX: 1, duration: 0.9, ease: "expo.inOut" }, 0.1)
    .to(q(".k-line"), { autoAlpha: 0, duration: 0.7, ease: "power1.in" }, 1.1)
    .set(q(".k-scene--s1"), { autoAlpha: 1 }, 0.3)
    .fromTo(
      q(".k-scene--s1 .k-figure__subject"),
      { autoAlpha: 0, scale: 1.16, x: -24 },
      { autoAlpha: 1, scale: 1, x: 0, duration: 1.8, ease: "power2.out" },
      0.3
    )
    .fromTo(q(".k-scene--s1 .k-figure"), { scale: 1 }, { scale: 1.07, duration: 2.2, ease: "none" }, 0.3)
    .fromTo(
      q(".k-scene--s1 .k-figure__halo"),
      { autoAlpha: 0, xPercent: -30 },
      { autoAlpha: 1, xPercent: 0, duration: 1.4, ease: "power2.out" },
      0.4
    )
    .fromTo(q(".k-scene--s1 .k-figure__base"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 1 }, 0.6)
    .to(words(q, ".k-t1"), { yPercent: 0, duration: 0.75, stagger: 0.08, ease: "power4.out" }, 0.8)
    .to(q(".k-scene--s1"), { autoAlpha: 0, scale: 1.05, duration: 0.5, ease: "power2.in" }, 2.05);

  // ---- Cena 2 -----------------------------------------------------------
  tl.set(q(".k-scene--s2"), { autoAlpha: 1 }, 2.3)
    .fromTo(
      q(".k-scene--s2 .k-figure__subject"),
      { autoAlpha: 0, y: 36, scale: 1.08 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 1.4, ease: "power2.out" },
      2.3
    )
    .fromTo(q(".k-scene--s2 .k-figure"), { scale: 1.04 }, { scale: 1, duration: 2.4, ease: "none" }, 2.3)
    .fromTo(
      q(".k-scene--s2 .k-figure__halo"),
      { autoAlpha: 0, yPercent: -25 },
      { autoAlpha: 1, yPercent: 0, duration: 1.2, ease: "power2.out" },
      2.35
    )
    .fromTo(q(".k-scene--s2 .k-figure__base"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8 }, 2.5)
    .to(words(q, ".k-t2a"), { yPercent: 0, duration: 0.7, stagger: 0.08, ease: "power4.out" }, 2.6)
    .fromTo(q(".k-t2a"), { opacity: 1 }, { opacity: 0.38, duration: 0.5 }, 3.4)
    .to(words(q, ".k-t2b"), { yPercent: 0, duration: 0.7, stagger: 0.1, ease: "power4.out" }, 3.4)
    .to(q(".k-scene--s2"), { autoAlpha: 0, scale: 1.04, duration: 0.45, ease: "power2.in" }, 4.55);

  // ---- Cena 3 -----------------------------------------------------------
  tl.set(q(".k-scene--s3"), { autoAlpha: 1 }, 4.75)
    .fromTo(
      q(".k-slot"),
      { autoAlpha: 0, y: 50, scale: 0.94 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.9, stagger: 0.12, ease: "power3.out" },
      4.8
    )
    .fromTo(q(".k-shelf__track"), { xPercent: 9 }, { xPercent: -9, duration: 3.6, ease: "none" }, 4.75)
    .fromTo(q(".k-sweep"), { xPercent: 0 }, { xPercent: 450, duration: 1.3, ease: "power2.inOut" }, 5.4)
    .to(q(".k-sweep"), { xPercent: 0, duration: 1.3, ease: "power2.inOut" }, 6.9)
    .to(words(q, ".k-t3a"), { yPercent: 0, duration: 0.7, stagger: 0.08, ease: "power4.out" }, 5.3)
    .to(words(q, ".k-t3b"), { yPercent: 0, duration: 0.7, stagger: 0.08, ease: "power4.out" }, 5.9)
    .to(q(".k-scene--s3"), { autoAlpha: 0, duration: 0.5, ease: "power2.in" }, 7.9);

  // ---- Cena 4 -----------------------------------------------------------
  tl.to(q(".k-bars span"), { yPercent: (i) => (i === 0 ? -100 : 100), duration: 0.8, ease: "power2.inOut" }, 8.2)
    .set(q(".k-scene--s4"), { autoAlpha: 1 }, 8.4)
    .fromTo(
      q(".k-bloom"),
      { autoAlpha: 0, scale: 0.35 },
      { autoAlpha: 1, scale: 1, duration: 1.6, ease: "power2.out" },
      8.45
    )
    .fromTo(
      q(".k-logo"),
      { autoAlpha: 0, scale: 0.9, y: 10 },
      { autoAlpha: 1, scale: 1, y: 0, duration: 1.4, ease: "expo.out" },
      8.8
    )
    .fromTo(q(".k-s4__inner"), { scale: 1 }, { scale: 1.04, duration: 3.6, ease: "none" }, 8.8)
    .fromTo(q(".k-logo__glint"), { xPercent: 0 }, { xPercent: 520, duration: 1.1, ease: "power2.inOut" }, 9.8)
    .to(q(".k-logo img"), { opacity: 1, duration: 0.5 }, 10.2)
    .to(words(q, ".k-tagline"), { yPercent: 0, duration: 0.7, stagger: 0.07, ease: "power4.out" }, 10.0)
    .to(q(".k-discover"), { autoAlpha: 1, y: 0, duration: 0.6 }, 10.6);

  // ---- Cena 5: segura e volta ao preto --------------------------------------
  tl.to(q(".k-fade"), { autoAlpha: 1, duration: 0.6, ease: "power1.in" }, BASE_DURATION - 0.6);

  tl.timeScale((BASE_DURATION / Math.max(duration, 4)) * speed);
  return tl;
}

// Partículas: movimento contínuo e independente da timeline.
export function startParticles(root) {
  const q = gsap.utils.selector(root);
  q(".k-particles span").forEach((dot, i) => {
    const duration = 4 + (i % 5);
    const delay = (i * 0.37) % 3;
    // Sobe numa volta completa; acende e apaga no mesmo ritmo.
    gsap.fromTo(dot, { y: 30 }, { y: -100 - (i % 4) * 25, duration, delay, repeat: -1, ease: "none" });
    gsap.fromTo(dot, { opacity: 0 }, { opacity: 0.85, duration: duration / 2, delay, repeat: -1, yoyo: true, ease: "sine.inOut" });
  });
}
