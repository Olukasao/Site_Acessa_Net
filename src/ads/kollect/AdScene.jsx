// Peças visuais das cenas. Tudo em camadas 2.5D (imagem + luz + base), sem WebGL.

export function AdScene({ id, children }) {
  return <div className={`k-scene k-scene--${id}`}>{children}</div>;
}

// Figure em destaque. Com foto oficial (`figure.src`) mostra a foto; sem ela,
// monta uma figure estilizada com a cabeça do mascote da marca.
export function Figure({ figure, head, variant = "side" }) {
  return (
    <div className={`k-figure k-figure--${variant}`}>
      <span className="k-figure__halo" aria-hidden="true" />
      <div className="k-figure__subject">
        {figure?.src ? (
          <img className="k-figure__photo" src={figure.src} alt={figure.alt} decoding="async" />
        ) : (
          <div className="k-toy" role="img" aria-label={figure?.alt || "Colecionável"}>
            <img className="k-toy__head" src={head} alt="" width="150" height="136" decoding="async" />
            <svg className="k-toy__body" viewBox="0 0 120 96" aria-hidden="true">
              <defs>
                <linearGradient id={`k-body-${variant}`} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="#3a3a44" />
                  <stop offset="0.55" stopColor="#17171c" />
                  <stop offset="1" stopColor="#0b0b0e" />
                </linearGradient>
              </defs>
              <path d="M36 4 Q60 -2 84 4 L92 58 Q60 66 28 58 Z" fill={`url(#k-body-${variant})`} />
              <path d="M30 10 Q16 22 14 46 Q14 52 20 52 Q24 34 36 22 Z" fill={`url(#k-body-${variant})`} />
              <path d="M90 10 Q104 22 106 46 Q106 52 100 52 Q96 34 84 22 Z" fill={`url(#k-body-${variant})`} />
              <rect x="34" y="56" width="22" height="38" rx="9" fill={`url(#k-body-${variant})`} />
              <rect x="64" y="56" width="22" height="38" rx="9" fill={`url(#k-body-${variant})`} />
              <path className="k-toy__rim" d="M36 4 L28 58 M30 10 Q16 22 14 46" fill="none" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
        )}
      </div>
      <span className="k-figure__base" aria-hidden="true" />
    </div>
  );
}

// Caixa de colecionador (janela frontal), para a montagem da cena 3.
export function DisplayBox({ figure, head, number }) {
  return (
    <div className="k-box">
      <span className="k-box__brand">KOLLECT</span>
      <div className="k-box__window">
        {figure?.src ? (
          <img src={figure.src} alt={figure.alt} decoding="async" />
        ) : (
          <img src={head} alt="" width="150" height="136" decoding="async" />
        )}
      </div>
      <span className="k-box__num">No. {String(number).padStart(2, "0")}</span>
    </div>
  );
}
