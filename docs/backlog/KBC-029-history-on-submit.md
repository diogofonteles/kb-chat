---
id: KBC-029
title: "A conversa aparece no histórico assim que a pergunta é enviada"
status: in-review
slice: release-1
outcome: toda pergunta enviada (busca ou pesquisa com IA) está no histórico no mesmo instante e nunca some; a pesquisa termina mesmo se a página recarregar, e o histórico diz se ela ainda está pesquisando, se foi interrompida ou se falhou
depends_on: [KBC-005, KBC-008, KBC-011]
---

# KBC-029 — Conversa no histórico desde o envio da pergunta

## Story
Como leitor, quero que a conversa apareça no histórico assim que eu envio a pergunta, para não perder a pergunta se eu recarregar, fechar a aba ou a pesquisa falhar, e para saber pelo histórico o que ainda está pesquisando.

Pedido do dono em 2026-10-27: "Percebi que a conversa só fica no histórico quando ela dá uma resposta, mas preciso que quando eu escreva uma pergunta e ela inicie a busca, aquela conversa já apareça no histórico."

## Scope
**In:**
- Busca e pesquisa com IA: a conversa é gravada no envio da primeira pergunta (título = a pergunta, como hoje) e aparece no topo do histórico, selecionada.
- Pesquisa com IA: o servidor grava o turno como pendente ao começar e o resultado ao terminar (respondida, interrompida ou falhou), em todos os caminhos de provedor (laço por token, assinaturas Claude/Codex, sub-pesquisadores, plano da casa, assinaturas cedidas).
- O turno roda no servidor até o fim, mesmo se a página recarregar, a aba fechar ou a pessoa abrir outra conversa; só "Parar" (ou o teto de 60 min) para.
- Recarregar volta à conversa da pesquisa que estava na tela (por aba) e retoma a resposta do começo, ao vivo.
- Histórico: "pesquisando…" (com spinner), "interrompida" e "falhou", em texto; pesquisas em andamento fora da tela conferidas a cada 5 s.
- "Tentar de novo" também num turno com falha ou interrompido aberto do histórico.

**Out:**
- Continuar uma pesquisa interrompida do ponto em que parou (o "Tentar de novo" pergunta de novo).
- Mais de um processo da API (os turnos em andamento ficam na memória do processo).
- Gravar o texto parcial durante o turno (se o servidor cair no meio, a pergunta fica "interrompida" sem o texto parcial).

## Business rules
- BR-1: nenhuma pergunta enviada fica fora do histórico, e nada é apagado (100% do histórico, KBC-005 BR-1).
- BR-2: um turno pendente que o servidor não roda mais (de antes de o servidor iniciar, parado há mais de 2 min sem rodar) ou mais velho que o teto do turno (60 min) é lido como "interrompida"; a leitura não grava.
- BR-3: um retrato da conversa enviado pela página nunca troca um turno terminado por um pendente, nem apaga turnos que o servidor gravou (mescla por id do turno).
- BR-4: cada pessoa só vê, acompanha e para os próprios turnos e conversas (KBC-010 BR-6).
- BR-5: uma conversa roda um turno por vez; perguntar de novo na mesma conversa para o anterior.

## Functional requirements
- FR-1: contrato: `savedResearchTurnSchema` + `id?`, `status?: pending | failed`, `error?`; `conversationSummarySchema` + `status?: pending | interrupted | failed`; `researchRequestSchema` + `conversationId?` e `turnId?` (os dois ou nenhum). Tudo opcional: arquivos antigos abrem sem migração.
- FR-2: `POST /api/v1/topics/:topic/research` com os ids grava o turno pendente (conversa nova com título = pergunta), roda o turno desligado da conexão e grava o resultado; sem os ids, o comportamento de antes.
- FR-3: `GET /api/v1/research/turns/:turnId/events` (SSE do começo, depois ao vivo; 404 se não roda) e `POST /api/v1/research/turns/:turnId/stop` (204, idempotente).
- FR-4: `GET /api/v1/conversations[/:id]` lê turnos pendentes mortos como interrompidos; `PUT` mescla turnos por id.
- FR-5: web: grava a conversa no envio; reata o stream que caiu; retoma a conversa da aba depois de recarregar; "Parar" chama a rota de parada; "+ Nova conversa" e abrir outra conversa não param a pesquisa.
- FR-6: lateral: "pesquisando…", "interrompida", "falhou" na linha da conversa; consulta a cada 5 s das pendentes.
- FR-7: `RESEARCH_RATE_LIMIT` (padrão 20 por minuto) configura o limite de pesquisas por cliente.

