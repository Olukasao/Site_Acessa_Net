import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, History, KeyRound, Loader2, Pencil, Router, Wifi, X } from "lucide-react";
import { Link } from "react-router-dom";
import { changeWifiName, changeWifiPassword, confirmWifiChange, getWifiHistory, getWifiJob, getWifiStatus, revealWifiLastPassword } from "../clienteApi";
import "./wifiManager.css";

/**
 * Minha Internet -> Gerenciar Wi-Fi. A tela so manda o contrato, as redes e as senhas; quem descobre o roteador
 * (pelo SGP) e altera e o servidor. Aparece so quando a funcao esta ligada para o contrato.
 */
const RULES = [
  { label: "8 a 63 caracteres", test: (v) => v.length >= 8 && v.length <= 63 },
  { label: "Uma letra maiúscula", test: (v) => /[A-Z]/.test(v) },
  { label: "Um número", test: (v) => /[0-9]/.test(v) },
  { label: "Um caractere especial", test: (v) => /[^A-Za-z0-9]/.test(v) },
  { label: "Sem acento e sem espaço no começo ou no fim", test: (v) => v.length > 0 && /^[\x20-\x7E]+$/.test(v) && v === v.trim() }
];
// Nome: o cliente digita so a base; " 2.4" e " 5G" sao acrescentados e as duas redes mudam juntas.
function nameProblem(v) {
  if (!v) return "Digite o nome do Wi-Fi.";
  if (v !== v.trim()) return "Sem espaço no começo ou no fim.";
  if (v.length > 28) return "No máximo 28 caracteres.";
  if (!/^[A-Za-z0-9 ._-]+$/.test(v)) return "Use só letras sem acento, números, espaço, ponto, hífen e _.";
  if (/ {2}/.test(v)) return "Use só um espaço entre as palavras.";
  if (/(^|[\s._-])(2\.?4|5)\s*(g|ghz)?$/i.test(v)) return "Não digite 2.4 nem 5G: eles são acrescentados sozinhos.";
  return "";
}
const KIND_LABEL = { change_password: "Senha do Wi-Fi", change_ssid: "Nome do Wi-Fi" };
const fmtDate = (v) => (v ? new Date(v).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
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
    }, 1000);
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

