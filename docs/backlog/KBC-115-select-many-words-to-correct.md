---
id: KBC-115
title: "Selecionar várias palavras para corrigir: arrastar, Shift+clique e Shift+setas"
status: in-progress
slice: phase-2-editing
outcome: quem prepara um áudio escolhe de uma vez as palavras erradas de um trecho (um nome partido em três, uma expressão) e a correção abre com todas, sem clicar em "Incluir a próxima" palavra por palavra; "Corrigir todas" procura a sequência inteira
depends_on: [KBC-093, KBC-092, KBC-106]
---

# KBC-115 — Selecionar várias palavras para corrigir

*Pedido do dono (fila de 2026-11-10):* "no 'Texto da faixa' e na transcrição completa, selecionar várias palavras arrastando (mouse e toque) ou com Shift+clique e Shift+setas. A correção abre com o trecho todo, e 'Corrigir todas' procura a sequência inteira. Hoje só dá com 'Incluir a próxima' (KBC-093, ADR 0034)."

## Story
Como quem prepara um áudio, quero marcar várias palavras seguidas do texto de uma vez (arrastando com o mouse ou o dedo, ou com Shift+clique e Shift+setas), para corrigir um nome ou uma expressão que a transcrição partiu em várias palavras sem montar a escolha palavra por palavra.

## Scope
**In:** no **Texto da faixa** e na **transcrição completa** (KBC-092) dos passos 2 e 3, para quem tem `media-correct`: arrastar sobre as palavras com o mouse; com o dedo, segurar numa palavra e arrastar; Shift+clique numa palavra estende a escolha aberta; Shift+→/Shift+← no bloco de texto estendem ou encolhem a escolha e ela abre ao soltar o Shift; a escolha marcada no texto enquanto se arrasta; o painel **Corrigir palavra** abre com todas as palavras (campo, contexto, Ouvir, Salvar, Apagar) e **Corrigir todas** procura a sequência inteira (o que o KBC-093 já faz para até 5 palavras).
**Out:** mudar o limite de 5 palavras de um mesmo trecho (BR-1 do KBC-093, ADR 0034 §1: a API continua recusando com 409 `not-contiguous`); escolher palavras de dois trechos (segmentos) ou de duas vozes; seleção na página do player (KBC-038) e da faixa publicada; mudar a API.

## Business rules
- BR-1: a escolha é sempre de palavras **seguidas de um mesmo trecho** (segmento), no máximo 5 (KBC-093 BR-1). Ao arrastar, ao Shift+clicar ou ao Shift+setas para além disso, a escolha para na borda do trecho ou na quinta palavra, conta-se a partir da palavra onde começou (a âncora), e a pessoa lê e ouve "A correção fica dentro de um trecho, com até 5 palavras.".
- BR-2: um **trecho restrito** (KBC-106, sem texto para a pessoa) nunca entra numa escolha nem é cruzado por ela: como a escolha fica num trecho só, arrastar de uma palavra para dentro ou para além de um trecho restrito para na borda do trecho de onde saiu. Quem está abaixo do nível de uma faixa da gravação continua recebendo "Esta gravação tem faixas acima do seu nível…" ao salvar (`EDIT_ABOVE_YOUR_LEVEL`, KBC-106).
- BR-3: uma escolha nova (arrastar) segue o clique do KBC-093 (BR-17): ao soltar, o áudio vai ao começo da **primeira** palavra e o painel abre na mesma ação; com o campo mudado e não salvo, uma escolha que não toca nas palavras abertas não move nada ("Salve ou cancele esta correção antes de escolher outra palavra.").
- BR-4: estender (Shift+clique, Shift+setas) funciona como **Incluir a próxima/anterior**: mantém a âncora e o texto já digitado, e o áudio fica onde está.
- BR-5: só quem tem `media-correct` seleciona; para os outros, arrastar no texto continua sendo seleção comum do navegador e nada abre (KBC-093 BR-5).

