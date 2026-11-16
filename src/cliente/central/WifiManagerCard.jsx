import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, KeyRound, Loader2, Router, Wifi, X } from "lucide-react";
import { Link } from "react-router-dom";
import { changeWifiPassword, confirmWifiChange, getWifiJob, getWifiStatus } from "../clienteApi";
import "./wifiManager.css";

/**
 * Minha Internet -> Gerenciar Wi-Fi. A tela so manda o contrato, as redes e as senhas; quem descobre o roteador
 * (pelo SGP) e altera e o servidor. Aparece so quando a funcao esta ligada para o contrato.
 */
const BAND_OPTIONS = [
  { id: "both", label: "Ambas", bands: ["2.4GHz", "5GHz"] },
  { id: "2.4GHz", label: "2.4 GHz", bands: ["2.4GHz"] },
  { id: "5GHz", label: "5 GHz", bands: ["5GHz"] }
];
const RULES = [
  { label: "8 a 63 caracteres", test: (v) => v.length >= 8 && v.length <= 63 },
  { label: "Uma letra maiúscula", test: (v) => /[A-Z]/.test(v) },
  { label: "Um número", test: (v) => /[0-9]/.test(v) },
  { label: "Um caractere especial", test: (v) => /[^A-Za-z0-9]/.test(v) },
  { label: "Sem acento e sem espaço no começo ou no fim", test: (v) => v.length > 0 && /^[\x20-\x7E]+$/.test(v) && v === v.trim() }
];
const MANAGEMENT_LABEL = {
  available: "Disponível",
  offline: "Roteador desconectado",
  requires_validation: "Modelo em validação",
  unsupported: "Não compatível",
  unreachable: "Sem acesso ao roteador",
  not_identified: "Roteador não identificado"
};

function useJobPolling(initialJob, onDone) {
  const [job, setJob] = useState(initialJob);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => setJob(initialJob), [initialJob]);
  useEffect(() => {
    if (!job || job.done) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await getWifiJob(job.id, controller.signal);
        setJob(r.job);
        if (r.job.done) doneRef.current?.(r.job);
      } catch {
        /* tenta de novo na proxima volta */
        setJob((current) => ({ ...current }));
      }
    }, 2500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job]);
  return job;
}

