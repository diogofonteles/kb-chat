---
id: KBC-151
title: "Quem fala na fonte de áudio da Pesquisa com IA para quem só ouve"
status: draft
slice: ui-v2-areas
outcome: quem abre uma citação de áudio vê, no trecho citado e nas falas em volta, quem está falando, com a cor da voz
depends_on: [KBC-150]
---

# KBC-151 — Quem fala na fonte de áudio

Pendência registrada no KBC-150 (redesign da fonte de áudio, 2026-11-17).

## Story
Como estudante que pesquisa com IA, quando abro a citação de uma entrevista, quero ver quem fala no trecho citado e nas falas em volta, para saber se a frase é do entrevistado ou de quem pergunta.

## Contexto
O desenho v2 ("v2 · Pesquisa com IA — fonte de áudio") mostra, no cartão do trecho e em cada fala de "Em volta do trecho", o nome de quem fala com a cor da voz ("● Irmã Helena Prado", "● Voz 2 · entrevistador"). O KBC-150 já mostra isso quando a transcrição traz as vozes. Hoje a API (`GET /api/v1/media/:id/transcript`) só entrega `segments[].voice` e `voiceNames` para quem tem `media-edit` (a separação inteira, KBC-064) ou `media-speakers` (só quem fala, KBC-065 FR-4). Quem tem só `media` e `media-research` recebe os segmentos sem voz, e o painel omite a linha de quem fala.

## Scope
**In:**
- decidir se quem pode ver a faixa na pesquisa vê também quem fala nela (os nomes já confirmados; voz sem nome como "Falante não identificado");
- se sim, a API passa a entregar a voz de cada segmento e os nomes confirmados a esse público, sem a separação nem as impressões de voz (ADR 0032).

**Out:** nomes à espera de confirmação; as impressões de voz; mudar o painel (o KBC-150 já mostra quando os dados vêm).

## Business rules
- BR-1: só nomes confirmados aparecem para quem não edita (KBC-065 BR-3).
- BR-2: a impressão de voz e a separação nunca saem para quem não tem `media-edit` (ADR 0032).

## Functional requirements
- FR-1: a API deve incluir `voice` em cada segmento e `voiceNames` (só confirmados) para o público decidido. (BR-1, BR-2)

## Non-functional requirements
- NFR-1: a transcrição de 2 h segue em p95 ≤ o limite de hoje (KBC-038 NFR-2) com as vozes.

## Acceptance criteria
- AC-1 (FR-1, BR-1): Given uma entrevista com a voz 1 confirmada como "Irmã Helena Prado", When alguém com só `media` e `media-research` abre a citação, Then o cartão mostra "● Irmã Helena Prado" e a fala seguinte "Falante não identificado".
- AC-2 (BR-2, negativo): Given a mesma pessoa, When a transcrição chega, Then ela não traz `speakers` (a separação) nem nomes à espera de confirmação.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | integração + E2E | rota da transcrição; fonte de áudio em 1440 e 390 |
| AC-2 | integração | — |
| NFR-1 | medição | `media-search-latency` ou equivalente |

## References
KBC-150 (`work/KBC-150/spec.md`, pendências) · KBC-064, KBC-065 · ADR 0032 · `apps/api/src/modules/media/transcript-routes.ts`

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [ ] Dependencies done or scheduled; no open questions — **decisão do dono:** quem só ouve vê quem fala?
- [x] Fits one goal