## Functional requirements
- FR-1: Quando a pessoa aperta o botão do mouse numa palavra (um clique só) e o move mais de 4 px, o sistema deve marcar no texto as palavras da âncora até a palavra sob o ponteiro (BR-1), sem a seleção azul do navegador, e ao soltar abrir **Corrigir palavra** com elas (BR-3); começar no espaço entre duas palavras vale pela mais próxima; Esc antes de soltar desiste. Duplo e triplo clique continuam selecionando como o navegador (copiar), e um trecho já selecionado numa linha ao clicar continua sendo o começo da escolha (KBC-093 FR-2). (BR-1, BR-3)
- FR-2: Quando a pessoa segura o dedo numa palavra por 0,4 s sem mover, o sistema deve começar a escolha nessa palavra (sem o menu do navegador nem a rolagem do bloco) e acompanhar o dedo até soltar; um deslize antes disso rola o bloco como hoje e um toque curto escolhe uma palavra como no KBC-093. Um segundo dedo não interrompe a escolha; um cancelamento do navegador a desfaz sem deixar marca. Só quem corrige recebe o ouvinte de toque que pode segurar a rolagem. (BR-1, BR-3, BR-5)
- FR-3: Quando a pessoa dá Shift+clique numa palavra com o painel aberto, o sistema deve estender a escolha da âncora até essa palavra (BR-1, BR-4); sem painel aberto, Shift+clique é um clique.
- FR-4: Quando o bloco de texto tem o foco e a pessoa aperta Shift+→ ou Shift+←, o sistema deve mover a ponta da escolha uma palavra (começando pela escolha aberta, senão pela última palavra escolhida, senão pela palavra falada, senão pela primeira palavra do texto), marcar no texto e anunciar as palavras numa região viva; ao soltar o Shift, abrir o painel com elas (ou atualizar o aberto, BR-4). Esc antes de soltar desiste. No campo do painel, Shift+setas continuam selecionando letras.
- FR-5: Com mais de uma palavra, o painel deve se chamar "Corrigir palavras, <palavras>" e dizer "Este trecho aparece N vezes na gravação · **Corrigir todas**", que abre com a sequência inteira. (Corrigir todas: KBC-093 FR-11)
- FR-6: Ao abrir o painel com uma escolha feita por arrasto ou teclado, o sistema deve anunciar "N palavras escolhidas: <palavras>".

## Non-functional requirements
- NFR-1: arrastar não cria um elemento por palavra (KBC-093 NFR-5): a marca é um CSS Custom Highlight (`correcting-word`) e cada movimento lê uma posição de caret; medido por teste de unidade (nenhum `span` novo nas linhas).
- NFR-2: acessibilidade WCAG 2.2 AA: o caminho do teclado (Shift+setas no bloco, que já é focável) não depende de arrastar (2.5.7 Dragging Movements: há a alternativa de um ponteiro só: Shift+clique e os botões Incluir); axe sem violações sérias no painel com várias palavras; alvos de toque do painel ≥ 44 px (já no KBC-093).

