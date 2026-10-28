---
id: KBC-044
title: "Encurtar silêncios: pular as pausas longas da palestra e mostrar o tempo economizado"
status: ready
slice: phase-2-a
outcome: palestras com pausas longas ficam mais curtas de ouvir sem perder fala
depends_on: [KBC-041]
---

# KBC-044 — Encurtar silêncios

## Story
Como quem estuda palestras gravadas ao vivo, quero que o player pule as pausas longas, para ouvir mais conteúdo no mesmo tempo.

## Scope
**In:** etapa `silences` no media-worker depois da conversão (ffmpeg `silencedetect`), mapa de silêncios por cópia no banco, job de preenchimento para as mídias já convertidas; opção "Encurtar silêncios" no menu ⋯ (desligada por padrão, lembrada na conta); pulo das pausas durante a reprodução; "Tempo economizado nesta mídia: 3:12".
**Out:** normalizar o volume; acelerar a fala.

## Business rules
- BR-1: só pausas de 1,0 s ou mais são encurtadas; cada uma passa a durar 0,3 s (o player pula do início + 0,15 s até o fim − 0,15 s).
- BR-2: com a opção desligada, nada muda: o mapa existe, mas não é usado.
- BR-3: um pulo pedido pela pessoa (barra, botões, trecho, marcador, `?t=`) que cai dentro de uma pausa é respeitado; o encurtamento volta a agir na próxima pausa.

## Functional requirements
- FR-1: Depois de converter, o worker deve rodar `silencedetect` (−35 dB, 1,0 s) na cópia e enviar os intervalos à API, que os grava em `media_silences`; uma falha nessa etapa não falha a mídia (ela fica pronta sem o mapa e o job tenta de novo). (BR-1)
- FR-2: Um job de preenchimento deve gerar o mapa das mídias prontas que não o têm, um por vez, no worker.
- FR-3: `GET /api/v1/media/{id}` deve devolver os intervalos (ms) com as regras de acesso do stream.
- FR-4: Com a opção ligada, ao entrar num intervalo da BR-1, o player deve pular para o fim − 0,15 s, sem som de corte perceptível (no máximo um pulo por intervalo), e somar o tempo pulado ao "Tempo economizado". (BR-1, BR-3)
- FR-5: A barra de progresso, os tempos, a posição salva, os marcadores e a transcrição continuam no tempo original da mídia.

## Non-functional requirements
- NFR-1: a etapa leva ≤ 30 s por hora de áudio na VM (piloto: 18 s) e não derruba o site (medida do KBC-034 NFR-1).
- NFR-2: o pulo acontece em até 150 ms depois do início da pausa (medido no E2E com áudio de silêncios conhecidos).

## Acceptance criteria
- **AC-1** (FR-1): Given um áudio de teste com pausas de 0,5 s, 1,2 s e 3 s, When a conversão termina, Then o mapa tem só as pausas de 1,2 s e 3 s (±100 ms).
- **AC-2** (FR-4, BR-1): Given a opção ligada, When a reprodução chega à pausa de 3 s, Then o player pula para o fim dela − 0,15 s e o "Tempo economizado" mostra cerca de 0:03.
- **AC-3** (BR-2): Given a opção desligada, When a reprodução passa pelas pausas, Then nenhum pulo acontece.
- **AC-4** (BR-3): Given a opção ligada, When a pessoa clica num trecho da transcrição que começa dentro de uma pausa, Then o player toca dali sem pular de volta.
- **AC-5** (FR-1): Given `silencedetect` falhando, When a conversão termina, Then a mídia fica "Pronta", o mapa fica pendente e o job tenta de novo.
- **AC-6** (FR-2): Given 3 mídias antigas sem mapa, When o job de preenchimento roda, Then as 3 ganham o mapa, uma por vez.
- **AC-7** (FR-5): Given a opção ligada e 2 min economizados, When a pessoa pausa em 20:00 pela barra, Then a posição salva e a barra mostram 20:00 do tempo original.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-5, AC-6 | integração (worker real com ffmpeg) | Áudio gerado com pausas de duração conhecida |
| AC-2, AC-3, AC-4, AC-7 | unitário (agendador de pulos com relógio falso) + E2E | |
| NFR-1 | medição na VM (staging no Mac antes) | 1 h de áudio |
| NFR-2 | E2E | Amostra `currentTime` a cada 20 ms |

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
