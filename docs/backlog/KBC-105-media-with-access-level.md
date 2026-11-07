---
id: KBC-105
title: "Mídia com nível: escolher o nível é obrigatório no envio, dá para mudar depois, e a Biblioteca, \"Na fala\", o player e a transcrição só mostram o que está no nível da pessoa"
status: ready
slice: levels-release-1
outcome: num acervo com níveis, todo áudio enviado tem nível escolhido, e nenhum membro lista, acha, ouve ou lê a transcrição de um áudio acima do seu nível
depends_on: [KBC-103]
parent: LEVELS
---

# KBC-105 — Mídia com nível

## Story
Como quem envia áudios a um acervo com níveis, quero ser obrigado a escolher o nível de cada envio, para que cada palestra chegue só a quem pode ouvi-la.

## Scope
**In:** migração `media.level TEXT NULL` (só expansão) e, num acervo que já tem escala, semente no nível mais baixo para a mídia existente; campo **Nível** obrigatório no envio (T14) quando o acervo (ou o pai) tem escala, sem pré-seleção, com as opções até o nível de quem envia; `createMediaRequestSchema` com `level` (400 `LEVEL_REQUIRED`); **Nível** em "Editar informações" (KBC-050), com a escolha obrigatória ao mover para outro acervo de topo com escala; as faixas copiam o nível da gravação ao serem criadas e acompanham a mudança da gravação; filtro: `MediaService.get/visible` (404: item, stream, legenda, transcrição, palavras, onda, silêncios, progresso, marcadores do item, edição, falantes), `LibraryService` (lista, início, ouvidas, busca KBC-096), "Na fala" e contagens (`scopeClause`/`liveTrackClause` com `m.level IN (…)`), assunto → faixas, lista de marcadores, fila de processamento e preparações, `namedVoices`; checagem de repetido sem título acima do nível; tira o fechamento da mídia do KBC-103.
**Out:** nível próprio por faixa e documentos de faixa (KBC-106); playlists, offline e compartilhamento (ainda não existem; regra no README).

## Business rules
- BR-1: num acervo com escala, todo áudio novo tem nível; o envio sem nível é recusado.
- BR-2: quem envia escolhe o seu nível ou um abaixo; masters, qualquer.
- BR-3: quem pode editar o áudio (`canEditMedia`) muda o nível, até o próprio; a mudança é auditada.
- BR-4: mover para outro acervo de topo com escala exige um nível do destino; para um acervo sem escala, o nível é apagado.
- BR-5: um áudio que a pessoa não pode ver responde como inexistente em todas as rotas, e não conta em nenhuma contagem, faceta ou "Áudios (N)".
- BR-6: o arquivo repetido acima do nível de quem envia é recusado sem título nem link: "Este arquivo já está no acervo, num nível que você não vê. Fale com um master.".
- BR-7: uma faixa nova copia o nível da gravação; mudar o nível da gravação muda o das faixas que ainda o seguem.
- BR-8: mídia sem nível num acervo com escala só aparece para masters.

## Functional requirements
- FR-1: migração v26 (ou a próxima livre) adiciona `media.level`; `MediaRecord`, `NewMedia`, `mediaItemSchema` (só para quem gere níveis) e `toMediaItem` levam o nível. (BR-1)
- FR-2: `POST /topics/:topic/media` e `…/media/check` exigem `level` num acervo com escala e validam BR-2 (403 `LEVEL_ABOVE_YOURS`). (BR-1, BR-2)
- FR-3: `PATCH /media/:id` aceita `level`; com `topic` de outro topo com escala, exige `level` (400 `LEVEL_REQUIRED`); grava auditoria. (BR-3, BR-4)
- FR-4: `MediaService.visible` usa a `LevelView`; `isVisible`, `scopeClause`, `liveTrackClause`, `linkedTracks`, `bookmark-service`, `PreparationService.queue/listOpen` e `namedVoices` também. (BR-5, BR-8)
- FR-5: `check` devolve `duplicate-hidden` sem id nem título quando o item existente não é visível. (BR-6)
- FR-6: `sqlite-track-item-store.ts` copia `level` do pai; a mudança na gravação atualiza as faixas com o mesmo nível de antes, na mesma transação. (BR-7)
- FR-7: a web mostra **Nível** no envio e na edição (T14), com o erro no campo, e volta a mostrar a mídia do acervo a não-masters.

