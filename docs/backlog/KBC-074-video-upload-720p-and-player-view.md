---
id: KBC-074
title: "Vídeo: envio, conversão para 720p e a visão de vídeo do player"
status: ready
slice: later-video
outcome: o dono envia palestras em vídeo e elas tocam como vídeo em 720p, com legenda sobre a imagem e todos os recursos do player de áudio
depends_on: [KBC-035, KBC-038]
---

# KBC-074 — Vídeo: envio, conversão para 720p e a visão de vídeo do player

## Story
Como pessoa com `media-upload`, quero enviar palestras em vídeo e assisti-las no app, com a mesma legenda, transcrição e recursos do player de áudio.

Parte de vídeo tirada do KBC-035 (decisão do dono, 2026-11-03: "todo que for de vídeos será para uma versão posterior").

## Scope
**In:** aceitar vídeo (mp4, mov, mkv, webm) no envio; o worker gera a cópia H.264 720p com faststart e a cópia de áudio (que segue para a transcrição); estimativa de cota de vídeo (400 MB/h); a visão de vídeo do player (ADR 0025): área com proporção reservada, pôster, tela cheia com F, picture-in-picture onde houver e a legenda sobre a imagem, sem mudar o `MediaEngine` nem os recursos (velocidade, retomar, marcadores, silêncios, timer, transcrição).
**Out:** vídeo na busca (KBC-075), na biblioteca (KBC-076) e offline (KBC-077); edição em faixas de vídeo.

## Business rules
- BR-1: um vídeo tem duas cópias: o vídeo 720p e o áudio; a transcrição usa o áudio.
- BR-2: a cota conta o vídeo pela estimativa de 400 MB/h antes de aceitar o envio.

## Functional requirements
- FR-1: O envio deve aceitar os formatos de vídeo e recusar os demais com a mensagem de formato.
- FR-2: O worker deve gerar a cópia 720p e a cópia de áudio dentro do limite de CPU do worker. (BR-1)
- FR-3: O player deve mostrar a visão de vídeo com a legenda sobre a imagem, tela cheia e picture-in-picture. (BR-1)
- FR-4: A API deve recusar com `MEDIA_QUOTA_EXCEEDED` o vídeo que passaria a cota pela estimativa. (BR-2)

## Non-functional requirements
- NFR-1: 1 h de vídeo converte em ≤ 1,5 h no worker (1 CPU) sem derrubar o site (mesma medida do KBC-034 NFR-1).

## Acceptance criteria
- **AC-1** (FR-2, BR-1): Given um mp4 de 2 min, When termina a conversão, Then ele toca como vídeo em 720p e a cópia de áudio existe para a transcrição.
- **AC-2** (FR-3): Given um vídeo com transcrição, When a legenda está ligada, Then ela aparece sobre a imagem e acompanha a fala; F alterna a tela cheia.
- **AC-3** (FR-4, BR-2): Given a cota quase cheia, When a pessoa envia um vídeo longo, Then recebe "Sem espaço" antes de enviar.
- **AC-4** (FR-1, negativo): Given um arquivo .avi corrompido, When enviado, Then a mídia falha com "Arquivo de vídeo inválido" e nada fica pela metade.
- **AC-5** (acessibilidade): o player de vídeo funciona só com teclado, sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível |
|---|---|
| AC-1, AC-4 | integração com vídeo real gerado por ffmpeg |
| AC-2, AC-5 | E2E (Chrome e WebKit) |
| AC-3 | integração |
| NFR-1 | medição no worker (staging) |

## References
KBC-035 (parte de áudio) · ADR 0022 §4, 0025 · KBC-038 (legendas)

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
