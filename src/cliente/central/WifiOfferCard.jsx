import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Link } from "react-router-dom";
import { getWifiAvailability } from "../clienteApi";
import "./wifiManager.css";

/**
 * Mostrada na triagem "Troca de senha do roteador": se a troca automatica esta disponivel para o contrato (e o servico
 * esta no ar), oferece trocar agora pela aba Internet em vez de abrir um chamado e esperar um atendente.
 */
export default function WifiOfferCard({ contractId }) {
  const [offer, setOffer] = useState(false);

  useEffect(() => {
    if (!contractId) return undefined;
    const controller = new AbortController();
    getWifiAvailability(contractId, controller.signal)
      .then((r) => setOffer(r?.available === true && r?.agentOnline === true))
      .catch(() => setOffer(false));
    return () => controller.abort();
  }, [contractId]);

  if (!offer) return null;
  return (
    <div className="wifi-offer" role="note">
      <KeyRound size={20} aria-hidden />
      <div>
        <strong>Troque agora, sem esperar atendimento</strong>
        <p>Você pode trocar a senha do seu Wi-Fi em poucos segundos pela Central.</p>
        <Link className="home-btn home-btn-primary" to="/cliente/internet">Trocar a senha do Wi-Fi agora</Link>
      </div>
    </div>
  );
}
