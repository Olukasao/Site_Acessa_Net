import { Fragment } from "react";

// Quebra um texto em palavras com máscara (overflow hidden), para a entrada
// tipográfica de baixo para cima. As timelines animam `.ad-word > span`.
export default function SplitWords({ text, className = "" }) {
  const words = text.split(" ");
  return (
    <span className={`ad-split ${className}`} role="text" aria-label={text}>
      {words.map((word, i) => (
        <Fragment key={`${word}-${i}`}>
          <span className="ad-word" aria-hidden="true">
            <span>{word}</span>
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}