function PasswordInput({ id, value, onChange, autoComplete, placeholder }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="wifi-password-field">
      <input id={id} type={visible ? "text" : "password"} value={value} onChange={onChange} autoComplete={autoComplete} placeholder={placeholder} maxLength={63} spellCheck={false} />
      <button type="button" aria-label={visible ? "Ocultar senha" : "Mostrar senha"} onClick={() => setVisible((v) => !v)}>
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

export default function WifiManagerCard({ contract }) {
  const contractId = contract?.id;
  const [status, setStatus] = useState(null); // { available, job }
  const statusJob = useJobPolling(status?.job ?? null);
  const [band, setBand] = useState("both");
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [changeJob, setChangeJobRaw] = useState(null);
  const polled = useJobPolling(changeJob);
  const [confirmedJob, setConfirmedJob] = useState(null);
  const [confirming2, setConfirming2] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  // pedido recente que ainda espera o "Conseguiu conectar?" (inclusive de uma visita anterior a esta tela)
  const change = confirmedJob ?? polled ?? status?.pendingChange ?? null;

  useEffect(() => {
    if (!contractId) return undefined;
    const controller = new AbortController();
    setStatus(null);
    getWifiStatus(contractId, controller.signal).then(setStatus).catch(() => setStatus({ available: false, job: null }));
    return () => controller.abort();
  }, [contractId]);

  if (!status?.available) return null;
  if (status.agentOnline === false && !change) {
    return (
      <section className="cliente-panel wifi-manager" aria-labelledby="wifi-manager-title">
        <div className="cliente-panel-head">
          <Wifi size={22} />
          <div>
            <span>Minha Internet</span>
            <h3 id="wifi-manager-title">Gerenciar meu Wi-Fi</h3>
          </div>
        </div>
        <p className="wifi-muted" role="status">Indisponível agora. Tente de novo em alguns minutos ou <Link to="/cliente/atendimento?categoria=router_password">peça a troca pelo atendimento</Link>.</p>
      </section>
    );
  }

  const info = statusJob?.state === "completed" ? statusJob.result : null;
  const reading = statusJob && !statusJob.done;
  const canChange = info?.canChangePassword === true;
  const ruleState = RULES.map((r) => ({ ...r, met: r.test(password) }));
  const valid = ruleState.every((r) => r.met);
  const selectedBands = BAND_OPTIONS.find((o) => o.id === band)?.bands ?? [];
  const busy = sending || (change && !change.done);

  async function answer(connected) {
    setConfirming2(true);
    setConfirmError("");
    try {
      const r = await confirmWifiChange(change.id, connected);
      setConfirmedJob(r.job);
      if (r.error) setConfirmError(r.error);
    } catch (e) {
      setConfirmError(e?.message || "Não foi possível registrar sua resposta agora.");
    } finally {
      setConfirming2(false);
    }
  }

  async function submit() {
    setSending(true);
    setError("");
    try {
      const r = await changeWifiPassword({ contractId, newPassword: password, bands: selectedBands, currentPassword: current });
      setChangeJobRaw(r.job);
      setConfirming(false);
      setPassword("");
      setCurrent("");
    } catch (e) {
      setError(e?.message || "Não foi possível pedir a alteração agora.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="cliente-panel wifi-manager" aria-labelledby="wifi-manager-title">
      <div className="cliente-panel-head">
        <Wifi size={22} />
        <div>
          <span>Minha Internet</span>
          <h3 id="wifi-manager-title">Gerenciar meu Wi-Fi</h3>
        </div>
      </div>

      {reading ? (
        <p className="wifi-muted"><Loader2 size={16} className="wifi-spin" /> Consultando seu roteador...</p>
      ) : statusJob?.state === "failed" ? (
        <p className="wifi-muted">{statusJob.message}</p>
      ) : info ? (
        <dl className="wifi-info">
          <div><dt><Router size={14} /> Roteador</dt><dd>{info.vendor || "Não identificado"}{info.model ? ` ${info.model}` : ""}</dd></div>
          <div><dt>Status</dt><dd className={canChange ? "is-ok" : ""}>{MANAGEMENT_LABEL[info.management] ?? "—"}</dd></div>
          {info.ssids?.["2.4GHz"] ? <div><dt>Rede 2.4 GHz</dt><dd>{info.ssids["2.4GHz"]}</dd></div> : null}
          {info.ssids?.["5GHz"] ? <div><dt>Rede 5 GHz</dt><dd>{info.ssids["5GHz"]}</dd></div> : null}
        </dl>
      ) : null}

      {change ? (
        <div className={`wifi-result ${change.done ? `is-${change.needsConfirmation || change.fallbackTicket ? "pending" : change.state}` : ""}`} role="status" aria-live="polite">
          {change.done ? (change.state === "completed" || change.needsConfirmation || change.fallbackTicket ? <Check size={18} /> : <X size={18} />) : <Loader2 size={18} className="wifi-spin" />}
          <div>
            <strong>{change.message}</strong>
            {change.state === "completed" && !change.confirmation ? <p>Seus aparelhos vão precisar da nova senha para conectar de novo.</p> : null}
            {change.needsConfirmation ? (
              <div className="wifi-confirmation">
                <p><strong>Conseguiu conectar com a nova senha?</strong></p>
                <div className="wifi-confirmation-actions">
                  <button type="button" className="home-btn home-btn-primary" disabled={confirming2} onClick={() => answer(true)}>Sim, conectou</button>
                  <button type="button" className="home-btn home-btn-ghost" disabled={confirming2} onClick={() => answer(false)}>Não consegui</button>
                </div>
                {confirmError ? <p className="cliente-field-error" role="alert">{confirmError}</p> : null}
              </div>
            ) : null}
            {change.confirmation === "not_connected" && !change.ticketProtocol ? <p><Link to="/cliente/atendimento?categoria=router_password">Abrir atendimento para ajustar a senha</Link></p> : null}
            {change.fallbackTicket ? <p>Você não precisa fazer mais nada: nossa equipe troca a senha e entra em contato. Acompanhe pelo chamado.</p> : null}
            {change.done && change.state !== "completed" && !change.needsConfirmation && !change.confirmation && !change.fallbackTicket ? <p><Link to="/cliente/atendimento?categoria=router_password">Abrir atendimento para trocar a senha</Link></p> : null}
          </div>
        </div>
      ) : null}

      {info && !canChange && !change ? (
        <p className="wifi-muted">
          A troca automática ainda não está disponível para o seu roteador.{" "}
          <Link to="/cliente/atendimento?categoria=router_password">Peça a troca pelo atendimento</Link>.
        </p>
      ) : null}

      {canChange && !busy && !change?.needsConfirmation ? (
        <form className="wifi-form" onSubmit={(e) => { e.preventDefault(); if (valid) setConfirming(true); }}>
          <fieldset className="wifi-bands">
            <legend>Rede</legend>
            {BAND_OPTIONS.filter((o) => o.bands.every((b) => (info.bands ?? []).includes(b))).map((o) => (
              <label key={o.id} className={band === o.id ? "is-selected" : ""}>
                <input type="radio" name="wifi-band" value={o.id} checked={band === o.id} onChange={() => setBand(o.id)} />
                {o.label}
              </label>
            ))}
          </fieldset>
          <label htmlFor="wifi-new-password">Nova senha do Wi-Fi</label>
          <PasswordInput id="wifi-new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="Nova senha" />
          <ul className="wifi-rules">
            {ruleState.map((r) => (
              <li key={r.label} className={r.met ? "is-met" : ""}>{r.met ? <Check size={14} /> : <X size={14} />} {r.label}</li>
            ))}
          </ul>
          <button type="submit" className="home-btn home-btn-primary" disabled={!valid}><KeyRound size={16} /> Alterar senha</button>
          <p className="wifi-note">Atenção: depois da alteração, seus aparelhos vão precisar da nova senha.</p>
        </form>
      ) : null}

      {confirming ? (
        <div className="wifi-confirm" role="dialog" aria-modal="true" aria-labelledby="wifi-confirm-title">
          <div className="wifi-confirm-box">
            <h4 id="wifi-confirm-title">Confirmar a nova senha</h4>
            <p>Rede: <strong>{BAND_OPTIONS.find((o) => o.id === band)?.label}</strong>. Todos os aparelhos conectados vão cair e precisar da nova senha.</p>
            <label htmlFor="wifi-current-password">Para sua segurança, digite a senha da Central</label>
            <PasswordInput id="wifi-current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" placeholder="Senha da Central" />
            {error ? <p className="cliente-field-error" role="alert">{error}</p> : null}
            <div className="wifi-confirm-actions">
              <button type="button" className="home-btn home-btn-ghost" onClick={() => { setConfirming(false); setError(""); }} disabled={sending}>Cancelar</button>
              <button type="button" className="home-btn home-btn-primary" onClick={submit} disabled={!current || sending}>
                {sending ? <Loader2 size={16} className="wifi-spin" /> : null} Confirmar alteração
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
