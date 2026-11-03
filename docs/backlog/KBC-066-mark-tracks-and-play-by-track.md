---
id: KBC-066
title: "Editar em faixas: marcar cada pergunta com a sua resposta pela transcrição, dar título e ouvir por faixa no player"
status: ready
slice: phase-2-editing
outcome: uma palestra de 1 h com perguntas e respostas vira uma lista de faixas navegáveis no player, marcada à mão em ≤ 15 minutos
depends_on: [KBC-065, KBC-041]
---

# KBC-066 — Editar em faixas (à mão) e ouvir por faixa

## Story
Como quem edita, quero dividir uma gravação em faixas (cada pergunta junto com a sua resposta é uma faixa), com um título para cada uma, para que quem estuda vá direto à pergunta que interessa.

## Scope
**In:** tela nova "Editar em faixas" (T20, a desenhar com o `product-designer` na spec), aberta pela página do áudio para quem tem `media-edit`: a transcrição com os falantes (KBC-065) e uma linha do tempo; criar faixa selecionando trechos (do primeiro segmento da pergunta ao último da resposta), ajustar o começo e o fim por segmento, dividir e juntar faixas, título, tipo (`Pergunta e resposta` ou `Exposição`), quem pergunta e quem responde (falantes); rascunho salvo sozinho; "Publicar faixas" torna a edição visível; uma edição publicada pode ser reaberta, e a nova publicação substitui a anterior. Para quem ouve, permissão nova `media-tracks` ("Navegar por faixas"): lista "Faixas" ao lado da transcrição, marcas na barra do player, título da faixa atual no player e no mini-player, anterior/próxima faixa, link para uma faixa (`?track=`).
A mesma tela T20 é o fim da jornada que começa no envio: o KBC-072 acrescenta o modo preparação (etapas com progresso e a lista de faixas crescendo); este item já desenha a lista de faixas com título, intervalo, duração, quem pergunta e quem responde e status em cada linha, renomear na linha e ▶ Ouvir, para o KBC-072 só acrescentar o cabeçalho de etapas.
**Out:** propor as faixas com IA (KBC-067); escolher as etapas no envio e o modo preparação (KBC-072); faixas como itens próprios da Biblioteca, playlists e download (KBC-068); assuntos (KBC-069); cortar ou recodificar o áudio (aqui as faixas são intervalos de tempo do mesmo arquivo).

## Business rules
- BR-1: uma faixa é um intervalo `[início, fim)` da gravação, alinhado a começos e fins de segmentos da transcrição atual; as faixas de uma edição não se sobrepõem; pode haver trechos fora de faixas (aplausos, música, intervalo).
- BR-2: uma faixa do tipo `Pergunta e resposta` começa no começo da pergunta e termina no fim da resposta; perguntas de continuação da mesma pessoa sobre o mesmo assunto ficam na mesma faixa (decisão assumida abaixo).
- BR-3: todo título tem de 1 a 120 caracteres; título vazio impede publicar, nunca salvar o rascunho.
- BR-4: editar exige `media-edit` no acervo; ver faixas exige `media-tracks` e acesso ao áudio; o rascunho só aparece para quem edita.
- BR-5: duração mínima de uma faixa: 5 s.
- BR-6: se a transcrição muda de versão, as faixas publicadas mantêm os tempos e a edição mostra "Revise os limites: a transcrição mudou" a quem edita.

## Functional requirements
- FR-1: `GET/PUT /api/v1/media/{id}/edit` deve ler e salvar o rascunho (faixas com início, fim, título, tipo, quem pergunta, quem responde) com controle de versão (`If-Match`); `POST …/edit/publish` deve validar e publicar. (BR-1, BR-3, BR-4, BR-5)
- FR-2: `GET /api/v1/media/{id}/tracks` deve devolver as faixas publicadas para quem tem `media-tracks`. (BR-4)
- FR-3: A tela de edição deve criar uma faixa a partir dos segmentos selecionados, oferecer dividir no segmento escolhido e juntar com a vizinha, tocar a faixa do começo, e salvar o rascunho 1 s depois da última mudança com o aviso "Rascunho salvo".
- FR-4: Ao publicar com erros, a tela deve listar cada faixa com problema (título vazio, sobreposição, curta demais) e levar o foco à primeira. (BR-1, BR-3, BR-5)
- FR-5: O player deve mostrar as marcas das faixas na barra, o título da faixa atual, e "Faixa anterior"/"Próxima faixa" (também por atalho: `Shift+←`/`Shift+→`); `?track=<n>` abre o player no começo da faixa.
- FR-6: Dois editores salvando o mesmo rascunho: o segundo recebe 412 e a tela diz "Outra pessoa mudou esta edição; recarregue para ver" sem perder o que ele digitou (copiável). (FR-1)

