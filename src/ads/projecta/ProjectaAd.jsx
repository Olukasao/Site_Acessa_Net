import { useRef } from "react";
import { gsap } from "gsap";
import SplitWords from "../SplitWords";
import { useAdTimeline } from "../useAdTimeline";
import logo from "../assets/projecta-logo.webp";
import photo from "../assets/projecta-home.webp";
import "./projecta.css";

// Textos tirados do próprio site da Projecta Empreendimentos.
const BASE = 10;

function buildTimeline(root, { duration }) {
  const q = gsap.utils.selector(root);
  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

  tl.set(q(".p-scene"), { autoAlpha: 0 }, 0)
    .set(q(".ad-word > span"), { yPercent: 115 }, 0)
    .set(q(".p-scene--s1"), { autoAlpha: 1 }, 0);

  // Cena 1: a casa dourada da marca se desenha
  tl.fromTo(q(".p-house path"), { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.6, ease: "power2.inOut" }, 0.15)
    .fromTo(q(".p-house"), { scale: 0.92 }, { scale: 1, duration: 3, ease: "none" }, 0.15)
    .to(q(".p-scene--s1 .ad-word > span"), { yPercent: 0, duration: 0.75, stagger: 0.08, ease: "power4.out" }, 0.9)
    .to(q(".p-scene--s1"), { autoAlpha: 0, duration: 0.4, ease: "power2.in" }, 3.0);

  // Cena 2: foto revelada por uma cortina dourada, com aproximação lenta
  tl.set(q(".p-scene--s2"), { autoAlpha: 1 }, 3.2)
    .fromTo(q(".p-curtain"), { scaleX: 1 }, { scaleX: 0, duration: 1, ease: "power3.inOut" }, 3.25)
    .fromTo(q(".p-photo img"), { scale: 1.16 }, { scale: 1.02, duration: 3.6, ease: "none" }, 3.2)
    .to(q(".p-scene--s2 .ad-word > span"), { yPercent: 0, duration: 0.75, stagger: 0.07, ease: "power4.out" }, 3.9)
    .fromTo(q(".p-scene--s2 .p-sub"), { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 4.6)
    .to(q(".p-scene--s2"), { autoAlpha: 0, duration: 0.45, ease: "power2.in" }, 6.6);

  // Cena 3 (quadro final): logo
  tl.set(q(".p-scene--s3"), { autoAlpha: 1 }, 6.9)
    .fromTo(q(".p-logo"), { autoAlpha: 0, y: 24, scale: 0.94 }, { autoAlpha: 1, y: 0, scale: 1, duration: 1.1, ease: "expo.out" }, 6.95)
    .fromTo(q(".p-rule"), { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: "power2.inOut" }, 7.5)
    .to(q(".p-scene--s3 .ad-word > span"), { yPercent: 0, duration: 0.7, stagger: 0.07, ease: "power4.out" }, 7.7);

  tl.timeScale(BASE / Math.max(duration || BASE, 4));
  return tl;
}

export default function ProjectaAd({ active = true, duration = BASE, reduced = false }) {
  const root = useRef(null);
  useAdTimeline(root, { active, reduced, duration, build: buildTimeline });

  return (
    <div className="p-ad" ref={root}>
      <div className="p-scene p-scene--s1">
        <svg className="p-house" viewBox="0 0 200 180" aria-hidden="true">
          <path d="M60 172 H24 V70 L100 8 L176 70 V96" pathLength="1" />
        </svg>
        <p className="p-title">
          <SplitWords text="Construindo mais" />
          <br />
          <SplitWords text="do que imóveis" className="is-gold" />
        </p>
      </div>

      <div className="p-scene p-scene--s2">
        <div className="p-photo">
          <img src={photo} alt="Casa em miniatura e chaves na mão" width="1280" height="704" decoding="async" />
          <span className="p-curtain" aria-hidden="true" />
        </div>
        <div className="p-caption">
          <p className="p-title p-title--light">
            <SplitWords text="Transformamos projetos em lares" />
          </p>
          <p className="p-sub">com qualidade, confiança e inovação</p>
        </div>
      </div>

      <div className="p-scene p-scene--s3">
        <img className="p-logo" src={logo} alt="Projecta Empreendimentos" width="640" height="253" decoding="async" />
        <span className="p-rule" aria-hidden="true" />
        <p className="p-title p-title--sm">
          <SplitWords text="Encontre seu novo lar" />
        </p>
      </div>
    </div>
  );
}
