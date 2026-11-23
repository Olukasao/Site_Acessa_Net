import { useRef } from "react";
import { gsap } from "gsap";
import SplitWords from "../SplitWords";
import { useAdTimeline } from "../useAdTimeline";
import { company, plans } from "../../data/site";
import logo from "../../assets/logo-acessanet-3d.png";
import "./acessanet.css";

// Preços e planos vêm de site.js (fonte única); aqui só a apresentação.
const plan = plans.find((p) => p.id === "800") || plans[0];
const BASE = 10;

const STREAKS = [12, 24, 37, 49, 61, 73, 86];

function buildTimeline(root, { duration }) {
  const q = gsap.utils.selector(root);
  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

  // Luz correndo pela fibra: contínuo, fora da timeline.
  q(".a-streaks span").forEach((line, i) => {
    gsap.fromTo(
      line,
      { xPercent: 0 },
      { xPercent: 450, duration: 1.6 + (i % 3) * 0.5, delay: (i * 0.29) % 1.4, repeat: -1, ease: "power1.in" }
    );
  });

  tl.set(q(".a-scene"), { autoAlpha: 0 }, 0)
    .set(q(".ad-word > span"), { yPercent: 115 }, 0)
    .set(q(".a-scene--s1"), { autoAlpha: 1 }, 0);

  // Cena 1: marca
  tl.fromTo(q(".a-ring"), { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 1.4, ease: "expo.out" }, 0.1)
    .fromTo(q(".a-hero-logo"), { autoAlpha: 0, scale: 0.82, y: 24 }, { autoAlpha: 1, scale: 1, y: 0, duration: 1.2, ease: "expo.out" }, 0.25)
    .to(q(".a-scene--s1 .ad-word > span"), { yPercent: 0, duration: 0.7, stagger: 0.07, ease: "power4.out" }, 0.9)
    .to(q(".a-scene--s1"), { autoAlpha: 0, scale: 1.04, duration: 0.4, ease: "power2.in" }, 3.0);

  // Cena 2: plano em destaque, com contador de velocidade
  const counter = { v: 0 };
  const num = q(".a-num")[0];
  tl.set(q(".a-scene--s2"), { autoAlpha: 1 }, 3.3)
    .fromTo(q(".a-tag"), { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 3.35)
    .fromTo(q(".a-speed"), { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.8, ease: "expo.out" }, 3.45)
    .fromTo(
      counter,
      { v: 0 },
      {
        v: plan.speed,
        duration: 1.5,
        ease: "power2.out",
        onUpdate: () => {
          if (num) num.textContent = String(Math.round(counter.v));
        },
      },
      3.45
    )
    .fromTo(q(".a-price"), { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 4.5)
    .fromTo(q(".a-scene--s2 .a-sub"), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 4.9)
    .to(q(".a-scene--s2"), { autoAlpha: 0, duration: 0.4, ease: "power2.in" }, 6.5);

  // Cena 3 (quadro final): app, suporte e contato
  tl.set(q(".a-scene--s3"), { autoAlpha: 1 }, 6.8)
    .to(q(".a-scene--s3 .ad-word > span"), { yPercent: 0, duration: 0.7, stagger: 0.06, ease: "power4.out" }, 6.85)
    .fromTo(q(".a-perk"), { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.14 }, 7.2)
    .fromTo(q(".a-phone"), { autoAlpha: 0, scale: 0.92 }, { autoAlpha: 1, scale: 1, duration: 0.6, ease: "back.out(1.6)" }, 7.9);

  tl.timeScale(BASE / Math.max(duration || BASE, 4));
  return tl;
}

export default function AcessaNetAd({ active = true, duration = BASE, reduced = false }) {
  const root = useRef(null);
  useAdTimeline(root, { active, reduced, duration, build: buildTimeline });

  return (
    <div className="a-ad" ref={root}>
      <div className="a-bg" aria-hidden="true" />
      <div className="a-streaks" aria-hidden="true">
        {STREAKS.map((top) => (
          <span key={top} style={{ top: `${top}%` }} />
        ))}
      </div>

      <div className="a-scene a-scene--s1">
        <span className="a-ring" aria-hidden="true" />
        <img className="a-hero-logo" src={logo} alt="AcessaNet" width="877" height="327" decoding="async" />
        <p className="a-title">
          <SplitWords text="Internet de fibra óptica" />
        </p>
      </div>

      <div className="a-scene a-scene--s2">
        <span className="a-tag">{plan.badge || "Plano em destaque"}</span>
        <p className="a-speed" aria-label={`${plan.speed} ${plan.unit}`}>
          <span className="a-num">{plan.speed}</span>
          <span className="a-unit">{plan.unit}</span>
        </p>
        <p className="a-price">
          por <strong>{plan.priceText}</strong>/mês
        </p>
        <p className="a-sub">{plan.tagline}</p>
      </div>

      <div className="a-scene a-scene--s3">
        <img className="a-mini-logo" src={logo} alt="" width="877" height="327" decoding="async" />
        <p className="a-title a-title--sm">
          <SplitWords text="Tudo na palma da mão" />
        </p>
        <ul className="a-perks">
          <li className="a-perk">
            <strong>Suporte 24h</strong>
            <span>de segunda a segunda</span>
          </li>
          <li className="a-perk">
            <strong>App AcessaNet</strong>
            <span>fatura, Pix e teste de velocidade</span>
          </li>
        </ul>
        <p className="a-phone">
          Contrate: <strong>{company.phone}</strong>
        </p>
      </div>
    </div>
  );
}
