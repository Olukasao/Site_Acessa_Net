import { useLayoutEffect, useRef } from "react";
import { useAdTimeline } from "../useAdTimeline";
import { Globe, PhotoReel } from "./AdScene";
import BrandLogo from "./BrandLogo";
import { kollectConfig } from "./config";
import { buildKollectTimeline, startAmbient } from "./cinematicTimeline";
import "./styles.css";

const PATTERN_ROWS = 10;

// "KOLLECT YOUR WORLD": um plano-sequência numa única viewport.
// O globo se desenha, vira o quadro das fotos (4:5) e no fim volta a ser globo.
// Revelação (o globo se desenha) -> Universo (o padrão da marca ganha vida)
// -> KOLLECT YOUR WORLD (key visual). Sem zoom: o globo mantém o tamanho.
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
      className={`k-ad${assets.photos?.length ? " has-photos" : ""}`}
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
        <div className="k-orb">
          <Globe />
        </div>
        {assets.photos?.length ? (
          <div className="k-frame">
            <PhotoReel photos={assets.photos} />
          </div>
        ) : null}
      </div>

      <p className="k-kana" lang="ja" aria-hidden="true">
        {texts.katakana}
      </p>

      <div className="k-sign">
        <BrandLogo logo={assets.logo} yourWorld={assets.yourWorld} label={texts.signature} />
        <p className="k-credit">{texts.credit}</p>
      </div>

      <div className="k-fade" aria-hidden="true" />
    </div>
  );
}
