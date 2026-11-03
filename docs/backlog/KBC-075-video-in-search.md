---
id: KBC-075
title: "Vídeo na busca: \"Buscar em\" com vídeos e referências que abrem o vídeo no ponto"
status: ready
slice: later-video
outcome: quem estuda acha uma ideia dita numa palestra em vídeo no minuto exato, pela mesma caixa de busca
depends_on: [KBC-039, KBC-074]
---

# KBC-075 — Vídeo na busca: "Buscar em" com vídeos e referências que abrem o vídeo no ponto

## Story
Como quem estuda, quero que a busca também procure na fala dos vídeos e abra o vídeo no ponto exato.

Parte de vídeo tirada do KBC-039 (decisão do dono, 2026-11-03).

## Scope
**In:** o tipo "Vídeos" no controle "Buscar em" (com contagem); `kinds` aceita `video`; trechos de vídeo nas referências com o ícone ▶ e "Vídeo" em texto; clicar abre o player de vídeo no ponto.
**Out:** busca por imagem ou por texto que aparece na tela.

## Business rules
- BR-1: o alcance padrão passa a incluir vídeos quando o acervo tem vídeos; um tipo que o acervo não tem fica desabilitado.

## Functional requirements
- FR-1: A API deve aceitar `kinds: ['video']` e devolver trechos de vídeo como os de áudio. (BR-1)
- FR-2: As referências de vídeo devem abrir o player de vídeo no minuto, com o segmento destacado na transcrição.

## Non-functional requirements
- NFR-1: a busca com vídeos mantém o p95 do KBC-039.

## Acceptance criteria
- **AC-1** (FR-1): Given um vídeo transcrito que diz "burracheira", When a pessoa busca "burracheira" com "Vídeos" marcado, Then o trecho aparece com ▶ e o minuto.
- **AC-2** (FR-2): Given esse resultado, When a pessoa clica, Then o vídeo abre e toca do ponto.
- **AC-3** (BR-1, negativo): Given um acervo sem vídeos, When abre a busca, Then "Vídeos" fica desabilitado com o motivo em texto.

## Test strategy
| AC | Nível |
|---|---|
| AC-1, AC-3 | integração |
| AC-2 | E2E |

## References
KBC-039 (parte de áudio) · ADR 0024

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal
