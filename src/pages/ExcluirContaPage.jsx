import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Check, Clock, FileLock2, Mail, Smartphone, Trash2 } from "lucide-react";
import { company } from "../data/site";
import { useReveal } from "../hooks/useReveal";
import "../sections/sections.css";
import "./institucional.css";

const privacyEmail = "contato@acessanet.com";
const subject = "Solicitação de exclusão de conta e dados (LGPD)";
const body = [
  "Olá, quero excluir a minha conta do aplicativo AcessaNet e os meus dados pessoais.",
  "",
  "Nome completo:",
  "CPF ou CNPJ do titular:",
  "",
  "Para confirmar que sou eu, respondo a este e-mail com os dados que forem pedidos.",
].join("\n");
const mailto = `mailto:${privacyEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

const sections = [
  {
    id: "como-pedir",
    icon: Trash2,
    title: "Como pedir a exclusão",
    intro: "Você pode pedir a exclusão da sua conta do aplicativo e dos dados associados de duas formas:",
    items: [
      "Pelo aplicativo: abra o Perfil e toque em \"Excluir minha conta e dados\". Vamos abrir um e-mail já preenchido para a AcessaNet.",
      "Por e-mail: escreva para contato@acessanet.com com o assunto \"Solicitação de exclusão de conta e dados (LGPD)\", informando o nome completo e o CPF ou CNPJ do titular.",
    ],
  },
  {
    id: "o-que-acontece",
    icon: Clock,
    title: "O que acontece depois",
    intro: "Para a sua segurança, primeiro confirmamos que o pedido é do titular. Depois disso:",
    items: [
      "Apagamos a conta do aplicativo: o acesso, a senha e os aparelhos cadastrados para receber avisos",
      "Eliminamos os dados pessoais que não precisamos guardar por lei ou por contrato",
      "Respondemos ao seu pedido em até 15 dias",
      "O seu contrato de internet não é cancelado por esse pedido. Para cancelar ou alterar o plano, fale com o nosso atendimento",
    ],
  },
  {
    id: "o-que-mantemos",
    icon: FileLock2,
    title: "O que podemos manter",
    intro:
      "Alguns dados precisam ser guardados porque a lei ou o contrato exigem, como registros de cobrança e fiscais, registros de conexão e dados necessários para a defesa em processos. Eles ficam guardados apenas pelo prazo legal, com acesso restrito, e depois são eliminados.",
  },
];

export default function ExcluirContaPage() {
  const ref = useRef(null);
  useReveal(ref);
  useEffect(() => {
    document.title = "Excluir conta e dados | AcessaNet";
  }, []);

  return (
    <>
      <section className="page-hero" aria-labelledby="excluir-title">
        <div className="container">
          <span className="eyebrow">Aplicativo AcessaNet</span>
          <h1 id="excluir-title">Excluir conta e dados</h1>
          <p>
            Esta página explica como pedir a exclusão da sua conta do aplicativo AcessaNet (Android), de
            responsabilidade da {company.name}, e dos dados associados a ela, conforme a Lei Geral de Proteção de Dados
            (Lei nº 13.709/2018 – LGPD).
          </p>
        </div>
      </section>

      <section ref={ref} className="section inst" aria-label="Exclusão de conta e dados">
        <div className="container inst-layout">
          <nav className="inst-index" aria-label="Nesta página">
            <span>Nesta página</span>
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`}>{s.title}</a>
            ))}
            <a href="#pedir-agora">Pedir agora</a>
          </nav>

          <div className="inst-stack">
            {sections.map(({ id, icon: Icon, title, intro, items }) => (
              <article key={id} id={id} className="inst-card" data-reveal>
                <header className="inst-card-head">
                  <span className="inst-ico" aria-hidden="true"><Icon size={22} /></span>
                  <h2>{title}</h2>
                </header>
                <p>{intro}</p>
                {items && (
                  <ul className="inst-list">
                    {items.map((item) => (
                      <li key={item}>
                        <Check size={16} aria-hidden="true" />
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}

            <div id="pedir-agora" className="inst-cta" data-reveal>
              <div>
                <h2>Pedir a exclusão agora</h2>
                <p>
                  Toque no botão para abrir um e-mail pronto para <strong>{privacyEmail}</strong>. Preencha o nome e o
                  CPF ou CNPJ do titular e envie.
                </p>
              </div>
              <a className="btn btn--primary" href={mailto}>
                <Mail size={18} aria-hidden="true" /> Pedir exclusão por e-mail
              </a>
            </div>

            <p className="inst-note">
              <Smartphone size={16} aria-hidden="true" />
              <span>
                Quer saber como tratamos os seus dados? Veja a nossa <Link to="/lgpd">política de privacidade</Link>.
              </span>
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
