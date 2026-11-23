import { useRef } from "react";
import SplitWords from "../SplitWords";
import { useAdTimeline } from "../useAdTimeline";
import { AdScene, DisplayBox, Figure } from "./AdScene";
import BrandLogo from "./BrandLogo";
import AdCTA from "./AdCTA";
import { kollectAssets } from "./assets";
import { kollectConfig } from "./config";
import { buildKollectTimeline, startParticles } from "./cinematicTimeline";
import "./styles.css";

// Posições fixas das partículas (determinístico, sem Math.random na renderização).
const PARTICLES = [
  [8, 72], [17, 40], [26, 86], [34, 58], [43, 30], [52, 78],
  [61, 48], [69, 90], [77, 36], [85, 66], [92, 52], [12, 20],
];

// Comercial da KOLLECT: uma viewport, sem rolagem, uma timeline controlando tudo.
// `active` liga a animação; `duration` (s) vem da tela de espera; `reduced` mostra
// só o quadro final (logo + frase), para quem pede menos movimento.
export default function CinematicAd({ active = true, duration, reduced = false, config = kollectConfig }) {
  const root = useRef(null);
  const { texts, colors, figures, logo } = config;
  const head = kollectAssets.head;

  useAdTimeline(root, {
    active,
    reduced,
    duration: duration || config.duration,
    build: (el, { duration: d }) => {
      startParticles(el);
      return buildKollectTimeline(el, { duration: d, loop: config.loop, speed: config.transitionSpeed });
    },
  });

  return (
    <div
      className="k-ad"
      ref={root}
      style={{
        "--k-black": colors.black,
        "--k-graphite": colors.graphite,
        "--k-white": colors.white,
        "--k-red": colors.red,
      }}
    >
      <div className="k-bg" aria-hidden="true" />
      <div className="k-particles" aria-hidden="true">
        {PARTICLES.map(([x, y], i) => (
          <span key={i} className={i % 3 === 0 ? "is-red" : ""} style={{ left: `${x}%`, top: `${y}%` }} />
        ))}
      </div>
      <div className="k-line" aria-hidden="true" />

      <AdScene id="s1">
        <Figure figure={figures[0]} head={head} variant="side" />
        <div className="k-copy">
          <p className="k-title k-t1">
            <SplitWords text={texts.scene1} />
          </p>
        </div>
      </AdScene>

      <AdScene id="s2">
        <Figure figure={figures[1]} head={head} variant="top" />
        <div className="k-copy">
          <p className="k-title k-t2a">
            <SplitWords text={texts.scene2a} />
          </p>
          <p className="k-title k-t2b is-red">
            <SplitWords text={texts.scene2b} />
          </p>
        </div>
      </AdScene>

      <AdScene id="s3">
        <div className="k-shelf">
          <div className="k-shelf__track">
            {figures.map((figure, i) => (
              <div className="k-slot" key={i}>
                <DisplayBox figure={figure} head={head} number={i + 1} />
              </div>
            ))}
          </div>
        </div>
        <span className="k-sweep" aria-hidden="true" />
        <div className="k-copy">
          <p className="k-title k-t3a">
            <SplitWords text={texts.scene3a} />
          </p>
          <p className="k-title k-t3b is-red">
            <SplitWords text={texts.scene3b} />
          </p>
        </div>
      </AdScene>

      <AdScene id="s4">
        <span className="k-bloom" aria-hidden="true" />
        <div className="k-s4__inner">
          <BrandLogo src={logo} />
          <p className="k-tagline">
            <SplitWords text={texts.tagline} />
          </p>
          <p className="k-discover">{texts.discover}</p>
        </div>
      </AdScene>

      <div className="k-grain" aria-hidden="true" />
      <div className="k-vignette" aria-hidden="true" />
      <div className="k-bars" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="k-fade" aria-hidden="true" />
      <AdCTA cta={config.cta} instagram={config.instagram} />
    </div>
  );
}
