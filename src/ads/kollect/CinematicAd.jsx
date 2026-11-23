import { useLayoutEffect, useRef } from "react";
import { useAdTimeline } from "../useAdTimeline";
import { Globe, Hero } from "./AdScene";
import BrandLogo from "./BrandLogo";
import AdCTA from "./AdCTA";
import { kollectConfig } from "./config";
import { buildKollectTimeline, startAmbient } from "./cinematicTimeline";
import "./styles.css";

const PATTERN_ROWS = 10;

// "KOLLECT YOUR WORLD": um plano-sequência numa única viewport.
// Revelação (o globo se desenha, a figure surge em silhueta) -> Universo (o padrão da marca ganha vida)
// -> Identidade (a câmera entra nos olhos) -> KOLLECT YOUR WORLD (key visual).
// O CSS sozinho já desenha o key visual final: é o fallback estático.
export default function CinematicAd({ active = true, duration, reduced = false, config = kollectConfig }) {
  const root = useRef(null);
  const { texts, colors, assets } = config;

  // Unidades de altura/largura do próprio palco (100dvh real, sem a barra do
  // navegador), para a composição não depender de vh.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const measure = () => {
      el.style.setProperty("--kh", `${el.clientHeight / 100}px`);
      el.style.setProperty("--kw", `${el.clientWidth / 100}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useAdTimeline(root, {
    active,
    reduced,
    duration: duration || config.duration,
    build: (el, { duration: d }) => {
      startAmbient(el);
      return buildKollectTimeline(el, { duration: d, loop: config.loop, speed: config.transitionSpeed });
    },
  });

  return (
    <div
      className="k-ad"
      ref={root}
      style={{
        "--k-ground": colors.ground,
        "--k-pattern": colors.pattern,
        "--k-paper": colors.paper,
        "--k-line": colors.line,
        "--k-pattern-img": `url(${assets.logo})`,
      }}
    >
      <div className="k-pattern" aria-hidden="true">
        {Array.from({ length: PATTERN_ROWS }, (_, i) => (
          <div className="k-pattern__row" key={i}>
            <span />
          </div>
        ))}
      </div>

      <div className="k-stage">
        <Globe />
        <Hero hero={assets.hero} />
      </div>

      <p className="k-kana" lang="ja" aria-hidden="true">
        {texts.katakana}
      </p>

      <div className="k-sign">
        <BrandLogo logo={assets.logo} yourWorld={assets.yourWorld} label={texts.signature} />
        <p className="k-credit">{texts.credit}</p>
        <AdCTA cta={config.cta} instagram={config.instagram} />
      </div>

      <div className="k-fade" aria-hidden="true" />
    </div>
  );
}
