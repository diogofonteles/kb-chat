---
id: KBC-040
title: "Lista de termos editável pelo dono (nomes, lugares, chamadas), aplicada às próximas transcrições, com \"Transcrever de novo\" por mídia"
status: ready
slice: phase-2-a
outcome: nomes próprios do acervo saem com a grafia certa sem mexer em código
depends_on: [KBC-036]
---

# KBC-040 — Lista de termos editável e "Transcrever de novo"

## Story
Como dono, quero manter a lista de nomes e termos que o transcritor deve reconhecer e retranscrever uma palestra, para corrigir grafias como "Tiuaco" sem pedir mudança de código.

## Scope
**In:** tela "Termos da transcrição" (masters): lista com adicionar, editar, remover e importar colando uma por linha; versão da lista; o transcritor busca a lista atual; "Transcrever de novo" numa mídia (cria nova versão, ADR 0023); a lista inicial com os 32 termos do piloto.
**Out:** listas diferentes por acervo (uma lista para tudo nesta fase); substituição automática de grafia depois da transcrição.

## Business rules
- BR-1: só masters editam a lista; cada mudança gera uma nova versão com data e autor.
- BR-2: a lista cabe no limite do prompt (224 tokens do Whisper); a tela recusa a mudança que passaria disso e mostra quanto sobra.
- BR-3: "Transcrever de novo" mantém a versão anterior (BR-3 do KBC-036) e só troca a atual quando a nova termina.

## Functional requirements
- FR-1: `GET /api/v1/media/terms` (masters e transcritores) deve devolver os termos e a versão; o transcritor deve usá-la e enviá-la com o resultado.
- FR-2: A tela deve permitir editar a lista, mostrar o uso do limite ("180 de 224") e recusar acima do limite. (BR-2)
- FR-3: "Transcrever de novo" deve criar um trabalho `transcribe` para a mídia; a mídia mostra "Retranscrevendo" e continua com o texto atual até a nova versão ficar pronta. (BR-3)
- FR-4: Cada transcrição deve mostrar, para masters, a versão da lista com que foi feita.

## Non-functional requirements
- Nenhum além dos globais.

## Acceptance criteria
- **AC-1** (FR-1, FR-2): Given a lista com 32 termos, When o master adiciona "Tiuaco" e salva, Then a versão sobe e o próximo trabalho do transcritor usa a lista nova.
- **AC-2** (FR-3, BR-3): Given uma palestra com "Tioaco" na transcrição, When o master clica "Transcrever de novo" depois de incluir "Tiuaco", Then o texto antigo continua visível até a nova versão ficar pronta, que traz "Tiuaco".
- **AC-3** (BR-2): Given a lista perto do limite, When o master cola termos que passariam de 224 tokens, Then a tela recusa com "A lista passou do limite do transcritor (231 de 224). Remova alguns termos."
- **AC-4** (BR-1): Given um member, When chama a rota de edição, Then 403.
- **AC-5** (FR-4): Given uma transcrição, When o master abre os detalhes, Then vê "Feita com a lista de termos v3 (28/10/2026)".
- **AC-6**: tela em 1440 px e 390 px, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2 | integração (worker falso) + E2E | |
| AC-3 | unitário (contagem de tokens) + componente | Tokenizador do Whisper (contagem em código) |
| AC-4, AC-5 | integração | |
| AC-6 | E2E | |

## References
ADR: [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) (itens 3 e 4) · Piloto: [`docs/research/2026-10-28-transcription-pilot.md`](../research/2026-10-28-transcription-pilot.md) (lista ampliada) · Plano da fase 2 v3 (A7)

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-036); no open questions
- [x] Fits one goal
