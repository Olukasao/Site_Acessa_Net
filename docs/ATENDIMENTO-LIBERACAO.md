# Chat de atendimento com o cliente: roteiro de liberação

Estado em 11/11/2026: tudo está **pronto e testado em código, mas desligado em produção**. Nada disto chega ao cliente
até alguém fazer os passos abaixo.

## O que existe
| Peça | Onde | Estado |
|---|---|---|
| Atendimento no Workspace (fila, conversa, Ficha 360, setores, SLA, supervisão, relatórios, telefone) | Workspace 0.6.38+ | publicado (só administradores veem o módulo) |
| chat-api (conversas, setores, SLA, relatórios, push) | `acessanet-app-api/acessanet-chat-api` | no ar em teste (porta 9510, painel 9520) |
| Token de chat do cliente `POST /api/auth/chat-token` | `server/src/routes/chatTokenRoutes.ts` | código + testes; desligado sem `CHAT_TOKEN_SECRET` |
| Aviso no celular `POST /api/integracoes/atendimento/push` | `server/src/routes/chatPushRoutes.ts` | código + testes; a rota nem existe sem `CHAT_PUSH_TOKEN` |
| Chat do cliente (`AtendimentoChatGate`) | `src/cliente/ClienteArea.jsx` | código; **só aparece quando um atendente abre a conversa** |

## Como o cliente passa a ver o chat
1. O atendente abre o Workspace > Atendimento > **Chamados abertos** > **Abrir atendimento**.
2. A chat-api cria a conversa atribuída a ele e pede o aviso ao site (`SITE_PUSH_URL`).
3. O site manda o push (FCM) para os aparelhos do cliente: "Um atendente da AcessaNet iniciou uma conversa com você."
4. Na Central (site e app) o chat aparece sozinho (botão "Atendimento"; painel abre na primeira vez). Antes disso o cliente não vê nada.

## Para liberar (nesta ordem; nada disto foi feito)
1. **Segredos.** Gerar dois segredos de 32+ caracteres:
   - `CHAT_TOKEN_SECRET` no site = `CUSTOMER_CHAT_JWT_SECRET` da chat-api (mesmo valor).
   - `CHAT_PUSH_TOKEN` no site = `SITE_PUSH_TOKEN` da chat-api (mesmo valor).
2. **chat-api (.env.production):** `CUSTOMER_AUTH_MODE=external`, `CUSTOMER_AUTH_DEV_ENABLED=false`, `SITE_PUSH_URL=https://acessanet.com.br/api/integracoes/atendimento/push`, `SITE_PUSH_TOKEN`, `CORS_ORIGINS` com o domínio do site, e reiniciar.
3. **Exposição:** a chat-api precisa responder em `/chat-api` no domínio do site (ver `docs/nginx.example.conf` da chat-api; Socket.IO no mesmo domínio).
4. **Site:** subir o servidor (`deploy-hostinger.sh`, com backup do banco antes) com as variáveis do item 1.
5. **App Android:** o app usa o código da Central. Para o chat aparecer no app é preciso gerar nova versão (AAB). O push já usa o canal "chamados".
6. **Teste com a conta TESTE SUPORTE (contrato 3005)** antes de qualquer cliente real: abrir atendimento, ver o push, responder, encerrar.
7. Só então liberar o módulo Atendimento para os atendentes (Admin > Funções) e cadastrá-los na chat-api (`AGENT_AUTO_PROVISION` fica desligado: só entra quem o admin cadastrou).

## Pendências conhecidas
- WhatsApp, e-mail e redes sociais não existem (não foram pedidos).
- Anexos (foto/print) no chat do cliente não existem.
- Setores organizam a fila, mas não impedem um atendente de abrir uma conversa que lhe foi passada.
