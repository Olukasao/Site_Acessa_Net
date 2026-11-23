// O palco: o globo (o mesmo desenho do "O" de WORLD na assinatura), em escala monumental.

// Meridianos espaçados igualmente; o giro é simulado mudando a largura de cada
// elipse (rx = R·|cos φ|) a partir desta fase inicial.
export const GLOBE_R = 96;
export const MERIDIAN_PHASES = [0, 30, 60, 90, 120, 150].map((deg) => (deg * Math.PI) / 180);
const PARALLELS = [-0.62, 0, 0.62]; // seno da latitude (≈ -38°, 0°, 38°)

export function meridianRx(phase) {
  return Math.max(0.5, GLOBE_R * Math.abs(Math.cos(phase)));
}

// Fotos dos produtos passando dentro do globo (recorte circular, por baixo da grade).
export function GlobeGallery({ photos }) {
  if (!photos?.length) return null;
  return (
    <div className="k-gallery" aria-hidden="true">
      {photos.map((src, i) => (
        <img key={src} className="k-gallery__img" src={src} alt="" decoding="async" loading={i < 2 ? "eager" : "lazy"} />
      ))}
      <span className="k-gallery__shade" />
    </div>
  );
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
