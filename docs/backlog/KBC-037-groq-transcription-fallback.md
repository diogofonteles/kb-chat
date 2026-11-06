---
id: KBC-037
title: "Groq como reserva da transcrição: chave na tela, nunca ligado por padrão, cortes com a lista de termos e teto mensal de gasto"
status: ready
slice: phase-2-a
outcome: o acervo não fica parado quando o Mac do dono está desligado, sem passar do teto mensal de US$ 10
depends_on: [KBC-036]
---

# KBC-037 — Groq como reserva da transcrição

## Story
Como master, quero mandar para o Groq as transcrições que esperam o Mac há muito tempo, para o acervo não parar, com o gasto sob um teto.

## Scope
**In:** conectar o Groq na tela (chave colada e cifrada, "Testar conexão"); escolher o modo: "Nunca" (padrão), "Só quando eu pedir", "Quando o Mac estiver parado há mais de N horas"; "Transcrever com Groq" num item; o adaptador no `media-worker` (cortes VAD ≤ 28 s com a lista de termos em cada pedido); ritmo do plano gratuito; razão de gasto mensal da mídia com teto (padrão US$ 10).
**Out:** outros provedores; transcrever no Groq por padrão.

## Business rules
- BR-1: o Groq nunca é usado sem um master ligá-lo; o padrão é "Nunca".
- BR-2: o gasto de mídia tem teto mensal, padrão US$ 10, editável pelo dono; cada pedido reserva o seu custo (US$ 0,04/h, mínimo de 10 s cobrados) antes de sair, e nada sai se passar do teto.
- BR-3: a chave do Groq é cifrada em repouso e nunca volta à tela nem aos logs (ADR 0017).

## Functional requirements
- FR-1: Quando o master cola a chave e clica "Testar conexão", o sistema deve chamar a lista de modelos do Groq e mostrar "Conectado" ou o motivo. (BR-3)
- FR-2: No modo "Quando o Mac estiver parado há mais de N horas" (N padrão 12), trabalhos `transcribe` na fila há mais de N h, sem transcritor visto nesse tempo, devem ir para o adaptador Groq. (BR-1)
- FR-3: O adaptador deve enviar os cortes do VAD com a lista de termos em cada pedido, respeitar 20 pedidos/min, 7.200 s/h e 28.800 s/dia no plano gratuito, esperar o `retry-after` num 429 e guardar o resultado bruto como o transcritor do Mac.
- FR-4: Antes de cada pedido, o sistema deve reservar o custo no teto mensal; se não couber, o trabalho volta a "Aguardando o transcritor" com "Teto mensal de mídia atingido". (BR-2)
- FR-5: A tela deve mostrar o gasto do mês com mídia e o teto.

## Non-functional requirements
- NFR-1: o gasto registrado num mês de teste bate com o painel do Groq com diferença ≤ 5 %.

## Acceptance criteria
- **AC-1** (BR-1): Given o Groq conectado e o modo "Nunca", When o Mac fica parado 48 h, Then nenhum pedido vai ao Groq.
- **AC-2** (FR-2): Given o modo "parado há mais de 12 h" e um trabalho na fila há 13 h sem transcritor visto, When o agendador roda, Then o trabalho é transcrito pelo Groq e marcado "Transcrita pelo Groq" (concorda com "Transcrita", o rótulo da transcrição já existente).
- **AC-3** (FR-4, BR-2): Given US$ 9,99 gastos de US$ 10, When um trabalho de 1 h iria ao Groq, Then nada é enviado e a mídia mostra "Teto mensal de mídia atingido".
- **AC-4** (FR-3): Given um 429 com `retry-after: 30`, When o adaptador recebe, Then espera 30 s e repete sem perder o trabalho.
- **AC-5** (FR-1, BR-3): Given uma chave inválida, When "Testar conexão", Then "A chave não foi aceita pelo Groq"; e a chave nunca aparece em resposta ou log.
- **AC-6** (FR-3): Given uma faixa do piloto com "Hoasca", When transcrita pelo Groq com os termos em cada corte, Then o termo sai com a grafia da lista (teste com o servidor falso que verifica o `prompt` de cada pedido).
- **AC-7**: tela de conexão e modos em 1440 px e 390 px, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-3 | integração | Groq falso; relógio falso |
| AC-4, AC-6 | unitário (adaptador) | Servidor falso |
| AC-5 | integração | Varredura do log pela chave |
| AC-7 | E2E | |
| NFR-1 | manual | Um mês de uso real, se ligado |

## References
ADR: [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) (item 7), [0022](../adr/0022-media-library-store-queue-and-streaming.md) (gasto) · Groq: console.groq.com/docs/speech-to-text e /rate-limits (conferidos em 2026-10-27)

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-036); no open questions
- [x] Fits one goal