## Non-functional requirements
- NFR-1: "Na fala" com 2.000 h de transcrição sintética e o filtro de nível: p95 ≤ 150 ms (o mesmo limite do KBC-039, script `media-search-latency.ts`).
- NFR-2: a migração sobre um `media.db` de hoje roda em ≤ 2 s com 10.000 linhas e a imagem anterior continua lendo o banco (rollback).

## Acceptance criteria
- **AC-1** (BR-1, FR-2): Given "hermetismo" com escala QS < CI < CDC, When Ana (CI) envia sem escolher nível, Then **Enviar** não envia, o campo diz "Escolha o nível deste áudio." e a API, chamada direto, responde 400 `LEVEL_REQUIRED`.
- **AC-2** (BR-2, negativo): Given Ana (CI), Then as opções são QS e CI; chamando a API com CDC, 403 `LEVEL_ABOVE_YOURS`.
- **AC-3** (borda): Given um acervo sem escala, Then o campo **Nível** não aparece e o envio funciona como hoje.
- **AC-4** (BR-5): Given um áudio CDC transcrito, When Ana (CI) abre `/midia/{id}`, pede o stream, a legenda, a transcrição ou as palavras, Then 404 em todas.
- **AC-5** (BR-5, SQL): Given 2 áudios com "lua" na fala, um CI e um CDC, When Ana busca "lua" com áudios no alcance, Then "Na fala" mostra só o CI e "Áudios (1)".
- **AC-6** (BR-5): Given a Biblioteca, a busca da Biblioteca, a lista do acervo, "meus marcadores", a fila de processamento e as vozes nomeadas, Then nenhuma mostra ou conta o áudio CDC para Ana.
- **AC-7** (BR-6): Given o arquivo do áudio CDC, When Ana tenta enviá-lo, Then a linha diz "Este arquivo já está no acervo, num nível que você não vê. Fale com um master." e a resposta não tem id nem título.
- **AC-8** (BR-3, BR-7): Given uma gravação CI com 3 faixas, When quem enviou muda para QS, Then as 3 faixas vão para QS e a auditoria registra CI → QS com 1 gravação e 3 faixas.
- **AC-9** (BR-4): Given mover um áudio para "udv" (com escala), When o pedido vem sem nível, Then 400 e o painel pede "Nível em UDV"; para um acervo sem escala, o nível é apagado.
- **AC-10** (BR-8, migração): Given um acervo com escala criada antes desta migração, When ela roda, Then a mídia existente recebe o nível mais baixo; uma linha que ficar sem nível só aparece para masters.
- **AC-11** (master): Given o master, Then vê e ouve tudo, com o selo do nível em cada linha.
- **AC-12** (sem regressão): Given os specs de mídia existentes em acervos sem escala, Then passam sem mudança.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-7, AC-9 | integração + E2E | `media-levels.integration.test.ts`; `e2e/specs/media-levels.spec.ts` no Chrome, 1440 e 390 |
| AC-4 a AC-6, AC-11 | integração | duas pessoas, `media.db` semeado; busca dos títulos ocultos no JSON |
| AC-8 | integração | transação de faixas |
| AC-10 | migração | teste sobre cópia do banco de hoje, como o da ADR 0030 |
| AC-3, AC-12 | existentes | sem mudança |
| NFR-1, NFR-2 | script | `media-search-latency.ts` com nível; evidência em `work/KBC-105/` |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §3, §5, §7 · [0022](../adr/0022-media-library-store-queue-and-streaming.md), [0024](../adr/0024-media-search-outside-the-vault.md), [0033](../adr/0033-resumable-uploads-tus-core-on-the-item.md) · Tela T14 (envio e "Editar informações") com a emenda de 2026-11-06 · Barra de qualidade da fase 2.

## Open questions
Resolvidas em 2026-11-07 (dono, conversa: "aprovo todos"), com o padrão recomendado:
- Quem envia não escolhe nível acima do seu (masters: qualquer um).

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-103
- [x] Cabe num goal
