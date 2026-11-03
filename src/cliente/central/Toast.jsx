import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

const TOAST_EVENT = "acessanet:toast";
const AUTO_CLOSE_MS = { success: 7000, danger: 9000 };

/** Mostra um aviso no topo da Central (de qualquer tela). tone: "success" | "danger". */
export function showToast({ tone = "success", title, message = "" }) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { id: `${Date.now()}-${Math.random()}`, tone, title, message } }));
}

/** Fica montado uma vez na Central; recebe os avisos de showToast e os fecha sozinho. */
export default function ToastHost() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const timers = new Map();
    const dismiss = (id) => {
      window.clearTimeout(timers.get(id));
      timers.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    };
    const onToast = (event) => {
      const toast = event.detail;
      setToasts((current) => [...current.slice(-2), toast]);
      timers.set(toast.id, window.setTimeout(() => dismiss(toast.id), AUTO_CLOSE_MS[toast.tone] ?? 7000));
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  if (!toasts.length) return null;

  return (
    <div className="cliente-toast-stack" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.tone === "danger" ? AlertCircle : CheckCircle2;
        return (
          <div className={`cliente-toast is-${toast.tone}`} key={toast.id} role={toast.tone === "danger" ? "alert" : "status"}>
            <Icon size={22} />
            <div>
              <strong>{toast.title}</strong>
              {toast.message ? <p>{toast.message}</p> : null}
            </div>
            <button
              aria-label="Fechar aviso"
              className="cliente-toast-close"
              type="button"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
