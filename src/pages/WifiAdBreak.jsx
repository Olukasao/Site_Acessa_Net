import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { adSlots as allSlots } from "../ads/adsConfig";
import "../ads/adBreak.css";

// Tela entre o cadastro e a liberação: cada marca de adsConfig.js passa em tela
// cheia, na sua vez. Ao fim de todas, libera sozinha: onDone(destino), onde destino
// é o link que a pessoa tocou (Instagram/Site da marca) ou null.
// O tempo é medido pelo relógio (Date.now), não por contagem de ticks: se o
// aparelho atrasar os timers, a liberação não atrasa junto.
// Na prévia (?previa=anuncios&marca=kollect) dá para ver uma marca só.
function pickSlots() {
  const params = new URLSearchParams(window.location.search);
  const only = params.get("previa") === "anuncios" ? params.get("marca") : null;
  const picked = only ? allSlots.filter((slot) => slot.id === only) : [];
  return picked.length ? picked : allSlots;
}

function LinkIcon({ kind, on }) {
  if (on) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "instagram") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.3 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.3-3.8-8.5S9.4 5.9 12 3.5z" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export default function WifiAdBreak({ onDone }) {
  const [adSlots] = useState(pickSlots);
  const totalAdSeconds = useMemo(() => adSlots.reduce((sum, slot) => sum + slot.seconds, 0), [adSlots]);
  const startRef = useRef(Date.now());
  const doneRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const [chosen, setChosen] = useState(null); // { href, label, brand }
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
  }, [adSlots]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setElapsed(Math.min(totalAdSeconds, (Date.now() - startRef.current) / 1000));
    }, 200);
    return () => window.clearInterval(tick);
  }, [totalAdSeconds]);

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
      onDone(chosen?.href || null);
    }
  }, [ready, onDone, chosen]);

  let current = 0;
  starts.forEach((at, i) => {
    if (elapsed >= at) current = i;
  });
  const left = Math.max(0, Math.ceil(totalAdSeconds - elapsed));
  const slot = adSlots[current];
  const links = (slot.links || []).filter((link) => link.href);

  const choose = (link) => {
    setChosen((prev) => (prev?.href === link.href ? null : { href: link.href, label: link.label, brand: slot.name }));
  };

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
        <div className="adbreak__row">
          <p>
            <span className="adbreak__check" aria-hidden="true">✓</span>
            {ready ? (
              chosen ? `Abrindo ${chosen.label} da ${chosen.brand}…` : "Liberando sua internet…"
            ) : chosen ? (
              <span>
                {chosen.label} abre em <strong>{left}s</strong>
              </span>
            ) : (
              <span>
                Internet liberada em <strong>{left}s</strong>
              </span>
            )}
          </p>
          {links.length && !ready ? (
            <div className="adbreak__links">
              {links.map((link) => {
                const on = chosen?.href === link.href;
                return (
                  <button
                    key={link.kind}
                    type="button"
                    className={`adbreak__link${on ? " is-on" : ""}`}
                    aria-pressed={on}
                    aria-label={`${link.label} da ${slot.name}: abre assim que a internet liberar`}
                    onClick={() => choose(link)}
                  >
                    <LinkIcon kind={link.kind} on={on} />
                    <span>{link.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
