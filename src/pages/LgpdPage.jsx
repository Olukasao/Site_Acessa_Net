import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Check, Database, Mail, ShieldCheck, Smartphone, Sparkles, UserCheck } from "lucide-react";
import { company } from "../data/site";
import { useReveal } from "../hooks/useReveal";
import "../sections/sections.css";
import "./institucional.css";

// Conteúdo copiado da página /lgpd da produção (branch site-antigo,
// src/pages/LGPD.jsx) -- só a apresentação é nova.
const privacyEmail = "contato@acessanet.com";

const sections = [
  {
    id: "dados-coletados",
    icon: Database,
    title: "Dados que coletamos",
    intro: "Coletamos apenas os dados essenciais para a prestação de nossos serviços, como:",
    items: [
      "Nome completo",
      "CPF e RG",
      "Endereço completo",
      "Telefone e e-mail",
      "Dados bancários (quando necessário para cobrança)",
    ],
  },
  {
    id: "uso-dos-dados",
    icon: Sparkles,
    title: "Como utilizamos seus dados",
    intro: "Essas informações são utilizadas exclusivamente para:",
    items: [
      "Instalação e manutenção dos serviços contratados",
      "Emissão de boletos e faturas",
      "Atendimento e suporte técnico",
      "Envio de comunicações sobre os serviços (vencimentos, promoções e avisos)",
    ],
  },
  {
    id: "aplicativo",
    icon: Smartphone,
    title: "Aplicativo AcessaNet (Android)",
    intro: "Ao usar o aplicativo AcessaNet para Android, tratamos:",
    items: [
      "CPF/CNPJ e senha, para identificar você e manter a sua sessão segura",
      "Nome, e-mail, telefone, endereço, contrato, faturas e chamados, para mostrar as informações do seu serviço",
      "O histórico das telas acessadas, para melhorar o atendimento",
      "Se você permitir notificações, um identificador do seu aparelho (token de notificações do Firebase, da Google), usado somente para avisar sobre visitas técnicas agendadas e faturas vencidas. Você pode desativar as notificações a qualquer momento nas configurações do Android, e o identificador deixa de ser usado quando você sai da conta",
      "Se você tocar em \"Enviar localização da minha casa\" em um chamado com visita técnica agendada, o ponto de GPS da sua casa, lido uma única vez nesse momento. Ele serve só para o técnico chegar ao endereço: nossa equipe confere o ponto antes de passá-lo ao técnico. Não acompanhamos o seu trajeto nem lemos a localização em segundo plano, e você pode negar a permissão sem perder nenhum outro recurso",
    ],
    outro:
      "Não coletamos contatos, fotos nem dados de cartão, e só coletamos a sua localização no envio opcional descrito acima. Os dados trafegam criptografados e são tratados por prestadores que atuam em nosso nome (como a Google, na entrega das notificações), sem venda de dados.",
  },
  {
    id: "seguranca",
    icon: ShieldCheck,
    title: "Segurança das informações",
    intro:
      "Todos os dados são armazenados com segurança, com acesso restrito a profissionais autorizados e seguindo rígidos padrões de confidencialidade.",
  },
  {
    id: "seus-direitos",
    icon: UserCheck,
    title: "Seus direitos",
    intro: "Você tem o direito de:",
    items: [
      "Acessar seus dados",
      "Corrigir informações incompletas ou desatualizadas",
      "Solicitar a exclusão de dados (quando permitido por lei). No aplicativo, use o botão \"Excluir minha conta e dados\" no Perfil",
      "Solicitar a portabilidade ou limitação do uso de seus dados",
    ],
  },
];

export default function LgpdPage() {
  const ref = useRef(null);
  useReveal(ref);
  useEffect(() => {
    document.title = "LGPD e Privacidade | AcessaNet";
  }, []);

  return (
    <>
      <section className="page-hero" aria-labelledby="lgpd-title">
        <div className="container">
          <span className="eyebrow">Privacidade</span>
          <h1 id="lgpd-title">Proteção de dados pessoais</h1>
          <p>
            A {company.name} se compromete com a proteção dos seus dados pessoais, em total conformidade com a
            Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018 – LGPD).
          </p>
        </div>
      </section>

      <section ref={ref} className="section inst" aria-label="Política de privacidade">
        <div className="container inst-layout">
          <nav className="inst-index" aria-label="Nesta página">
            <span>Nesta página</span>
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`}>{s.title}</a>
            ))}
            <a href="#contato-lgpd">Contato</a>
          </nav>

          <div className="inst-stack">
            {sections.map(({ id, icon: Icon, title, intro, items, outro }) => (
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
                {outro && <p>{outro}</p>}
              </article>
            ))}

            <div id="contato-lgpd" className="inst-cta" data-reveal>
              <div>
                <h2>Contato</h2>
                <p>
                  Para mais informações ou para exercer seus direitos, entre em contato pelo e-mail. Para excluir a sua
                  conta do aplicativo e os dados associados, veja a página <Link to="/excluir-conta">Excluir conta e dados</Link>.
                </p>
              </div>
              <a className="btn btn--primary" href={`mailto:${privacyEmail}`}>
                <Mail size={18} aria-hidden="true" /> {privacyEmail}
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