export default function WifiManagerCard({ contract, embedded = false, onUnavailable, onTicketOpened }) {
  const contractId = contract?.id;
  const [status, setStatus] = useState(null); // { available, job }
  const statusJob = useJobPolling(status?.job ?? null);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [action, setAction] = useState("password"); // o que o dialogo de confirmacao vai fazer: password | name | reveal
  const [baseName, setBaseName] = useState("");
  const [history, setHistory] = useState(null);
  const [revealed, setRevealed] = useState(null); // { password, bands } -- some sozinho
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

  const loadHistory = () => {
    if (!contractId) return;
    getWifiHistory(contractId).then(setHistory).catch(() => setHistory(null));
  };
  useEffect(() => {
    if (!contractId || !status?.available) return;
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, status?.available, polled?.done, confirmedJob]);

  // A senha mostrada some sozinha (30 s) e ao sair da tela.
  useEffect(() => {
    if (!revealed) return undefined;
    const t = setTimeout(() => setRevealed(null), 30_000);
    return () => clearTimeout(t);
  }, [revealed]);
  useEffect(() => () => setRevealed(null), []);

  // No fluxo de atendimento ("Troca de senha do roteador"): se a troca automatica nao serve para este roteador/momento,
  // avisa a tela para seguir com o pedido normal de chamado.
  useEffect(() => {
    if (!embedded || !onUnavailable || status === null || change) return;
    const semServico = !status.available || status.agentOnline === false;
    const leituraTerminou = statusJob?.done === true;
    const naoTroca = leituraTerminou && !(statusJob.state === "completed" && statusJob.result?.canChangePassword === true);
    if (semServico || naoTroca) onUnavailable();
  }, [embedded, onUnavailable, status, statusJob, change]);

  // O chamado da troca que nao funcionou (ou do "nao consegui conectar") foi aberto: a tela de chamados atualiza.
  const openedProtocol = change?.ticketProtocol ?? null;
  useEffect(() => {
    if (openedProtocol) onTicketOpened?.();
  }, [openedProtocol, onTicketOpened]);

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
  const nameError = nameProblem(baseName);
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

  function ask(kind) {
    setAction(kind);
    setError("");
    setCurrent("");
    setConfirming(true);
  }

  async function submit() {
    setSending(true);
    setError("");
    try {
      if (action === "reveal") {
        const r = await revealWifiLastPassword({ contractId, currentPassword: current });
        setRevealed({ password: r.password, bands: r.bands });
        setConfirming(false);
        setCurrent("");
        return;
      }
      const r =
        action === "name"
          ? await changeWifiName({ contractId, name: baseName, currentPassword: current })
          : await changeWifiPassword({ contractId, newPassword: password, currentPassword: current });
      setConfirmedJob(null);
      setChangeJobRaw(r.job);
      setConfirming(false);
      setPassword("");
      setBaseName("");
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
            {(change.state === "completed" || change.needsConfirmation) && change.confirmation !== "not_connected" ? (
              <div className="wifi-forget" role="note">
                <strong>Importante: esqueça a rede nos seus aparelhos</strong>
                <p>
                  {change.kind === "change_ssid"
                    ? "Os nomes mudaram. Nos celulares, TVs e computadores, procure as redes novas e conecte de novo. Apague (esqueça) as redes com o nome antigo para não confundir."
                    : "Seus aparelhos ainda guardam a senha antiga. Em cada um, toque na rede, escolha “Esquecer rede” e conecte de novo com a nova senha."}
                </p>
              </div>
            ) : null}
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

      {info && !canChange && !change && !embedded ? (
        <p className="wifi-muted">
          A troca automática ainda não está disponível para o seu roteador.{" "}
          <Link to="/cliente/atendimento?categoria=router_password">Peça a troca pelo atendimento</Link>.
        </p>
      ) : null}

      {canChange && !busy && !change?.needsConfirmation ? (
        <form className="wifi-form" onSubmit={(e) => { e.preventDefault(); if (valid) ask("password"); }}>
          <label htmlFor="wifi-new-password">Nova senha do Wi-Fi</label>
          <PasswordInput id="wifi-new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="Nova senha" />
          <ul className="wifi-rules">
            {ruleState.map((r) => (
              <li key={r.label} className={r.met ? "is-met" : ""}>{r.met ? <Check size={14} /> : <X size={14} />} {r.label}</li>
            ))}
          </ul>
          <button type="submit" className="home-btn home-btn-primary" disabled={!valid}><KeyRound size={16} /> Alterar senha</button>
          <p className="wifi-note">A senha é trocada nas duas redes (2.4 e 5G). Depois da alteração, seus aparelhos vão precisar da nova senha.</p>
        </form>
      ) : null}

      {canChange && !busy && !change?.needsConfirmation ? (
        <form className="wifi-form wifi-name-form" onSubmit={(e) => { e.preventDefault(); if (!nameError) ask("name"); }}>
          <label htmlFor="wifi-new-name">Nome do Wi-Fi</label>
          <input id="wifi-new-name" className="wifi-name-input" value={baseName} onChange={(e) => setBaseName(e.target.value)} maxLength={28} autoComplete="off" spellCheck={false} placeholder="Ex.: Casa da Ana" />
          {baseName ? (
            nameError ? <p className="cliente-field-error" role="alert">{nameError}</p> : (
              <p className="wifi-note">Ficará: <strong>{baseName} 2.4</strong> e <strong>{baseName} 5G</strong>. As duas redes mudam juntas.</p>
            )
          ) : <p className="wifi-note">Digite só o nome. O sistema acrescenta 2.4 e 5G e troca as duas redes juntas.</p>}
          <button type="submit" className="home-btn home-btn-primary" disabled={!!nameError}><Pencil size={16} /> Alterar nome</button>
          <p className="wifi-note">Depois da alteração, seus aparelhos vão precisar escolher a rede com o novo nome.</p>
        </form>
      ) : null}

      {history && history.available && (history.items.length > 0 || history.lastPassword) ? (
        <div className="wifi-history">
          <h4><History size={16} /> Últimas alterações</h4>
          {history.lastPassword ? (
            revealed ? (
              <div className="wifi-last-password" role="status">
                <span>Última senha definida pela Central:</span>
                <code>{revealed.password}</code>
                <button type="button" className="home-btn home-btn-ghost" onClick={() => setRevealed(null)}>Ocultar</button>
              </div>
            ) : (
              <button type="button" className="home-btn home-btn-ghost" onClick={() => ask("reveal")}><Eye size={16} /> Ver a última senha</button>
            )
          ) : null}
          <ul>
            {history.items.map((i) => (
              <li key={i.id} className={`is-${i.state}`}>
                <strong>{KIND_LABEL[i.kind] ?? "Wi-Fi"}</strong>
                <span>{fmtDate(i.finishedAt || i.createdAt)}</span>
                <span>{i.kind === "change_ssid" && i.names ? `${i.names["2.4GHz"]} / ${i.names["5GHz"]}` : (i.bands ?? []).join(" e ")}</span>
                <em>{i.state === "completed" ? "Concluída" : i.done ? (i.ticketProtocol ? `Chamado ${i.ticketProtocol}` : "Não concluída") : "Em andamento"}</em>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {confirming ? (
        <div className="wifi-confirm" role="dialog" aria-modal="true" aria-labelledby="wifi-confirm-title">
          <div className="wifi-confirm-box">
            <h4 id="wifi-confirm-title">{action === "reveal" ? "Ver a última senha" : action === "name" ? "Confirmar o novo nome" : "Confirmar a nova senha"}</h4>
            {action === "reveal" ? (
              <p>Por segurança, a senha só aparece depois de você confirmar a senha da Central. Ela some sozinha em 30 segundos.</p>
            ) : action === "name" ? (
              <p>Novos nomes: <strong>{baseName} 2.4</strong> e <strong>{baseName} 5G</strong>. Os aparelhos conectados vão cair e precisar escolher a rede de novo.</p>
            ) : (
              <p>A nova senha vale para as duas redes (<strong>2.4 e 5G</strong>). Todos os aparelhos conectados vão cair e precisar da nova senha.</p>
            )}
            <label htmlFor="wifi-current-password">Para sua segurança, digite a senha da Central</label>
            <PasswordInput id="wifi-current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" placeholder="Senha da Central" />
            {error ? <p className="cliente-field-error" role="alert">{error}</p> : null}
            <div className="wifi-confirm-actions">
              <button type="button" className="home-btn home-btn-ghost" onClick={() => { setConfirming(false); setError(""); }} disabled={sending}>Cancelar</button>
              <button type="button" className="home-btn home-btn-primary" onClick={submit} disabled={!current || sending}>
                {sending ? <Loader2 size={16} className="wifi-spin" /> : null} {action === "reveal" ? "Mostrar senha" : "Confirmar alteração"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
