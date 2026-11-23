import { useLayoutEffect } from "react";
import { gsap } from "gsap";

// Liga a timeline GSAP de um anúncio só quando ele entra na tela.
// - O CSS de cada anúncio desenha o "quadro final" (logo + texto). É o que aparece
//   com "reduzir movimento" ou se o GSAP falhar: nada some, nada fica cortado.
// - Ao sair, a timeline pausa (o anúncio ainda está em fade-out) e só depois é
//   desfeita, para não pular para o quadro final durante a transição.
export function useAdTimeline(rootRef, { active, reduced, duration, build }) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !active || reduced) return undefined;
    let tl;
    const ctx = gsap.context(() => {
      tl = build(root, { duration });
    }, root);
    return () => {
      tl?.pause();
      window.setTimeout(() => ctx.revert(), 900);
    };
    // build é estável por anúncio; duration não muda durante a exibição.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reduced]);
}