## Non-functional requirements
- NFR-1: a tela de edição abre em ≤ 1,5 s com uma gravação de 2 h (≈ 1.500 segmentos) e rola a 60 fps em 1440 px, medido no E2E com trace.
- NFR-2: salvar o rascunho responde em ≤ 300 ms com 200 faixas.

## Acceptance criteria
- **AC-1** (FR-3, FR-1, BR-2): Given uma palestra com vozes nomeadas, When quem edita seleciona a pergunta da plateia e a resposta do Mestre e cria uma faixa "O que é a burracheira?", Then a faixa aparece na lista com os tempos e o rascunho é salvo.
- **AC-2** (FR-1, FR-2, FR-5): Given 12 faixas no rascunho, When quem edita publica, Then quem ouve com `media-tracks` vê as 12 faixas, as marcas na barra e o título da faixa atual, e "Próxima faixa" pula para o começo da seguinte.
- **AC-3** (FR-4, BR-1): Given duas faixas que se sobrepõem, When quem edita publica, Then a publicação é recusada, a lista aponta as duas e o foco vai para a primeira.
- **AC-4** (BR-3, BR-5, limites): Given uma faixa de 4 s ou com título vazio, When quem edita publica, Then é recusada; Given 5 s e título de 120 caracteres, Then publica.
- **AC-5** (BR-4, permissão): Given uma pessoa com `media` e sem `media-tracks`, When abre o áudio, Then o player é o de antes, sem faixas; e sem `media-edit`, `PUT …/edit` responde 403.
- **AC-6** (BR-4): Given um rascunho não publicado, When quem só ouve abre o áudio, Then não vê nenhuma faixa do rascunho.
- **AC-7** (FR-6): Given dois editores com a mesma edição aberta, When o segundo salva depois do primeiro, Then recebe a mensagem de conflito e o texto dele continua na tela.
- **AC-8** (BR-6): Given faixas publicadas e uma transcrição refeita, When quem edita abre a edição, Then vê "Revise os limites: a transcrição mudou" e quem ouve continua com as mesmas faixas.
- **AC-9** (FR-5): Given o link `?track=3`, When aberto, Then o player começa no início da faixa 3.
- **AC-10** (acessibilidade): a tela de edição funciona só com teclado (selecionar segmentos com `Shift+↑/↓`, criar faixa com um botão), anúncios em `aria-live` ao salvar e publicar, sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-9 | E2E (Google Chrome e WebKit, áudio real gerado por ffmpeg) | asserções sobre `currentTime`, barra de qualidade da fase 2 |
| AC-3, AC-4 | unitário (validador de faixas, fast-check em intervalos) + integração | |
| AC-5, AC-6 | integração + E2E | três contas |
| AC-7 | integração | `If-Match` |
| AC-8 | integração | |
| AC-10 | E2E | axe |
| NFR-1 | E2E com trace | fixture de 2 h |

## References
ADR [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), 0025 (player em camadas: a navegação por faixas é um serviço novo sobre o motor) · Telas T15 e T20 (nova; modo preparação no KBC-072) · Pesquisa: KBC-063 · Benchmark do player (capítulos): `docs/research/2026-10-28-player-benchmark.md` item 17

## Decisões assumidas (o dono pode mudar)
- Trechos que não são pergunta e resposta (a exposição antes das perguntas) viram faixas do tipo `Exposição`, com título, para a gravação toda ficar navegável.
- Pergunta de continuação da mesma pessoa sobre o mesmo assunto fica na mesma faixa.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (T20 desenhada na spec)
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal
