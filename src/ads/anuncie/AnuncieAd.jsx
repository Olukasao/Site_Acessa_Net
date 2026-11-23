import { useRef } from "react";
import { gsap } from "gsap";
import SplitWords from "../SplitWords";
import { useAdTimeline } from "../useAdTimeline";
import "./anuncie.css";

// "Anuncie aqui": a placa amarela que todo comerciante reconhece. O quadro
// tracejado é o próprio espaço do anúncio, vago, esperando a marca de alguém.
const BASE = 7;
const DAILY = 1000;

function buildTimeline(root, { duration }) {
  const q = gsap.utils.selector(root);
  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
  const num = q(".n-num")[0];
  const counter = { v: 0 };

  tl.set(q(".ad-word > span"), { yPercent: 115 }, 0)
    .fromTo(q(".n-slot"), { autoAlpha: 0, scale: 0.86, rotation: -3 }, { autoAlpha: 1, scale: 1, rotation: 0, duration: 0.9, ease: "back.out(1.6)" }, 0.1)
    .fromTo(q(".n-slot__label"), { autoAlpha: 0, scale: 0.8 }, { autoAlpha: 1, scale: 1, duration: 0.6, ease: "back.out(1.8)" }, 0.9)
    .to(q(".n-title .ad-word > span"), { yPercent: 0, duration: 0.7, stagger: 0.07, ease: "power4.out" }, 1.2)
    .fromTo(q(".n-stat"), { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 2.6)
    .fromTo(
      counter,
      { v: 0 },
      {
        v: DAILY,
        duration: 1.4,
        ease: "power2.out",
        onUpdate: () => {
          if (num) num.textContent = Math.round(counter.v).toLocaleString("pt-BR");
        },
      },
      2.6
    )
    .fromTo(q(".n-stat__label"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 }, 3.4)
    // Um "carimbo" no fim, para o número ficar na memória.
    .fromTo(q(".n-stat"), { scale: 1 }, { scale: 1.06, duration: 0.18, yoyo: true, repeat: 1, ease: "power1.inOut" }, 4.05);

  tl.timeScale(BASE / Math.max(duration || BASE, 3));
  return tl;
}

export default function AnuncieAd({ active = true, duration = BASE, reduced = false }) {
  const root = useRef(null);
  useAdTimeline(root, { active, reduced, duration, build: buildTimeline });

  return (
    <div className="n-ad" ref={root}>
      <div className="n-slot">
        <span className="n-slot__label">SUA MARCA AQUI</span>
      </div>

      <div className="n-copy">
        <h2 className="n-title">
          <SplitWords text="ANUNCIE SUA LOJA/MARCA AQUI!" />
        </h2>
        <p className="n-stat" aria-label="Mais de 1.000 acessos por dia">
          <span className="n-stat__plus">+ DE</span>
          <span className="n-num">{DAILY.toLocaleString("pt-BR")}</span>
          <span className="n-stat__label">ACESSOS POR DIA</span>
        </p>
      </div>
    </div>
  );
}
