---
id: KBC-036
title: "Transcrição no Mac do dono: transcritor pareado pela tela, VAD e lista de termos, JSON bruto guardado, filtro de repetições e marca de baixa confiança"
status: ready
slice: phase-2-a
outcome: todo áudio enviado ganha transcrição com tempo por palavra, sem custo, com erro de palavras ≤ 10 % em gravações limpas
depends_on: [KBC-034]
---

# KBC-036 — Transcrição no Mac do dono

## Story
Como dono, quero que meu Mac transcreva sozinho os áudios enviados, para ter o texto com tempo de cada palavra sem pagar e com a qualidade medida no piloto.

## Scope
**In:** pareamento de um transcritor na tela ("Transcritores": nome, token mostrado uma vez, revogar, visto pela última vez); rotas do worker (reservar, sinal de vida, baixar o FLAC 16 kHz, enviar o resultado, falhar); o programa `tools/transcriber/` (Python com uv, mlx-whisper turbo, Silero VAD, parâmetros do piloto, plist do launchd); JSON bruto guardado; derivação de segmentos e palavras na API; filtro pós-transcrição; confiança `normal | low`; status na tela.
**Out:** Groq (KBC-037); edição da lista de termos na tela (KBC-040: aqui a lista inicial de 32 termos vem de uma migração); legendas e transcrição clicável (KBC-038).

## Business rules
- BR-1: só masters pareiam ou revogam transcritores; o token é mostrado uma única vez.
- BR-2: o token de um transcritor só alcança as rotas do worker e só o áudio dos trabalhos que ele reservou.
- BR-3: a transcrição bruta nunca é apagada; uma nova transcrição cria uma nova versão, e a mais nova é a atual.
- BR-4: faixas com menos de 40 % de fala detectada pelo VAD são transcritas inteiras, sem VAD (chamadas cantadas).
- BR-5: uma transcrição de baixa confiança continua pesquisável e tocável, sempre com o aviso "Transcrição automática de baixa confiança" (decisão do dono, 2026-10-28).

## Functional requirements
- FR-1: Quando uma mídia fica "Pronta", o sistema deve criar um trabalho `transcribe`; a mídia mostra "Aguardando o transcritor" e, se nenhum transcritor foi visto na última hora, "O transcritor está desligado desde <data>".
- FR-2: O transcritor deve reservar trabalhos `transcribe`, baixar o FLAC, transcrever com os parâmetros da ADR 0023 (VAD, cortes ≤ 28 s, termos em cada corte, temperaturas com recuo, sem VAD quando a fala < 40 %) e enviar o resultado bruto com a versão da lista de termos e dos parâmetros. (BR-4)
- FR-3: Ao receber o resultado, a API deve guardar o JSON bruto, derivar segmentos e palavras, aplicar o filtro (frases bloqueadas, laços de caracteres, n-gramas de 1 a 12 palavras repetidos 3 ou mais vezes seguidas) e calcular a confiança. (BR-3)
- FR-4: A confiança deve ser `low` quando > 30 % das palavras estão em segmentos com `avg_logprob < −1,0` ou `compression_ratio > 2,4`, ou quando o filtro removeu > 10 % das palavras; os limiares são calibrados no piloto e registrados na spec. (BR-5)
- FR-5: A tela "Transcritores" deve parear (nome → token uma vez, com o comando para colar no Mac), listar (nome, visto por último, trabalho atual) e revogar. (BR-1)
- FR-6: Uma requisição de worker com token revogado ou inválido deve receber 401; um token válido pedindo o áudio de um trabalho que não reservou, 404. (BR-2)

## Non-functional requirements
- NFR-1: erro de palavras ≤ 10 % nos trechos 1 e 2 do piloto (`docs/research/2026-10-28-transcription-pilot.md`), medido com o `wer.py` do piloto sobre a saída do transcritor (referências do dono).
- NFR-2: velocidade no Mac ocioso ≥ 12× tempo real (piloto: 17×).
- NFR-3: nenhum laço de 3 ou mais repetições seguidas de até 12 palavras nas 111 faixas do piloto após o filtro.

## Acceptance criteria
- **AC-1** (FR-1, FR-2, FR-3): Given um transcritor pareado e ligado, When um áudio fica pronto, Then em seguida a mídia passa por "Transcrevendo" a "Transcrita" e o JSON bruto, os segmentos e as palavras existem.
- **AC-2** (FR-1): Given nenhum transcritor visto há 2 h, When um áudio fica pronto, Then a mídia mostra "Aguardando o transcritor · desligado desde <data e hora>".
- **AC-3** (BR-4): Given uma faixa só de chamada cantada (fala < 40 % no VAD), When é transcrita, Then o resultado não sai vazio e registra `vad: skipped`.
- **AC-4** (FR-3, NFR-3): Given o resultado bruto do piloto com o laço "im offro um todo de tempo elingue", When a API deriva, Then o laço aparece uma vez só.
- **AC-5** (FR-4, BR-5): Given as faixas do trecho ruidoso do piloto, When derivadas, Then a confiança é `low` e a mídia mostra "Transcrição automática de baixa confiança"; Given as faixas dos trechos 1 e 2, Then `normal`.
- **AC-6** (FR-6, BR-2): Given um token revogado, When o transcritor tenta reservar, Then 401 e o Mac registra "Token revogado; pareie de novo." Given um token válido, When pede o áudio de um trabalho de outro, Then 404.
- **AC-7** (BR-1, FR-5): Given um member, When abre "Transcritores", Then não vê a tela (403 na API).
- **AC-8** (FR-2): Given o Mac desligado no meio de um trabalho, When a reserva vence, Then o trabalho volta à fila e outro transcritor (ou o mesmo, ao religar) o conclui uma vez só.
- **AC-9** (BR-3): Given uma mídia transcrita, When é transcrita de novo, Then existem 2 versões e a atual é a mais nova.
- **AC-10**: telas de status e "Transcritores" em 1440 px e 390 px, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-8 | integração (API + worker falso) + 1 teste manual com o Mac | O worker falso devolve o JSON bruto do piloto |
| AC-2, AC-7, AC-10 | E2E | |
| AC-3 | pytest no `tools/transcriber` com VAD real e uma faixa curta cantada (fixture) | |
| AC-4, AC-5 | unitário na API | Fixtures do piloto (`out/*/raw`) reduzidas |
| AC-6 | integração | |
| AC-9 | integração | |
| NFR-1 | manual na validação local | `wer.py` do piloto |

## References
ADR: [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md), [0022](../adr/0022-media-library-store-queue-and-streaming.md) · Piloto: [`docs/research/2026-10-28-transcription-pilot.md`](../research/2026-10-28-transcription-pilot.md) · Plano da fase 2 v3 (A4)

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-034); no open questions
- [x] Fits one goal