## Non-functional requirements
- NFR-1: WCAG 2.2 AA na lateral em 1440 e 390 px (estado em texto, spinner `aria-hidden` e parado com `prefers-reduced-motion`; axe sem violações sérias).
- NFR-2: o servidor nunca deixa um turno sem teto: 60 min, depois para e grava como interrompido.
- NFR-3: ao desligar, a API para os turnos em andamento e espera até 5 s para gravá-los como interrompidos.

## Acceptance criteria
- **AC-1 (FR-2, FR-5, FR-6)**
  - Given uma conversa nova (busca ou pesquisa com IA)
  - When a pessoa envia a primeira pergunta
  - Then a conversa está gravada no servidor e aparece no topo do histórico, selecionada, com "pesquisando…" enquanto a busca ou a pesquisa roda
- **AC-2 (FR-2, FR-3, FR-5)**
  - Given uma pesquisa com IA em andamento (primeira pergunta ou seguinte)
  - When a pessoa recarrega a página
  - Then a conversa volta com a pergunta em andamento e mostra a resposta final quando o turno termina
- **AC-3 (FR-3, FR-4, BR-2)**
  - Given uma pesquisa com IA
  - When ela falha, é parada ("Parar"), a aba fecha ou o servidor reinicia no meio
  - Then a pergunta continua no histórico como "falhou" ou "interrompida" (ou com a resposta, se a aba fechou e o turno terminou), com "Tentar de novo"; nunca com spinner para sempre
- **AC-4 (FR-1, FR-4, BR-1, BR-3)**
  - Given conversas gravadas antes deste item, e um retrato antigo da página
  - When são lidas ou o retrato é enviado
  - Then abrem como antes, e nenhum turno gravado pelo servidor se perde
- **AC-5 (FR-2, FR-3, BR-4)**
  - Given duas pessoas
  - When uma tenta acompanhar, parar ou gravar um turno na conversa da outra
  - Then recebe 404 (ou nada acontece), e cada provedor grava o turno pelo mesmo caminho da rota

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | unitário web (`research-store.spec.ts`, `chat-store.spec.ts`, `chat-page.spec.ts`) + integração (`recorded-research.integration.test.ts`) + E2E (`history-on-submit.spec.ts`) | 1440 e 390 px |
| AC-2 | integração (seguir depois de desconectar) + unitário web (retomar, reatar) + E2E (recarregar) | stub `[lento]` |
| AC-3 | unitário (`live-turns.test.ts`, `turn-record.test.ts`, `conversations-service.test.ts`) + integração (parar, falha, reinício) + E2E (parar, falha) | stub `[falha]` |
| AC-4 | contrato (`conversations.test.ts`) + `conversations-service.test.ts` (mescla) | — |
| AC-5 | integração (outra pessoa: 404) + `live-turns.test.ts` | — |

## References
Telas: `docs/design/screens.md` (T4 estados, T5 lateral) · Arquitetura: `docs/architecture/overview.md` (conversations, contratos) · ADR 0006, 0009, 0013, 0014 (o turno e o "Parar").

## Open questions
Nenhuma. Premissas: a pesquisa continua quando a página sai (só "Parar" para); recarregar retoma do começo; turnos em andamento na memória de um único processo da API.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
