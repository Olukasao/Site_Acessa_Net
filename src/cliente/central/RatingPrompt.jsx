import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Star } from "lucide-react";
import { ClienteApiError, getPendingRatings, submitRating } from "../clienteApi";

const LABELS = ["Muito ruim", "Ruim", "Regular", "Bom", "Excelente"];
const DISMISSED_KEY = "acessanet.rating.dismissed";

function readDismissed() {
  try {
    return JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveDismissed(list) {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(list));
  } catch {
    // sem sessionStorage: o cartão volta na próxima abertura, sem prejuízo.
  }
}

/** Pede a nota (1 a 5) e um comentário opcional do chamado encerrado mais recente que ainda não foi avaliado. */
export default function RatingPrompt() {
  const [pending, setPending] = useState([]);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [thanks, setThanks] = useState(false);

  const load = useCallback(async () => {
    const dismissed = readDismissed();
    const list = (await getPendingRatings()).filter((item) => !dismissed.includes(item.protocol));
    // Mantém o mesmo array quando nada mudou, para não reiniciar o cartão que o cliente está preenchendo.
    setPending((current) =>
      current.length === list.length && current.every((item, index) => item.protocol === list[index]?.protocol) ? current : list
    );
  }, []);

  // Confere ao abrir, a cada minuto (com a tela visível), ao voltar ao app e quando chega um push: assim o pedido
  // aparece logo que o chamado é finalizado, sem precisar sair e entrar de novo.
  useEffect(() => {
    void load();
    const visible = () => document.visibilityState === "visible";
    const check = () => {
      if (visible()) void load();
    };
    const timer = window.setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("acessanet:resume", check);
    window.addEventListener("acessanet:push-received", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("acessanet:resume", check);
      window.removeEventListener("acessanet:push-received", check);
    };
  }, [load]);

  useEffect(() => {
    if (!thanks) return undefined;
    const timer = setTimeout(() => setThanks(false), 5000);
    return () => clearTimeout(timer);
  }, [thanks]);

  const current = pending[0];

  function reset() {
    setRating(0);
    setHover(0);
    setComment("");
    setError("");
  }

  function handleDismiss() {
    if (!current) return;
    saveDismissed([...readDismissed(), current.protocol]);
    setPending((list) => list.slice(1));
    reset();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!current || !rating || sending) return;
    setSending(true);
    setError("");
    try {
      await submitRating({ protocol: current.protocol, rating, comment });
      setPending((list) => list.slice(1));
      reset();
      setThanks(true);
    } catch (caught) {
      if (caught instanceof ClienteApiError && caught.status === 409) {
        // Já avaliado em outro aparelho: só tira da lista.
        setPending((list) => list.slice(1));
        reset();
      } else {
        setError("Não foi possível enviar agora. Tente novamente.");
      }
    } finally {
      setSending(false);
    }
  }

  if (thanks) {
    return (
      <section className="cliente-rating cliente-rating-thanks" role="status">
        <CheckCircle2 size={22} aria-hidden="true" />
        <div>
          <strong>Obrigado pela sua avaliação!</strong>
          <p>Ela ajuda a AcessaNet a melhorar o atendimento.</p>
        </div>
      </section>
    );
  }

  if (!current) return null;

  const shown = hover || rating;

  return (
    <section className="cliente-rating" aria-label="Avalie seu atendimento">
      <form onSubmit={handleSubmit}>
        <div className="cliente-rating-head">
          <h3>Como foi o seu atendimento?</h3>
          <p>
            Chamado #{current.protocol}
            {current.title ? ` · ${current.title}` : ""}
          </p>
        </div>

        <div className="cliente-rating-stars" role="radiogroup" aria-label="Nota de 1 a 5" onMouseLeave={() => setHover(0)}>
          {LABELS.map((label, index) => {
            const value = index + 1;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={rating === value}
                aria-label={`${value} de 5: ${label}`}
                className={`cliente-rating-star ${value <= shown ? "is-on" : ""}`}
                onClick={() => setRating(value)}
                onMouseEnter={() => setHover(value)}
              >
                <Star size={32} aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <p className="cliente-rating-label" aria-live="polite">
          {shown ? LABELS[shown - 1] : "Toque nas estrelas para avaliar"}
        </p>

        {rating ? (
          <label className="cliente-rating-comment">
            <span>Quer contar mais? (opcional)</span>
            <textarea
              value={comment}
              maxLength={500}
              rows={3}
              placeholder={rating <= 2 ? "O que podemos fazer para melhorar?" : "Deixe um comentário"}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
        ) : null}

        {error ? <p className="cliente-rating-error" role="alert">{error}</p> : null}

        <div className="cliente-rating-actions">
          <button className="cliente-rating-skip" type="button" onClick={handleDismiss} disabled={sending}>
            Agora não
          </button>
          <button className="cliente-rating-send" type="submit" disabled={!rating || sending}>
            {sending ? "Enviando…" : "Enviar avaliação"}
          </button>
        </div>
      </form>
    </section>
  );
}
