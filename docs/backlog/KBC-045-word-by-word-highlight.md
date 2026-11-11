---
id: KBC-045
title: "Destaque palavra a palavra: a palavra falada destacada na transcrição e clicável"
status: ready
slice: phase-2-a
outcome: quem lê junto acompanha exatamente a palavra falada e volta a uma palavra com um clique
depends_on: [KBC-038]
---

# KBC-045 — Destaque palavra a palavra

## Story
Como quem estuda lendo junto, quero ver a palavra que está sendo dita e clicar numa palavra para ouvir dali, para não me perder no texto.

## Scope
**In:** destaque da palavra atual dentro do segmento ativo, a partir dos tempos das palavras (ADR 0023); clique numa palavra pula para ela; "Destacar palavra a palavra" no menu ⋯ (ligado por padrão, lembrado na conta); segmentos sem tempos por palavra caem no destaque por segmento.
**Out:** destaque palavra a palavra na legenda (a legenda continua por frase); karaokê com animação.

## Business rules
- BR-1: a palavra destacada é a última cujo início ≤ tempo atual, dentro do segmento ativo; entre palavras (silêncio), fica a anterior.
- BR-2: o destaque da palavra é um sublinhado grosso em cor de destaque **e** peso maior, nunca só cor (UP-20); com `prefers-reduced-motion`, sem transição. O peso é desenhado com `text-shadow`: `::highlight` não aceita `font-weight`, e peso real empurraria o texto a cada palavra. O WebKit não desenha sombra nem traço em `::highlight`: lá fica só o sublinhado grosso, que continua não sendo só cor.

## Functional requirements
- FR-1: `GET /api/v1/media/{id}/transcript/words?from=&count=` deve devolver as palavras de uma faixa de até 200 segmentos, com início e fim em ms (as filtradas pela ADR 0023 ficam de fora). `GET …/transcript` continua sem palavras, para nunca ler as 20 mil de uma palestra de 2 h; o painel pede 100 segmentos por vez, quando precisa (decisão do dono, 2026-11-04).
- FR-2: Durante a reprodução, a palavra atual deve ser achada por busca binária e atualizada por `requestAnimationFrame` só enquanto toca, com no máximo 1 escrita no DOM por troca de palavra. (BR-1)
- FR-3: Clicar numa palavra deve pular para o seu início e tocar (com a opção ligada ou desligada); pelo teclado, Enter no segmento continua pulando para o início do segmento (a palavra não é parada de Tab).
- FR-4: Com a opção desligada ou sem tempos de palavras, o destaque volta ao do segmento (KBC-038). (BR-2)

## Non-functional requirements
- NFR-1: a palavra destacada difere da falada em ≤ 120 ms (medido no E2E com tempos conhecidos).
- NFR-2: numa transcrição de 2 h (~20 mil palavras), o destaque não passa de 2 ms por quadro no notebook de referência (trace do Playwright).

## Acceptance criteria
- **AC-1** (FR-2, BR-1): Given um segmento "o que está em cima" com tempos conhecidos, When a reprodução está entre o início de "está" e o de "em", Then "está" está destacada.
- **AC-2** (FR-3): Given a transcrição aberta, When a pessoa clica em "cima", Then o áudio toca do início de "cima".
- **AC-3** (FR-4): Given a opção desligada, When a reprodução segue, Then só o segmento é destacado.
- **AC-4** (FR-4): Given um segmento sem tempos de palavras, When ele está ativo, Then o segmento é destacado inteiro, sem erro.
- **AC-5** (BR-2): Given os três temas, When uma palavra está destacada, Then o contraste passa 4,5:1 e o destaque tem sublinhado e peso, não só cor.
- **AC-6** (FR-3): Given só o teclado, When a pessoa navega pela transcrição, Then as palavras não são paradas de Tab.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-4 | unitário (busca de palavra) + E2E | Transcrição falsa com tempos conhecidos |
| AC-2, AC-3, AC-6 | componente + E2E | |
| AC-5 | E2E | axe e contraste nos três temas |
| NFR-1, NFR-2 | E2E com medição | Transcrição sintética de 2 h |

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
