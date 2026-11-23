// Botões de ação. Fora da timeline: clicáveis do primeiro ao último segundo.
// Sem `href` configurado não aparecem (nunca inventar link).
export default function AdCTA({ cta, instagram }) {
  const main = cta?.show && cta.href;
  const insta = instagram?.show && instagram.href;
  if (!main && !insta) return null;
  return (
    <div className="k-cta">
      {main ? (
        <a className="k-cta__main" href={cta.href} target="_blank" rel="noopener noreferrer">
          {cta.label}
        </a>
      ) : null}
      {insta ? (
        <a className="k-cta__alt" href={instagram.href} target="_blank" rel="noopener noreferrer">
          {instagram.label}
        </a>
      ) : null}
    </div>
  );
}
