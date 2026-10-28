---
id: KBC-043
title: "Intervalos de pulo configuráveis: escolher quanto voltar e quanto avançar"
status: ready
slice: phase-2-a
outcome: cada pessoa pula no ritmo do seu estudo (voltar pouco para reouvir uma frase, avançar muito para passar um trecho)
depends_on: [KBC-041]
---

# KBC-043 — Intervalos de pulo configuráveis

## Story
Como quem estuda, quero escolher quantos segundos o player volta e avança, para reouvir uma frase sem voltar demais.

## Scope
**In:** "Pulos" no menu ⋯ com voltar (5, 10, 15, 30 s) e avançar (10, 15, 30, 45, 60 s); a preferência na conta; botões, atalhos J/L, mini-player e tela de bloqueio usando os valores escolhidos.
**Out:** pulo por frase (vai com o destaque palavra a palavra, KBC-045).

## Business rules
- BR-1: o padrão é voltar 15 s e avançar 30 s; a escolha vale para todas as mídias e aparelhos da pessoa.

## Functional requirements
- FR-1: `PUT /api/v1/media/preferences` deve aceitar `skipBackSec` ∈ {5, 10, 15, 30} e `skipForwardSec` ∈ {10, 15, 30, 45, 60}; outro valor responde 400 `VALIDATION_FAILED`. (BR-1)
- FR-2: Os botões devem mostrar o número escolhido no ícone e no nome acessível ("Voltar 10 segundos"); J, L, o mini-player e os manipuladores `seekbackward`/`seekforward` da Media Session devem usar os mesmos valores.
- FR-3: O menu "Pulos" deve usar grupos de rádios com rótulo ("Voltar", "Avançar") e aplicar na hora.

## Non-functional requirements
Nenhum além da definição de pronto e da barra de qualidade da fase 2.

## Acceptance criteria
- **AC-1** (FR-2, FR-3): Given a mídia em 1:00, When a pessoa escolhe voltar 5 s e aperta J, Then vai para 0:55, e o botão diz "Voltar 5 segundos".
- **AC-2** (FR-2): Given avançar 45 s, When o sistema envia `seekforward` sem `seekOffset`, Then a posição avança 45 s.
- **AC-3** (BR-1): Given a escolha feita no computador, When a pessoa abre o player no celular, Then os pulos são os mesmos.
- **AC-4** (FR-1): Given a API, When recebe `skipBackSec` 7, Then responde 400 e nada muda.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 | componente + E2E | |
| AC-2 | unitário (adaptador da Media Session) + E2E | |
| AC-3 | E2E | Dois contextos com a mesma conta |
| AC-4 | integração | |

## References
Tela: `docs/design/screens.md` T15 · ADR: [0025](../adr/0025-own-media-player-for-audio-and-video.md), [0022](../adr/0022-media-library-store-queue-and-streaming.md) · Benchmark: [`docs/research/2026-10-28-player-benchmark.md`](../research/2026-10-28-player-benchmark.md) · Barra de qualidade da fase 2: `docs/backlog/README.md`

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
