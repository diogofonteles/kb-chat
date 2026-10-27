---
id: KBC-030
title: Exaustivo garantido — o aplicativo varre o conjunto inteiro em lotes e mede a cobertura (todos os provedores)
status: in-review
slice: release-1
outcome: no Exaustivo, toda pergunta varre o conjunto planejado inteiro (ou diz exatamente o que faltou e retoma de onde parou), e a cobertura mostrada é medida pelo aplicativo, nunca escrita pelo modelo
depends_on: [KBC-017, KBC-018, KBC-020, KBC-022, KBC-024, KBC-027]
---

# KBC-030 — Exaustivo garantido

## Story
Como dono do acervo, quero que a pesquisa Exaustiva leia de verdade todos os documentos do conjunto que pedi, com qualquer modelo (gratuito, chave própria ou assinatura), e que a linha de cobertura diga a verdade, para confiar numa lista "completa" sem conferir à mão.

Evidência (produção, 2026-10-27): no Exaustivo, com `nvidia/nemotron-3-ultra-550b-a55b:free` pela OpenRouter da própria pessoa, a pergunta "pesquise em todos os temas de autoria de José Laercio do Egito, quais os livros que ele cita como positivos ou tem como referência e liste-os" levou ~550 s e 88 passos, paginou 2.555 documentos de autoria, leu 38 e respondeu "**Cobertura:** varri 2.555 documentos…" — falso. Causas: o modelo decidia quando a cobertura estava completa, e a linha de cobertura era escrita pelo modelo. Decisão do dono: no Exaustivo o aplicativo garante a varredura, para todo provedor (ADR 0021).

## Scope
**In:**
- Planejamento: o orquestrador ganha `plan_sweep` (conjunto por autoria, entidade, origem ou assuntos, ou o acervo inteiro; expressões; o que extrair) e até 12 passos; sem plano (respondeu cedo ou acabaram os passos), vale o plano padrão (autoria do Mestre quando a pergunta cita Laércio/o Mestre, senão o acervo inteiro; leitura inteira; a pergunta como extração).
- Varredura pelo aplicativo: conjunto resolvido em ordem de id; com expressões, varredura por padrão de todos e leitura só das janelas em volta das ocorrências; sem expressões, leitura inteira em janelas; lotes do tamanho do contexto do modelo; cada lote é uma chamada sem ferramentas que devolve achados `- [Dk] … — “trecho”`; achados juntados, sem repetição, com o [n] compartilhado; resposta final pedida só no fim.
- Tetos que param a varredura com cursor: tempo (30 min), pedidos por turno (`KB_CHAT_SWEEP_MAX_REQUESTS`, padrão 250) e os pedidos gratuitos que restam à casa (no máximo um quarto do limite diário da casa por varredura), gasto do dia (a resposta final fica reservada), provedor recusando (espera 15/30/60 s), "Parar".
- Ritmo de modelo gratuito: um pedido a cada 3,2 s (20/min da OpenRouter); a cadeia de modelos da pessoa continua valendo em cada pedido.
- Cobertura medida pelo aplicativo no `done` e no turno salvo; o prompt proíbe números de cobertura e o aplicativo retira qualquer linha "Cobertura" do modelo.
- "Continuar varredura": o cursor (plano, último documento feito, totais) vai com o turno e com cada progresso; o botão no último turno (também reaberto do histórico) varre só o que faltou.
- Estimativa antes do primeiro lote e progresso "Lote 12 de 80 · 640 de 2.555 documentos".
- Mesma máquina nos três caminhos: laço por token (OpenRouter, Gemini, chaves de API, plano da casa), Claude Code e Codex no sandbox (um processo por lote; Codex um por vez).

**Out:**
- Rápido e Profundo (sem mudança).
- Confirmação obrigatória antes de varrer (a estimativa aparece e "Parar" interrompe).
- Sub-pesquisadores (`delegate`, agente "pesquisador" do Claude Code): substituídos pela varredura (ADR 0021).

## Business rules
- BR-1: no Exaustivo, a resposta final só é pedida depois de todos os lotes planejados ou de um teto; nunca porque o modelo quis parar.
- BR-2: a cobertura mostrada é a medida pelo aplicativo; nenhuma linha "Cobertura" do modelo chega ao leitor.
- BR-3: os números [n] dos achados são os mesmos das fontes e da resposta.
- BR-4: uma varredura nunca passa dos tetos de pedidos, tempo e gasto; ao parar, diz quantos documentos faltaram e por quê.
- BR-5: o cursor só retoma o que faltou; o que já foi varrido não é varrido de novo.
- BR-6: os três caminhos de provedor usam a mesma varredura; o sandbox do Codex não muda.

## Functional requirements
- FR-1: `plan_sweep` só no Exaustivo; plano padrão sem `plan_sweep`. (BR-1)
- FR-2: `SweepPlanner` resolve o conjunto e os lotes (janelas ±1.500 caracteres com expressões; leitura inteira sem). (BR-1)
- FR-3: `SweepCoordinator` roda os lotes com concorrência limitada, ritmo, espera, tetos e "Parar"; emite `sweep` (planned/running). (BR-4)
- FR-4: `done` traz `coverage` e, se faltou algo, `sweep` (cursor); o turno salvo guarda os dois. (BR-2, BR-5)
- FR-5: o pedido aceita `sweep` (só com `profile: exhaustive`); a varredura começa depois do cursor. (BR-5)
- FR-6: Claude Code e Codex: planejamento por MCP com `plan_sweep`, um processo por lote sem ferramentas, a resposta por mais um processo. (BR-6)
- FR-7: web: quadro de estimativa e progresso, linha de cobertura, "Varredura incompleta" com motivo, "Continuar varredura", resumo "varreu X de Y documentos". (BR-2, BR-4)

## Non-functional requirements
- NFR-1: no vault real, resolver o conjunto do Mestre (2.555 documentos) e o plano de lotes leva ≤ 5 s.
- NFR-2: modelo gratuito: ≤ 20 inícios de pedido por minuto por turno.
- NFR-3: WCAG 2.2 AA no quadro de progresso, na cobertura e no botão, em 1440 e 390 px, sem rolagem lateral.

## Acceptance criteria
- **AC-1 (FR-1, BR-1)** Given um modelo "preguiçoso" que responde de cara · When pergunto no Exaustivo · Then o texto dele é retirado, o plano padrão varre todos os documentos do conjunto e a resposta vem depois do último lote.
- **AC-2 (FR-4, BR-2)** Given um modelo que escreve "Cobertura: varri 2.555 documentos" · When a resposta chega · Then nenhuma linha "Cobertura" dele aparece, e a cobertura mostrada é a medida.
- **AC-3 (FR-2, BR-3)** Given `plan_sweep` com expressões · When a varredura roda · Then todos os documentos do conjunto são varridos por padrão, só os com ocorrência são lidos, e os achados citam [n] válidos sem repetição.
- **AC-4 (FR-3, FR-5, BR-4, BR-5)** Given um teto de pedidos, de tempo, de gasto ou o provedor recusando · When ele é atingido · Then a varredura para, a cobertura diz quantos faltaram e por quê, a resposta parcial vem (exceto em "Parar"), e "Continuar varredura" varre só o resto.
- **AC-5 (FR-6, BR-6)** Given a assinatura do Claude ou do ChatGPT · When pergunto no Exaustivo · Then o CLI planeja por MCP com `plan_sweep`, cada lote é um processo sem ferramentas (Codex com os mesmos argumentos travados), e a cobertura vem do aplicativo.
- **AC-6 (FR-3, NFR-2)** Given um modelo gratuito · When a varredura roda · Then os pedidos começam a cada 3,2 s, esperam 15/30/60 s depois de recusas, e "Parar" impede qualquer pedido novo.
- **AC-7 (FR-7, NFR-3)** Given um Exaustivo em andamento e depois terminado ou incompleto · When olho a tela em 1440 e 390 px · Then vejo a estimativa, "Lote N de M", a cobertura, o motivo do que faltou e "Continuar varredura", sem violação séria de axe.
- **AC-8** Given Rápido ou Profundo · When pergunto · Then nada muda (sem `plan_sweep`, sem varredura).
- **AC-9 (NFR-1)** Given o vault real · When meço sem modelo · Then registro conjunto, lotes e pedidos estimados para a pergunta do dono.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2, AC-4, AC-8 | unitário (`sweep-runner.test.ts`, `tool-loop-runner.test.ts`) | modelo falso (preguiçoso, cobertura falsa, tetos, Parar) sobre o vault de fixture |
| AC-3, AC-4, AC-6 | unitário (`sweep-planner.test.ts`, `sweep-coordinator.test.ts`, `findings.test.ts`, `coverage-filter.test.ts`) | relógio falso para ritmo e espera |
| AC-5 | integração (`cli-runners.test.ts`) | Claude Code e Codex falsos; nenhum CLI real |
| AC-7 | componente (`research-message.spec`, `research-store.spec`) + E2E (`research.spec.ts`) | stub com `[varredura lenta]`; turno incompleto semeado pela API de conversas |
| AC-9 | medição | `work/KBC-030/evidence/real-vault.md` |

## References
ADR: `docs/adr/0021-app-driven-exhaustive-sweep.md` (emenda 0013, substitui 0014 no Exaustivo) · Telas: `docs/design/screens.md` (T1, Exaustivo)

## Follow-ups (from the reviews of 2026-10-27)
- Reserva de gasto por pessoa entre turnos (ou um Exaustivo por pessoa de cada vez) — ADR 0021, riscos aceitos.
- Com o KBC-029: retomar do cursor guardado no servidor pelo id do turno, e o turno gravado no servidor montar o cursor com os `found` do progresso (obrigação na ADR 0021).
- Operação: uma linha de log por varredura (lotes, pedidos, motivo, duração) e o motivo no log de uso.
- Nota: o limite de pesquisas por minuto por cliente virou configurável (`RESEARCH_RATE_LIMIT`, padrão 20, o valor de antes); o servidor de E2E usa 10000.

## Open questions
Nenhuma. Premissas registradas: 12 passos de planejamento, 250 pedidos por turno, 3 lotes em paralelo (Codex 1), lote = metade do contexto, janelas de ±1.500 caracteres.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
