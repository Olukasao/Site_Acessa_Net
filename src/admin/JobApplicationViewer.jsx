import { useEffect, useRef, useState } from "react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fetchJobApplicationFile } from "./adminApi";

/** Links do currículo: só http(s), mailto e tel, sempre em outra aba e sem referrer. Um DOCX hostil poderia trazer javascript:. */
function sanitizeLinks(root) {
  root.querySelectorAll("a").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (!/^(https?:|mailto:|tel:)/i.test(href)) {
      link.removeAttribute("href");
      return;
    }
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });
}

/**
 * Exibe o currículo dentro da página, sem a barra do leitor do navegador (que traz "baixar"/"imprimir"):
 * PDF página a página em <canvas> (pdf.js) e DOCX montado na tela (docx-preview). Não impede um admin determinado
 * de capturar a tela ou ler a resposta da API; o objetivo é tirar o download do fluxo normal.
 */
export default function JobApplicationViewer({ applicationId, fileName }) {
  const isDocx = /\.docx$/i.test(String(fileName || ""));
  const containerRef = useRef(null);
  const [state, setState] = useState({ status: "loading", message: "" });

  useEffect(() => {
    let cancelled = false;
    let pdf;

    async function renderDocx() {
      try {
        const [{ renderAsync }, blob] = await Promise.all([import("docx-preview"), fetchJobApplicationFile(applicationId)]);
        if (cancelled) return;
        const container = containerRef.current;
        container.replaceChildren();
        await renderAsync(blob, container, undefined, { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true });
        if (cancelled) return;
        sanitizeLinks(container);
        setState({ status: "ready", message: "" });
      } catch (error) {
        if (!cancelled) {
          setState({ status: "error", message: error?.message || "Não foi possível exibir o currículo." });
        }
      }
    }

    async function render() {
      try {
        const [pdfjs, blob] = await Promise.all([import("pdfjs-dist"), fetchJobApplicationFile(applicationId)]);
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        if (cancelled) return;

        const container = containerRef.current;
        container.replaceChildren();
        const width = Math.max(container.clientWidth, 280);
        const ratio = window.devicePixelRatio || 1;

        for (let number = 1; number <= pdf.numPages; number += 1) {
          const page = await pdf.getPage(number);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = "100%";
          canvas.style.display = "block";
          canvas.style.marginBottom = "8px";
          container.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
        }
        if (!cancelled) setState({ status: "ready", message: "" });
      } catch (error) {
        if (!cancelled) {
          setState({ status: "error", message: error?.message || "Não foi possível exibir o currículo." });
        }
      }
    }

    void (isDocx ? renderDocx() : render());
    return () => {
      cancelled = true;
      void pdf?.destroy();
    };
  }, [applicationId, isDocx]);

  return (
    <div className="admin-cv-viewer" onContextMenu={(event) => event.preventDefault()}>
      {state.status === "loading" ? <p className="admin-cv-viewer-note">Carregando currículo…</p> : null}
      {state.status === "error" ? <p className="admin-cv-viewer-note">{state.message}</p> : null}
      <div ref={containerRef} className="admin-cv-viewer-pages" />
    </div>
  );
}
