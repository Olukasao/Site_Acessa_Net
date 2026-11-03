import { useState } from "react";
import { CheckCircle2, Loader2, MapPin } from "lucide-react";
import { clienteRequest } from "../clienteApi";

/** Mesmo limite do servidor (locationService.ts): acima disso o ponto nao serve para achar uma casa. */
export const MAX_ACCURACY_METERS = 200;
const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 };

export function isNativeApp() {
  return typeof window !== "undefined" && Boolean(window.Capacitor?.isNativePlatform?.());
}

export function geoErrorMessage(error) {
  if (error?.code === 1) {
    return "Sem permissão para usar a localização. Libere o acesso à localização nas configurações do aparelho e tente de novo.";
  }
  if (error?.code === 3) {
    return "Não conseguimos achar sua localização a tempo. Vá para perto de uma janela ou área aberta e tente de novo.";
  }
  return "Não foi possível obter sua localização agora. Confira se o GPS está ligado e tente de novo.";
}

/** Lê o GPS uma única vez (sem acompanhar o trajeto). Devolve { latitude, longitude, accuracyMeters }. */
export async function readCurrentPosition() {
  const result = await new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(Object.assign(new Error("sem geolocalizacao"), { code: 2 }));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, GEO_OPTIONS);
  });
  return {
    latitude: result.coords.latitude,
    longitude: result.coords.longitude,
    accuracyMeters: Math.round(result.coords.accuracy)
  };
}

/** Envia o ponto do chamado para a equipe conferir (ver locationRoutes.ts). */
export function submitLocation(contractId, protocol, position) {
  return clienteRequest("/v1/support/location", {
    method: "POST",
    body: {
      contractId,
      protocol,
      latitude: position.latitude,
      longitude: position.longitude,
      accuracyMeters: position.accuracyMeters,
      source: isNativeApp() ? "app" : "web"
    }
  });
}

/**
 * Campo do formulario de abertura do chamado: o cliente captura o ponto da casa agora e ele segue junto com o
 * chamado (enviado assim que o protocolo existe). Opcional: sem permissao/GPS o chamado abre normalmente.
 * `value` e o ponto confirmado ({ latitude, longitude, accuracyMeters }) ou null.
 */
export function LocationCaptureField({ value, onChange, disabled }) {
  const [step, setStep] = useState("idle"); // idle | explain | locating | review
  const [candidate, setCandidate] = useState(null);
  const [error, setError] = useState("");

  async function handleLocate() {
    setError("");
    setStep("locating");
    try {
      setCandidate(await readCurrentPosition());
      setStep("review");
    } catch (caught) {
      setError(geoErrorMessage(caught));
      setStep("explain");
    }
  }

  const imprecise = candidate && candidate.accuracyMeters > MAX_ACCURACY_METERS;

  return (
    <div className="cliente-location-card">
      <div className="cliente-location-head">
        <span className="cliente-location-icon">
          <MapPin size={19} />
        </span>
        <div>
          <strong>
            Localização da sua casa <span className="cliente-optional">(recomendado)</span>
          </strong>
          <small>Ajuda o técnico a achar o endereço na visita.</small>
        </div>
      </div>

      {value && step === "idle" ? (
        <>
          <p className="cliente-location-status is-ok">
            <CheckCircle2 size={16} /> Localização capturada (precisão de cerca de {value.accuracyMeters} m). Ela vai junto com o chamado, para o técnico.
          </p>
          <div className="cliente-location-actions">
            <button className="cliente-soft-action" type="button" disabled={disabled} onClick={() => { setError(""); setStep("explain"); }}>
              Capturar de novo
            </button>
            <button className="cliente-soft-action" type="button" disabled={disabled} onClick={() => onChange(null)}>
              Remover
            </button>
          </div>
        </>
      ) : null}

      {error ? <p className="cliente-location-error" role="alert">{error}</p> : null}

      {!value && step === "idle" ? (
        <button className="cliente-soft-action" type="button" disabled={disabled} onClick={() => { setError(""); setStep("explain"); }}>
          Enviar localização da minha casa
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

      {step === "review" ? (
        <div className="cliente-location-body">
          <p>
            Localização encontrada (precisão de cerca de <strong>{candidate?.accuracyMeters} m</strong>).
            {imprecise ? " Está imprecisa demais: vá para perto de uma janela ou área aberta e tente de novo." : " Você está na sua casa?"}
          </p>
          <div className="cliente-location-actions">
            {!imprecise ? (
              <button
                className="cliente-primary-action"
                type="button"
                onClick={() => {
                  onChange(candidate);
                  setCandidate(null);
                  setStep("idle");
                }}
              >
                <CheckCircle2 size={17} /> Sim, esta é a minha casa
              </button>
            ) : null}
            <button className="cliente-soft-action" type="button" onClick={() => void handleLocate()}>Buscar de novo</button>
            <button className="cliente-soft-action" type="button" onClick={() => { setCandidate(null); setStep("idle"); }}>Cancelar</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
