---
id: KBC-027
title: "Assinatura do ChatGPT (Codex) como IA da aplicação, com sandbox obrigatório"
status: in-review
slice: release-1
outcome: o dono usa e cede a sua assinatura do ChatGPT como a do Claude, e um turno do Codex nunca lê o estado, o login do Claude, o .env nem a chave de cifra
depends_on: [KBC-007, KBC-022, KBC-024]
---

# KBC-027 — Assinatura do ChatGPT (Codex) como IA da aplicação, com sandbox

## Story
Como dono da Nova Alexandria, quero usar a minha assinatura do ChatGPT na aplicação e cedê-la a uma, várias ou todas as pessoas, como faço com a do Claude, sem que um turno do Codex consiga ler os segredos do servidor.

Decisão do dono em 2026-10-26: a assinatura do ChatGPT (Codex) entra como IA da aplicação, igual ao Claude (uso do dono e cessão a um, vários ou todos); o Codex CLI vai na imagem (versão fixa, arm64), o CODEX_HOME fica num volume com backup, o login do dono é por device-code via SSH, há um liga/desliga na tela de master e o **sandbox é obrigatório**: um teste prova que um turno do Codex não lê o estado, as credenciais do Claude, o .env nem a chave de cifra; se não for viável, bloquear e reportar.

Pesquisa do mesmo dia (Codex CLI 0.164.0): `codex login --device-auth` existe; o Codex tem ferramentas que não dá para desligar todas (navegador, computador, apps, plugins, sub-agentes; o conjunto muda entre versões), e `--sandbox read-only` restringe escrita e rede, não leitura (ADR 0007). Por isso o isolamento é de contêiner, não de configuração.

## Scope
**In:**
- Codex CLI 0.164.0 na imagem da API (arm64 e amd64) e um **contêiner separado** (`codex`), da mesma imagem, com outro usuário (uid 10002), só o volume do CODEX_HOME montado, sem `.env`, sem o estado, sem o login do Claude, sem a chave de cifra, sistema de arquivos só de leitura e sem capacidades; um executor pequeno (`codex-runner`) dentro dele recebe cada turno da API pela rede interna e roda o Codex com ambiente mínimo.
- A API manda os turnos do Codex ao executor (`KB_CHAT_CODEX_RUNNER_URL`); o Codex alcança as ferramentas do turno pelo endpoint MCP da API com o token do turno, aceito só do endereço fixo do contêiner (`KB_CHAT_MCP_PEERS`). Em produção, o Codex só roda por esse executor.
- Liga/desliga em ⚙ > IA da aplicação ("Assinatura do ChatGPT (Codex)"), com o estado do login no servidor.
- A assinatura do ChatGPT como IA da aplicação: o dono usa e cede como a do Claude (KBC-024: só o dono cede, confirmação dos termos, nunca padrão, cota diária, aviso à pessoa, auditoria).
- CODEX_HOME em `/srv/kb-chat/codex` no backup cifrado; login do dono por `codex login --device-auth` via SSH (runbook).
- Prova do sandbox em CI: a imagem é construída e um turno de prova passa pelo executor real, tentando ler cópias-canário do estado, do login do Claude, do `.env` e da chave.

**Out:**
- Pré-configurar a IA no convite (KBC-028).
- Medir o uso da assinatura do ChatGPT em tokens.
- Impedir o Codex de ler o próprio login (o `auth.json` do CODEX_HOME é dele; risco aceito na ADR 0020).

## Business rules
- BR-1: o Codex só atende com o liga/desliga ligado por um master e o executor configurado; em produção, nunca roda dentro do contêiner da API.
- BR-2: um turno do Codex roda no contêiner `codex`: não vê o estado (`/data/state`), o login do Claude, o `.env`, a chave de cifra nem outras variáveis do servidor; o executor passa ao Codex só PATH, HOME, CODEX_HOME, locale e o token do turno.
- BR-3: o endpoint MCP aceita o Codex só do endereço fixo do contêiner e só com o token do turno (24 bytes, válido só durante o turno).
- BR-4: a assinatura do ChatGPT segue as regras da do Claude (KBC-024 BR-1 a BR-7): só o dono cede, termos confirmados (o texto cita os termos da OpenAI), nunca padrão, cota diária, aviso à pessoa, auditoria.
- BR-5: sem o login no servidor, o turno falha com "faça login" e a cessão pausa 10 minutos, como no Claude.

