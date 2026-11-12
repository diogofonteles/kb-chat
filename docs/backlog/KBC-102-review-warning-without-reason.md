---
id: KBC-102
title: "O aviso \"Reveja\" da validação de faixas só aparece quando um título ainda diz um nome errado"
status: in-progress
slice: phase-2-editing
outcome: nenhum aviso "Reveja" sem um título na tela que diga um nome errado; meta 0 avisos nos cenários AC-1 a AC-4 e os avisos legítimos do KBC-090 mantidos (AC-5, AC-6)
depends_on: [KBC-090, KBC-066, KBC-072]
---

# KBC-102 — Aviso "Reveja" sem motivo na validação de faixas

Origem: fila do dono em `work/HANDOFF-2026-11-10.md` (checkout principal), 2026-11-12: "o aviso 'Reveja' aparece sem motivo na validação de faixas. Reproduzir antes de corrigir."

## Story
Como quem valida as faixas de uma gravação, quero que o aviso "Reveja" apareça só quando algum título ainda diz um nome errado, para confiar nele e não procurar um erro que não existe.

## Contexto (o que existe hoje)
- O passo 3 (T20, `/midia/{id}/faixas`) mostra o banner "Alguns títulos podem citar um nome errado. Reveja antes de aprovar: a lista está em "Nomes das vozes"." quando a preparação (`GET /api/v1/media/:id/preparation`) traz `nameReviews`; em "Nomes das vozes" cada revisão diz "Reveja estes títulos: “X” pode ser outra pessoa ou o nome errado." e lista os títulos (KBC-090).
- A API calcula `nameReviews` (`apps/api/src/modules/preparation/name-reviews.ts`): para cada voz com nome sugerido pela IA, os nomes errados são o sugerido e o último escrito, menos o nome certo (o dado pela pessoa, nada se recusado). Um título que diga um nome errado entra na revisão.
- Causas achadas (reproduzidas por teste antes da correção):
  1. **Aviso velho na tela.** O editor lê a preparação uma vez e só de novo quando um nome muda. A pessoa corrige o título (ou apaga a faixa) no próprio editor, a mudança é salva, e o banner e a lista continuam, com títulos que não existem mais na tela.
  2. **Parte do nome certo.** A IA sugere "Laércio" (uma palavra, nunca reescrita) e a pessoa dá à voz "Laércio Fonseca": todo título com "Laércio" é marcado, embora diga o nome certo, abreviado.
  3. **Nome de outra voz.** A IA sugere o mesmo nome para duas vozes (o palestrante separado em duas) e a pessoa aceita numa e recusa ou corrige na outra: todo título com o nome é marcado, embora ele seja o nome dado à primeira voz. A reescrita (`fixesOf`) já trata esse nome como de outra pessoa e não o troca.
  4. **Mesma pessoa, grafia do catálogo.** Aceitar "Laercio" quando o acervo já tem "Laércio" liga a voz ao falante existente (`speakerKeyOf` ignora acento e caixa): o nome dado difere do sugerido só no acento, e os títulos com "Laercio" são marcados.

## Scope
**In:** o cálculo de `nameReviews` na API e o banner e a lista "Reveja" no passo 3 do editor de faixas.
**Out:** a reescrita dos títulos (`VoiceNameFixer`), o texto do aviso, o passo 2 (preparo) além do que a mesma API devolve, dispensar uma revisão à mão, avisar títulos de vozes de plateia.

## Business rules
- BR-1: uma revisão só lista faixas que estão no rascunho mostrado agora, com o título mostrado agora: faixa apagada na tela sai da lista; título mudado fica nela enquanto ainda disser o nome errado (a mesma regra de `mentionsName` da API, KBC-090: texto de pessoa é revisado) e sai quando deixa de dizer; revisão sem faixa some, e o banner some sem revisão.
- BR-2: um nome errado que aparece inteiro, palavra por palavra (sem acento nem caixa, com as mesmas fronteiras de palavra do título: espaço, vírgula, hífen), dentro de um nome que uma pessoa deu a qualquer voz da gravação não é errado e não gera revisão; vale também para um nome de uma palavra dentro do nome de outra voz ("Pedro" em "Pedro Álvares"). Exceção: nenhuma; nome de uma palavra que não é parte de nome dado continua revisado (KBC-090).
- BR-3: um nome recusado, ou um nome corrigido que não é parte de nenhum nome dado, continua gerando revisão (KBC-090).

