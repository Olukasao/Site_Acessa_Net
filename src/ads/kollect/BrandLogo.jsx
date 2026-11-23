// Assinatura oficial empilhada como no key visual da marca:
//   KOLLECT
//   YOUR WORLD.
// Cada linha nasce de dentro de uma máscara (sobe da linha de base).
export default function BrandLogo({ logo, yourWorld, label }) {
  return (
    <h2 className="k-lockup" aria-label={label}>
      <span className="k-mask">
        <img className="k-lockup__kollect" src={logo} alt="" width="1600" height="273" decoding="async" />
      </span>
      <span className="k-mask">
        <img className="k-lockup__world" src={yourWorld} alt="" width="1600" height="258" decoding="async" />
      </span>
    </h2>
  );
}
