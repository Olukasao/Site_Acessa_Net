// Camadas do palco: o "mundo" (disco), a órbita e a figure protagonista.
// Tudo 2.5D: cada camada se move num ritmo diferente para dar profundidade.

export function World() {
  return (
    <>
      <span className="k-orbit" aria-hidden="true">
        <span className="k-orbit__moon" />
      </span>
      <span className="k-world" aria-hidden="true" />
    </>
  );
}

// Figure em destaque. Com foto de produto (`hero.photo`) usa a foto; sem ela, o
// mascote. Camadas: sombra projetada no mundo, preenchimento (fecha os olhos e
// contornos vazados do desenho), a figure e uma cópia preta: a silhueta contra a luz.
export function Hero({ hero }) {
  const src = hero.photo || hero.mascot;
  const isMascot = !hero.photo;
  return (
    <div className={`k-hero${isMascot ? " is-mascot" : ""}`} role="img" aria-label={hero.alt}>
      <img className="k-hero__shadow" src={src} alt="" decoding="async" />
      {isMascot ? <span className="k-hero__fill" aria-hidden="true" /> : null}
      <img className="k-hero__img" src={src} alt="" decoding="async" />
      <img className="k-hero__silhouette" src={src} alt="" decoding="async" />
    </div>
  );
}