## Functional requirements
- FR-1: `apps/api/Dockerfile` instala `@openai/codex@0.164.0` e cria o usuário `codex` (10002); `deploy/compose.yml` ganha o serviço `codex` (perfil `codex`, mesma imagem, `node dist/codex-runner-main.js`, rede `codex` com IP fixo, volume do CODEX_HOME, `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, sem `env_file`).
- FR-2: `codex-runner`: `POST /turn { model?, input, token }` (só do endereço da API, `CODEX_RUNNER_CLIENTS`) monta ele mesmo os argumentos travados (MCP fixo em `CODEX_MCP_URL`), roda um turno por vez numa pasta temporária, encerra antes o que um turno anterior deixou solto, devolve as linhas do stdout e a saída; fecha o processo quando a API desiste; `GET /health`; `GET /status` (logado ou não, por `codex login status`).
- FR-3: a API: `CodexCliRunner` usa o executor quando `KB_CHAT_CODEX_RUNNER_URL` existe; `KB_CHAT_MCP_PEERS` libera o MCP (com o token do turno) para aquele endereço, que não alcança nenhuma outra rota (404); em produção, `KB_CHAT_CODEX=on` sem executor é recusado na partida; a cessão pausa 10 minutos quando o executor não roda o turno, e só aparece cedível com o Codex ligado e logado.
- FR-4: contrato: `APP_AIS` e `LENT_SUBSCRIPTIONS` ganham `chatgpt-subscription`; `researchPlanSchema` ganha `app-chatgpt-subscription`; `houseAiView.codex = { configured, enabled, loggedIn }`; `PUT /house-ai { codexEnabled }`.
- FR-5: tela: o cartão "Assinatura do ChatGPT (Codex)" em IA da aplicação (liga/desliga, login no servidor); a opção "ChatGPT do administrador" no editor da pessoa e na barra em massa, com os termos da OpenAI; o aviso e o rodapé da pessoa dizem "assinatura do ChatGPT do administrador".
- FR-6: CI: o job "Codex sandbox" constrói a imagem e prova BR-2 pelo executor real.

## Non-functional requirements
- NFR-1: nenhuma chamada real ao Codex nem à OpenAI nos testes (CLI falso nos testes, sonda no job de CI).
- NFR-2: WCAG 2.2 AA nas telas novas, em 1440 e 390 px.
- NFR-3: nenhuma credencial em resposta, log ou disco fora do CODEX_HOME.

## Acceptance criteria
- **AC-1 (BR-2, FR-6)**
  - Given o contêiner `codex` como em produção, com cópias-canário do estado, do login do Claude, do `.env` e da chave no host
  - When um turno de prova passa pelo executor
  - Then ele não lê nenhuma delas, e o ambiente do processo não tem `KB_CHAT_SECRETS_KEY` nem outras variáveis do servidor
- **AC-2 (FR-2, FR-3)**
  - Given o liga/desliga ligado e o executor configurado
  - When o dono pesquisa com a assinatura do ChatGPT
  - Then o turno vai ao executor, o Codex usa as ferramentas do acervo pelo MCP do turno e a resposta diz "Incluído na sua assinatura"
- **AC-3 (BR-3)**
  - Given o endpoint MCP
  - When uma chamada chega de outro endereço que não o loopback nem o do contêiner `codex`, ou sem o token do turno
  - Then recebe 404
- **AC-4 (BR-1, FR-5)**
  - Given um master em ⚙ > IA da aplicação
  - When ele desliga a assinatura do ChatGPT
  - Then ninguém é atendido por ela (o dono nem quem a recebeu), e o cartão mostra "Desligada"
- **AC-5 (BR-4)**
  - Given o dono no editor de uma pessoa
  - When escolhe "ChatGPT do administrador"
  - Then a confirmação cita os termos da OpenAI; ao ceder, a pesquisa da pessoa sai pelo executor com `plan: app-chatgpt-subscription`, a cota é contada e o histórico diz "(termos confirmados)"
- **AC-6 (FR-3)**
  - Given produção
  - When `KB_CHAT_CODEX=on` sem `KB_CHAT_CODEX_RUNNER_URL`
  - Then a API não sobe e diz por quê

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | CI (job "Codex sandbox", `deploy/scripts/codex-sandbox-proof.sh`) | imagem real, compose real, sonda pelo executor |
| AC-2 | integração (`codex-runner.integration.test.ts`: executor real + CLI falso) | sem rede externa |
| AC-3 | unitário (`mcp.test.ts`) | endereço e token |
| AC-4, AC-5 | integração + unitário web + E2E (`lent-subscription.spec.ts`, executor stub no servidor de E2E) | — |
| AC-6 | unitário (`config.test.ts`) | — |

## References
ADR: `docs/adr/0020-sandboxed-codex-runner.md` (emenda 0007, 0010, 0019) · Telas: `docs/design/screens.md` (T9, T12) · Runbook passo 9c.

## Open questions
Nenhuma. Premissas: o contêiner usa a mesma imagem da API (o pipeline continua com duas imagens por digest); o serviço fica no perfil `codex` (o dono liga com `COMPOSE_PROFILES=codex` no `.env`); o liga/desliga vale para todos os masters; ceder segue só do dono.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