## Functional requirements
- FR-1: Quando o rascunho do editor muda, o sistema deve recalcular, sem ler a preparação de novo, quais faixas de cada revisão ainda estão na tela e ainda dizem o nome (título igual, ou `mentionsName` de `@kb-chat/contracts`), mostrar o título atual, e mostrar o banner só com alguma revisão restante. (BR-1)
- FR-2: Ao calcular `nameReviews`, a API deve descartar o nome errado contido, por palavras e com `speakerKeyOf`, num nome dado a uma voz da gravação. (BR-2, BR-3)

## Non-functional requirements
Nenhum específico.

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given o passo 3 com a revisão de "Joana Prado" na faixa "Pergunta de Joana Prado", When a pessoa muda esse título para "Pergunta da plateia", Then o banner "Alguns títulos podem citar…" e a revisão somem sem recarregar a página.
- **AC-1b** (FR-1, BR-1, negativo): Given a mesma revisão, When a pessoa muda o título para "Pergunta de Joana Prado (parte 2)", Then o banner continua e a revisão lista o título novo.
- **AC-2** (FR-1, BR-1): Given a mesma revisão em duas faixas, When a pessoa apaga uma delas, Then a revisão continua só com a outra e o banner continua.
- **AC-3** (FR-2, BR-2): Given a sugestão "Laércio" para a Voz 1 e o título "Laércio explica a Tábua", When a pessoa dá à Voz 1 o nome "Laércio Fonseca", Then `nameReviews` vem vazio.
- **AC-4** (FR-2, BR-2): Given a sugestão "Ana Souza" para as Vozes 1 e 2, a Voz 1 nomeada "Ana Souza", When a pessoa recusa o nome da Voz 2, Then `nameReviews` vem vazio.
- **AC-5** (BR-2, acento): Given a sugestão "Laercio" e a Voz 1 nomeada "Laércio" (falante do catálogo), Then o título "Laercio responde" não gera revisão.
- **AC-6** (BR-3, negativo): Given a sugestão "Pedro" e a Voz 1 nomeada "Marcos", Then o título "São Pedro e Pedro Álvares" continua em revisão, com o nome "Pedro".
- **AC-7** (BR-3, negativo): Given a sugestão "Joana Prado" recusada e nenhuma voz com esse nome, Then o título "Pergunta de Joana Prado" continua em revisão e o banner aparece no passo 3 (E2E do KBC-090).

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-1b, AC-2 | unitário (web) | `track-editor-page.spec.ts`: preparação com `nameReviews` servida pelo `HttpTestingController`, título mudado pelo campo e faixa apagada pelo menu |
| AC-3 a AC-6 | unitário (API, contracts) | `apps/api/src/modules/preparation/name-reviews.test.ts` (com vírgula, hífen e "Pedro" × "Pedro Álvares"), `libs/contracts/src/voice-names.test.ts` |
| AC-6, AC-7 | integração API e E2E | `voice-name-correction.integration.test.ts` (já existentes) e `e2e/specs/media-queue.spec.ts` "KBC-090: a correction and a refusal reach the published track" |

## References
Tela: [`docs/design/screens.md`](../design/screens.md) T20 e o parágrafo do KBC-090 em T23 · ADR: [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) · Código: `apps/api/src/modules/preparation/name-reviews.ts`, `apps/api/src/modules/media-edit/voice-name-fixer.ts` (`mentionsName`, `fixesOf`), `apps/web/src/app/features/media/tracks/track-editor-page.ts` (`voicesToName`, `titlesToReview`), `apps/web/src/app/features/media/preparation/preparation-voices.html`.

## Open questions
Nenhuma. O caso real do dono não está descrito; as quatro causas plausíveis estão cobertas (premissa registrada no estado do goal).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
