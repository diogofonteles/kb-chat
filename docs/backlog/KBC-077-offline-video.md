---
id: KBC-077
title: "Vídeo offline: baixar o vídeo em 720p ou só o áudio, e assistir sem rede"
status: ready
slice: later-video
outcome: quem estuda leva palestras em vídeo para ver sem internet, ou só o áudio delas para gastar menos espaço
depends_on: [KBC-056, KBC-074]
---

# KBC-077 — Vídeo offline: baixar o vídeo em 720p ou só o áudio, e assistir sem rede

## Story
Como quem estuda em viagem, quero baixar uma palestra em vídeo (ou só o áudio dela) e vê-la sem internet, com a legenda e a transcrição.

Parte de vídeo tirada do KBC-056 (decisão do dono, 2026-11-03).

## Scope
**In:** no menu ⤓ de um vídeo, **Vídeo (720p) · <tamanho>** e **Só o áudio · <tamanho>**; o vídeo baixado toca sem rede no player de vídeo; "Só o áudio" baixa a cópia de áudio e toca como áudio.
**Out:** escolher outras resoluções.

## Business rules
- BR-1: "Só o áudio" de um vídeo baixa a cópia de áudio (ADR 0022 §4) e toca como áudio, com a mesma legenda e transcrição.

## Functional requirements
- FR-1: O menu ⤓ de um vídeo deve oferecer as duas opções com os tamanhos. (BR-1)
- FR-2: Um vídeo baixado deve abrir sem rede no player de vídeo.

## Non-functional requirements
- NFR-1: no modo avião, um vídeo de 1 h baixado abre em ≤ 3 s e um pulo toca em ≤ 500 ms (E2E Chrome e WebKit).
- NFR-2: com 2 downloads de vídeo em andamento, o stream de outra conta mantém p95 do primeiro byte ≤ 300 ms (teste de carga no staging).

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given um vídeo de 10 min, When a pessoa escolhe **Só o áudio**, Then baixa só a cópia de áudio e, sem rede, ela toca como áudio, com a legenda.
- **AC-2** (FR-2): When escolhe **Vídeo (720p)**, Then, sem rede, o vídeo aparece no player.
- **AC-3** (negativo): Given pouco espaço livre, When pede o vídeo, Then o app avisa o tamanho e sugere "Só o áudio".

## Test strategy
| AC | Nível |
|---|---|
| AC-1, AC-2 | E2E offline (Chrome e WebKit) |
| AC-3 | unit + E2E |
| NFR-1, NFR-2 | E2E e carga no staging |

## References
KBC-056 (parte de áudio) · ADR 0026

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
