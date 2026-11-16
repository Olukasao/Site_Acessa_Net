# Agente de roteadores (Gerenciar meu Wi-Fi)

Roda **dentro da rede da AcessaNet** (os IPs PPPoE são CGNAT 100.64.0.0/10 e a Central fica na Hostinger, sem acesso a eles).

```
App/Site -> Central (Hostinger) -- tarefa: contrato + senha cifrada --> Agente (rede interna)
                                                                        |-> SGP: verificaacesso (API oficial) -> serviço
                                                                        |-> SGP painel: infodetail?statusonly=1 -> IP/MAC da sessão PPPoE
                                                                        |-> SGP painel: "Tipo equipamento" -> fabricante
                                                                        '-> roteador (só modelo validado, só fora do modo seguro)
```

- O agente **busca** as tarefas na Central (`POST /api/internal/router-agent/claim`) e devolve o resultado. Nenhuma porta da rede interna fica aberta para fora.
- A senha nova chega cifrada (RSA-OAEP, chave pública do agente na Central). Só o agente abre. A Central apaga o texto cifrado quando a tarefa termina.
- O destino vem **só do SGP** e precisa estar em `ROUTER_ALLOWED_CIDRS`. A porta e o protocolo vêm de `ROUTER_ENDPOINTS`, por fabricante. O cliente nunca informa IP, porta ou roteador.
- As credenciais de administrador ficam no cofre cifrado (`ROUTER_CREDENTIALS_PATH` + `ROUTER_CREDENTIALS_KEY`). Nunca vão ao git, à Central ou ao log.
- Com `ROUTER_AGENT_DRY_RUN=1` (o padrão), o agente só lê o SGP e **nunca entra num roteador**.
- O painel do SGP não é API oficial. Se o layout mudar, a leitura devolve vazio e a tarefa falha com `SGP_UNAVAILABLE`, sem chutar valores.

## Estado dos fabricantes

| Fabricante | Situação | Credencial no cofre |
|---|---|---|
| TP-Link | `requires_validation` | sim (só senha) |
| Huawei | `requires_validation` | sim |
| Stavix | `requires_validation` (não existe no "Tipo equipamento" do SGP) | sim |
| Mercusys | `requires_validation` | não informada |

Para validar um modelo é preciso um roteador de bancada com modelo e firmware exatos. Com o navegador e as ferramentas de desenvolvedor, levantar o fluxo de login, onde ficam SSID e senha (2.4 e 5 GHz), como o painel salva e como reler a configuração. Depois disso, o adaptador do modelo é implementado em `src/adapters/` e muda para `supported`, com testes.

## Configuração (fora do repositório)

Os segredos ficam em `/home/noc/router-agent-data/` (pasta 700, arquivos 600):

- `agent.env`: variáveis do agente (`.env` aqui é um atalho para ele);
- `agent-key.pem`: chave privada;
- `central-public-key.txt`: linha `ROUTER_AGENT_PUBLIC_KEY=...` para o `.env` da Central;
- `agent-token`: o mesmo valor vai para `ROUTER_AGENT_TOKEN` da Central;
- `credentials.enc.json` + `credentials.key`: o cofre.

Gravar ou trocar uma credencial: `npm run set-credential -- tplink` (pergunta usuário e senha no teclado).

Central (`server/.env` na Hostinger): `ROUTER_WIFI_ENABLED=1`, `ROUTER_AGENT_TOKEN`, `ROUTER_AGENT_PUBLIC_KEY` e, para o piloto, `ROUTER_WIFI_PILOT_CONTRACTS=3005,...`.

## Rodar

```
npm test           # testes com SGP e roteador simulados
npm start          # usa .env (atalho para /home/noc/router-agent-data/agent.env)
```
