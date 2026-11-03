import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, MapPin } from "lucide-react";
import { clienteRequest } from "../clienteApi";
import { MAX_ACCURACY_METERS, geoErrorMessage, readCurrentPosition, submitLocation } from "./locationCapture";

function formatSentAt(value) {
  try {
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  } catch {
    return "";
  }
}

/**
 * Convite no chamado com visita agendada: o cliente envia a localizacao da casa para o tecnico achar o endereco.
 * O ponto nao vai direto para o cadastro: a equipe confere e so entao o link do mapa chega na OS do tecnico.
 */
export default function VisitLocationCard({ ticket }) {
  const contractId = ticket?.contractId;
  const protocol = ticket?.protocol;
  const [sent, setSent] = useState(null);
  const [step, setStep] = useState("idle"); // idle | explain | locating | review | sending
  const [position, setPosition] = useState(null);
  const [error, setError] = useState("");

  const loadStatus = useCallback(async () => {
    if (!contractId || !protocol) return;
    try {
      const response = await clienteRequest(`/v1/support/location?contractId=${encodeURIComponent(contractId)}&protocol=${encodeURIComponent(protocol)}`);
      setSent(response?.location ?? null);
    } catch {
      // Sem o estado anterior o cartão continua oferecendo o envio: não é motivo de erro na tela.
    }
  }, [contractId, protocol]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function handleLocate() {
    setError("");
    setStep("locating");
    try {
      setPosition(await readCurrentPosition());
      setStep("review");
    } catch (caught) {
      setError(geoErrorMessage(caught));
      setStep("explain");
    }
  }

  async function handleSend() {
    if (!position) return;
    setError("");
    setStep("sending");
    try {
      await submitLocation(contractId, protocol, position);
      setPosition(null);
      setStep("idle");
      await loadStatus();
    } catch (caught) {
      setError(caught?.message || "Não foi possível enviar a localização agora.");
      setStep("review");
    }
  }

  const imprecise = position && position.accuracyMeters > MAX_ACCURACY_METERS;
  const rejectedNote = sent?.status === "rejected" ? sent.reviewNote : null;

  return (
    <div className="cliente-location-card">
      <div className="cliente-location-head">
        <span className="cliente-location-icon">
          <MapPin size={19} />
        </span>
        <div>
          <strong>Ajude o técnico a achar sua casa</strong>
          <small>Envie a localização da sua casa para a visita.</small>
        </div>
      </div>

      {sent?.status === "pending" && step === "idle" ? (
        <p className="cliente-location-status">
          <CheckCircle2 size={16} /> Localização recebida em {formatSentAt(sent.sentAt)}. Nossa equipe vai encaminhá-la ao técnico.
        </p>
      ) : null}
      {sent?.status === "approved" && step === "idle" ? (
        <p className="cliente-location-status is-ok">
          <CheckCircle2 size={16} /> Localização enviada ao seu chamado. O técnico já recebeu o ponto.
        </p>
      ) : null}
      {sent?.status === "rejected" && step === "idle" ? (
        <p className="cliente-location-status is-warn">
          Não conseguimos usar a localização enviada{rejectedNote && !rejectedNote.startsWith("Substituido") ? `: ${rejectedNote}` : ""}. Envie de novo.
        </p>
      ) : null}

      {error ? <p className="cliente-location-error" role="alert">{error}</p> : null}

      {step === "idle" ? (
        <button className="cliente-soft-action" type="button" onClick={() => { setError(""); setStep("explain"); }}>
          {sent?.status === "pending" || sent?.status === "approved" ? "Enviar de novo" : "Enviar localização da minha casa"}
        </button>
      ) : null}

      {step === "explain" ? (
        <div className="cliente-location-body">
          <p>
            Faça isso <strong>de dentro da sua casa</strong> (ou na frente dela). Usamos o GPS do seu aparelho só agora, uma vez, para o
            técnico chegar na visita. Não acompanhamos seu trajeto, e o ponto vai para o seu chamado só para o técnico encontrar a casa.
          </p>
          <div className="cliente-location-actions">
            <button className="cliente-primary-action" type="button" onClick={() => void handleLocate()}>
              <MapPin size={17} /> Usar minha localização
            </button>
            <button className="cliente-soft-action" type="button" onClick={() => setStep("idle")}>Agora não</button>
          </div>
        </div>
      ) : null}

      {step === "locating" ? (
        <p className="cliente-location-status"><Loader2 size={16} className="cliente-spin" /> Buscando sua localização…</p>
      ) : null}

      {step === "review" || step === "sending" ? (
        <div className="cliente-location-body">
          <p>
            Localização encontrada (precisão de cerca de <strong>{position?.accuracyMeters} m</strong>).
            {imprecise ? " Está imprecisa demais: vá para perto de uma janela ou área aberta e tente de novo." : " Você está na sua casa?"}
          </p>
          <div className="cliente-location-actions">
            {!imprecise ? (
              <button className="cliente-primary-action" type="button" disabled={step === "sending"} onClick={() => void handleSend()}>
                {step === "sending" ? <Loader2 size={17} className="cliente-spin" /> : <CheckCircle2 size={17} />}
                Sim, esta é a minha casa
              </button>
            ) : null}
            <button className="cliente-soft-action" type="button" disabled={step === "sending"} onClick={() => void handleLocate()}>
              Buscar de novo
            </button>
            <button className="cliente-soft-action" type="button" disabled={step === "sending"} onClick={() => { setPosition(null); setStep("idle"); }}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