## Acceptance criteria
- **AC-1** (FR-1, BR-3) Given o texto "o mestre Tiuako disse assim" no passo 3, When a pessoa arrasta com o mouse de "mestre" até "Tiuako", Then o painel abre como "Corrigir palavras, mestre Tiuako", o campo diz "mestre Tiuako" selecionado, o texto marca "mestre Tiuako" e o áudio vai ao começo de "mestre".
- **AC-2** (FR-5) Given "mestre Tiuako" duas vezes na gravação, When a pessoa escolhe as duas palavras arrastando e usa **Corrigir todas**, Then a prévia lista as 2 ocorrências da sequência e, ao confirmar "Mestre Tiuaco", as duas mudam.
- **AC-3** (BR-1, borda do trecho) Given a escolha começando em "Tiuako" do primeiro trecho, When a pessoa arrasta até uma palavra do trecho seguinte, Then a escolha para em "assim" (última do trecho), o painel abre com "Tiuako disse assim" e aparece "A correção fica dentro de um trecho, com até 5 palavras.".
- **AC-4** (BR-1, limite de 5) Given um trecho de 7 palavras, When a pessoa arrasta da primeira à sétima, Then a escolha tem as 5 primeiras.
- **AC-5** (BR-2) Given um trecho restrito entre dois trechos, When a pessoa arrasta de uma palavra do trecho de cima para dentro do restrito, Then a escolha para na última palavra do trecho de cima e nenhuma palavra do restrito é escolhida.
- **AC-6** (FR-3, BR-4) Given o painel aberto em "mestre" com o campo mudado para "Mestre", When a pessoa dá Shift+clique em "disse", Then a escolha é "mestre Tiuako disse", o campo guarda "Mestre" e o áudio não se move.
- **AC-7** (FR-4) Given o bloco com o foco depois de fechar o painel de "mestre", When a pessoa aperta Shift+→ duas vezes e solta o Shift, Then o painel abre com "mestre Tiuako disse" e a região viva disse "mestre Tiuako" e "mestre Tiuako disse" enquanto se apertava.
- **AC-8** (FR-4) Given uma escolha por Shift+setas em andamento, When a pessoa aperta Esc, Then nada abre e a marca some.
- **AC-9** (FR-2) Given 390 px com toque, When a pessoa segura em "mestre" e arrasta até "Tiuako", Then o painel abre como folha com "mestre Tiuako" e o bloco não rolou; When só desliza o dedo rápido, Then o bloco rola e nada abre.
- **AC-10** (BR-3) Given o campo mudado e não salvo, When a pessoa arrasta sobre outras palavras, Then nada muda e aparece "Salve ou cancele esta correção antes de escolher outra palavra.".
- **AC-11** (BR-5) Given alguém sem `media-correct`, When arrasta sobre as palavras, Then nada abre e o áudio não se move.
- **AC-12** (BR-2, KBC-106) Given uma escolha de várias palavras numa gravação com uma faixa acima do nível da pessoa, When ela salva, Then lê "Esta gravação tem faixas acima do seu nível. Só quem tem todos os níveis dela pode editá-la.".
- **AC-13** (NFR-2) Given o painel aberto com várias palavras, Then axe não acha violação séria nem crítica.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12 | unidade (Vitest, `corrections/track-text-corrections.spec.ts`, bloco KBC-115; `corrections/word-span.spec.ts`) | caret falso (`CARET_AT_POINT`), eventos de ponteiro e teclado, `HttpTestingController`. AC-5 e AC-12 só por unidade: o editor de faixas já recusa quem está abaixo de uma faixa, então a interface não chega a esses estados |
| AC-1, AC-2, AC-3, AC-6, AC-7 | E2E (`media-transcript-span.spec.ts`, desktop) | transcrição semeada com tempos conhecidos |
| AC-9 | E2E (media-mobile) + unidade | toque por CDP (`Input.dispatchTouchEvent`): segurar e arrastar na vertical sem rolar, deslize rápido que rola sem abrir; unidade que falha sem o corte de 10 px |
| AC-13 | E2E axe | tema claro |
| FR-5/FR-6 rótulos | unidade (`correction-desk`/painel) | |

## References
Tela: [`docs/design/screens.md`](../design/screens.md) T20 "Corrigir palavra" · ADR: [0034](../adr/0034-transcript-word-corrections.md), [0037](../adr/0037-learning-from-transcript-corrections.md), [0036](../adr/0036-access-levels-per-collection.md) · Itens: [KBC-093](KBC-093-correct-transcript-words.md), [KBC-092](KBC-092-track-text-and-spoken-word-highlight.md), [KBC-106](KBC-106-tracks-with-their-own-level.md)

## Open questions
- Nenhuma. Padrões assumidos (o dono pode mudar): o limite de 5 palavras de um trecho fica; a escolha não cruza trechos nem vozes; no toque, segurar 0,4 s começa a escolha (e, para quem corrige, segurar no texto não seleciona para copiar; no mouse, duplo e triplo clique continuam copiando).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal (otherwise split)
