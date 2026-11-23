// Camadas do palco: o globo (o mesmo desenho do "O" de WORLD na assinatura,
// em escala monumental) e a figure protagonista na frente dele.

// Meridianos espaçados igualmente; o giro é simulado mudando a largura de cada
// elipse (rx = R·|cos φ|) a partir desta fase inicial.
export const GLOBE_R = 96;
export const MERIDIAN_PHASES = [0, 30, 60, 90, 120, 150].map((deg) => (deg * Math.PI) / 180);
const PARALLELS = [-0.62, 0, 0.62]; // seno da latitude (≈ -38°, 0°, 38°)

export function meridianRx(phase) {
  return Math.max(0.5, GLOBE_R * Math.abs(Math.cos(phase)));
}

export function Globe() {
  return (
    <svg className="k-globe" viewBox="-100 -100 200 200" aria-hidden="true">
      <defs>
        <radialGradient id="k-globe-body" cx="0.38" cy="0.32" r="0.75">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.09" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="k-globe__grid">
        <circle className="k-globe__body" r={GLOBE_R} />
        <circle r={GLOBE_R} fill="url(#k-globe-body)" stroke="none" />
        {PARALLELS.map((s) => {
          const rx = GLOBE_R * Math.sqrt(1 - s * s);
          return <ellipse key={s} className="k-globe__lat" cx="0" cy={GLOBE_R * s} rx={rx} ry={rx * 0.16} />;
        })}
        {MERIDIAN_PHASES.map((phase, i) => (
          <ellipse key={i} className="k-globe__mer" cx="0" cy="0" rx={meridianRx(phase)} ry={GLOBE_R} />
        ))}
      </g>
      <circle className="k-globe__rim" r={GLOBE_R} />
    </svg>
  );
}

// Figure em destaque. Com foto de produto (`hero.photo`) usa a foto; sem ela, o
// mascote. Camadas: preenchimento (fecha olhos e contornos vazados do desenho),
// a figure e uma cópia preta: a silhueta antes da luz acender.
export function Hero({ hero }) {
  const src = hero.photo || hero.mascot;
  const isMascot = !hero.photo;
  return (
    <div className={`k-hero${isMascot ? " is-mascot" : ""}`} role="img" aria-label={hero.alt}>
      {isMascot ? <span className="k-hero__fill" aria-hidden="true" /> : null}
      <img className="k-hero__img" src={src} alt="" decoding="async" />
      <img className="k-hero__silhouette" src={src} alt="" decoding="async" />
    </div>
  );
}
