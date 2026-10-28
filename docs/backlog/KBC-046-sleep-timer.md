---
id: KBC-046
title: "Timer para dormir: parar sozinho depois de um tempo ou no fim da mídia, com o som diminuindo"
status: ready
slice: phase-2-a
outcome: quem ouve palestras antes de dormir não perde a posição nem deixa o áudio tocando a noite toda
depends_on: [KBC-041]
---

# KBC-046 — Timer para dormir

## Story
Como quem ouve palestras deitado, quero que o player pare sozinho depois de um tempo, para dormir sem perder onde parei.

## Scope
**In:** "Timer para dormir" no menu ⋯: 5, 10, 15, 30, 45 e 60 min e "No fim desta mídia"; o tempo restante visível no player e no mini-player; "Mais 5 minutos" e "Desligar timer"; o som diminui nos últimos 10 s; ao parar, a posição é salva.
**Out:** retomar sozinho de manhã; timer em minutos livres.

## Business rules
- BR-1: o timer conta tempo real de relógio, não tempo da mídia (vale igual em 2×), e para de contar enquanto a mídia está pausada.
- BR-2: o timer vale só para a sessão atual do navegador; fechar o player ou a página o desliga.
- BR-3: "No fim desta mídia" pausa no fim e não começa outra mídia.

## Functional requirements
- FR-1: Ao escolher um tempo, o player deve mostrar "Para em 14:59" (contagem regressiva) junto ao botão do timer e no mini-player, e anunciar "Timer para dormir: 15 minutos" uma vez. (BR-1)
- FR-2: Nos últimos 10 s, o volume deve descer até 0 em rampa (ou, onde o volume é só leitura, como no iPhone, pausar sem rampa); ao fim, pausar, restaurar o volume anterior, salvar a posição e anunciar "Pausado pelo timer".
- FR-3: "Mais 5 minutos" deve somar 5 min ao tempo restante; "Desligar timer" deve cancelar e restaurar o volume se a rampa já começou.
- FR-4: O timer deve continuar com a tela bloqueada e no mini-player, sem depender de `setInterval` em aba oculta (usar o tempo de relógio nos eventos `timeupdate` e um timeout de reserva). (BR-2)

## Non-functional requirements
- NFR-1: o player pausa em até 2 s depois do fim do timer, mesmo com a aba oculta (medido no E2E com relógio falso e `visibilityState` simulado).

## Acceptance criteria
- **AC-1** (FR-1, FR-2): Given o timer de 5 min, When passam 5 min tocando, Then o volume desce nos últimos 10 s, o player pausa, o volume volta ao anterior e a posição está salva.
- **AC-2** (BR-1): Given o timer de 5 min, When a pessoa pausa por 2 min no meio, Then o player para 7 min depois de ligado o timer.
- **AC-3** (FR-3): Given 30 s restantes, When a pessoa usa "Mais 5 minutos", Then o restante passa a 5:30 e a rampa, se começou, é desfeita.
- **AC-4** (BR-3): Given "No fim desta mídia", When a mídia termina, Then o player pausa no fim e nada mais toca.
- **AC-5** (FR-2): Given um navegador com volume só leitura, When o timer acaba, Then o player pausa sem rampa.
- **AC-6** (BR-2): Given um timer ligado, When a pessoa fecha o player, Then o timer some.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-3, AC-6 | unitário (serviço do timer com relógio falso) + E2E (`page.clock`) | |
| AC-4 | E2E | Áudio de 20 s |
| AC-5 | unitário + E2E (WebKit) | |
| NFR-1 | E2E | `page.clock` + aba oculta simulada |

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
