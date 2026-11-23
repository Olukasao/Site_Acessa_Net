import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { adSlots, totalAdSeconds } from "../ads/adsConfig";
import "../ads/adBreak.css";

// Tela entre o cadastro e a liberação: cada marca de adsConfig.js passa em tela
// cheia, na sua vez. Ao fim de todas, libera sozinha (onDone).
// O tempo é medido pelo relógio (Date.now), não por contagem de ticks: se o
// aparelho atrasar os timers, a liberação não atrasa junto.
export default function WifiAdBreak({ onDone }) {
  const startRef = useRef(Date.now());
  const doneRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const [reduced] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  // Início de cada marca na linha do tempo.
  const starts = useMemo(() => {
    let acc = 0;
    return adSlots.map((slot) => {
      const at = acc;
      acc += slot.seconds;
      return at;
    });
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setElapsed(Math.min(totalAdSeconds, (Date.now() - startRef.current) / 1000));
    }, 200);
    return () => window.clearInterval(tick);
  }, []);

  // Sem rolagem por baixo do anúncio.
  useEffect(() => {
    const html = document.documentElement;
    const previous = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = previous;
    };
  }, []);

  const ready = elapsed >= totalAdSeconds;
  useEffect(() => {
    if (ready && !doneRef.current) {
      doneRef.current = true;
      onDone();
    }
  }, [ready, onDone]);

  let current = 0;
  starts.forEach((at, i) => {
    if (elapsed >= at) current = i;
  });
  const left = Math.max(0, Math.ceil(totalAdSeconds - elapsed));

  return createPortal(
    <div className="adbreak" role="dialog" aria-modal="true" aria-label="Publicidade antes da liberação do Wi-Fi">
      {adSlots.map(({ id, name, seconds, Component }, i) => (
        <section
          key={id}
          className={`adbreak__slot${i === current ? " is-on" : ""}`}
          aria-hidden={i === current ? undefined : true}
          aria-label={`Anúncio ${name}`}
        >
          <Component active={i === current && !ready} duration={seconds} reduced={reduced} />
        </section>
      ))}

      <span className="adbreak__label">
        Publicidade · {current + 1}/{adSlots.length}
      </span>

      <div className="adbreak__hud" role="status" aria-live="polite">
        <div className="adbreak__bars" aria-hidden="true">
          {adSlots.map((slot, i) => {
            const fill = Math.min(1, Math.max(0, (elapsed - starts[i]) / slot.seconds));
            return (
              <span key={slot.id}>
                <i style={{ transform: `scaleX(${fill})` }} />
              </span>
            );
          })}
        </div>
        <p>
          <span className="adbreak__check" aria-hidden="true">✓</span>
          {ready ? (
            "Liberando sua internet…"
          ) : (
            <>
              Cadastro feito! Internet liberada em <strong>{left}s</strong>
            </>
          )}
        </p>
      </div>
    </div>,
    document.body
  );
}
