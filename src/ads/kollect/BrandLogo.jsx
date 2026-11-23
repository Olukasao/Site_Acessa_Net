// Logo da KOLLECT. O brilho passa só por dentro das letras: a própria logo
// serve de máscara para a faixa de luz.
export default function BrandLogo({ src, className = "" }) {
  const mask = { WebkitMaskImage: `url(${src})`, maskImage: `url(${src})` };
  return (
    <div className={`k-logo ${className}`}>
      <img src={src} alt="KOLLECT" width="880" height="150" decoding="async" />
      <span className="k-logo__shine" style={mask} aria-hidden="true">
        <span className="k-logo__glint" />
      </span>
    </div>
  );
}
