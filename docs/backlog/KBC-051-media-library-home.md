---
id: KBC-051
title: "Biblioteca de mídia: uma casa só para áudios e vídeos, com continuar ouvindo, ouvidas recentemente, filtros, ordenação, grade ou lista e marcar como ouvida"
status: ready
slice: phase-2-library
outcome: quem estuda acha e retoma uma palestra (áudio ou vídeo) em 1 clique a partir da Biblioteca, sem passar pela conversa de documentos
depends_on: [KBC-041]
---

# KBC-051 — Biblioteca de mídia

## Story
Como quem estuda pelas palestras, quero uma Biblioteca só de áudios e vídeos, no modelo do Spotify, onde eu continue o que estava ouvindo, veja o que ouvi por último e filtre e ordene tudo o que posso ouvir, para navegar só na mídia sem passar pela busca de documentos.

## Scope
**In:** rota `/biblioteca` e item **Biblioteca** na lateral (no lugar de **Mídia** para quem tem a permissão); seções "Continuar ouvindo", "Ouvidas recentemente" e "Todas"; mídias de **todos os acervos** que a pessoa vê; filtros em chips (Áudio/Vídeo, Não ouvidas/Em andamento/Ouvidas, Autoria, Acervo e sub-acervo); ordenação (Ouvidas recentemente, Adicionadas recentemente, Título A–Z, Duração, Autor); **Buscar na biblioteca** (título e autor) com o atalho "Buscar na fala" (KBC-039); visão **lista** (padrão) ou **grade**; **Marcar como ouvida / não ouvida** (uma ou várias); **Limpar recentes**; escolhas lembradas na conta; envio de mídia continua no cabeçalho para quem tem `media-upload` (T14).
**Out:** favoritas (KBC-052), fila (KBC-053), playlists (KBC-054), pastas e fixar (KBC-055), baixadas (KBC-056), página do autor (KBC-059), recomendações ("parecidas com"), capa enviada pela pessoa.

## Business rules
- BR-1: regra do dono (2026-10-28): a Biblioteca é liberada pela permissão nova `media-library` ("Biblioteca de mídia"), que exige `media` ("Ouvir mídia"); masters têm todas; convites e perfis não a concedem por padrão. Sem ela, a pessoa com `media` continua com a lista **Mídia** de hoje (T14).
- BR-2: a Biblioteca mostra só mídias **prontas** dos acervos (e sub-acervos, KBC-048) que a pessoa vê, com as mesmas regras do stream (ADR 0022); mídias em fila, conversão ou falha aparecem só para quem as enviou e para masters, com o status (T14).
- BR-3: "Continuar ouvindo" lista as mídias com posição salva > 0 e não ouvidas, da mais recentemente tocada para a menos, no máximo 10.
- BR-4: "Ouvidas recentemente" lista as últimas 50 mídias distintas tocadas pela pessoa (qualquer estado), da mais recente; **Limpar recentes** esconde as tocadas até aquele momento, sem mudar posições, marcas de ouvida, marcadores ou favoritas.
- BR-5: **Marcar como ouvida** tem o mesmo efeito de chegar a 95% (KBC-041 BR-2): grava `completedAt` e zera a posição. **Marcar como não ouvida** apaga `completedAt` e deixa a posição em 0.
- BR-6: estado de escuta de cada mídia, para filtros e selos: "Não ouvida" (sem posição e sem `completedAt`), "Em andamento" (posição > 0 e sem `completedAt`), "Ouvida" (com `completedAt`; voltar a ouvir depois disso a mantém "Ouvida" até a pessoa desmarcar).
- BR-7: filtros, ordenação, visão (lista/grade) e acervo filtrado ficam na conta da pessoa (todos os aparelhos) até ela mudar.
- BR-8: vale igual para áudio e vídeo; o tipo aparece em texto ("Vídeo") além do ícone (UP-20).

## Functional requirements
- FR-1: `GET /api/v1/media/library` deve devolver as mídias da BR-2 em páginas de 50 (cursor), aceitando `kind`, `state`, `authorship` (ou autor, com o KBC-049), `topic`, `q` e `sort`, com `positionMs`, `completedAt`, `lastPlayedAt`, duração, tipo, acervo e autoria por item; 403 sem `media-library`. (BR-1, BR-2, BR-6)
- FR-2: `GET /api/v1/media/library/home` deve devolver "Continuar ouvindo" (até 10) e "Ouvidas recentemente" (até 50) da pessoa. (BR-3, BR-4)
- FR-3: `PUT /api/v1/media/played` com `{ ids: [...], played: true|false }` (até 200 ids) deve aplicar a BR-5 a cada mídia que a pessoa ouve e ignorar, sem erro, as que ela não vê, devolvendo os ids aplicados. (BR-5)
- FR-4: `DELETE /api/v1/media/library/recents` deve gravar o instante de limpeza da pessoa; `GET …/home` não deve mostrar o que foi tocado antes dele. (BR-4)
- FR-5: `GET/PUT /api/v1/media/preferences` deve aceitar também `librarySort`, `libraryView`, `libraryFilters` (validados por esquema). (BR-7)
- FR-6: a tela `/biblioteca` deve seguir `docs/design/screens.md` T16: cabeçalho, as três seções, chips, ordenação, busca, lista ou grade, seleção múltipla com "Marcar como ouvida/não ouvida", estados de carregando, vazio, erro, sem resultado e conteúdo extremo.
- FR-7: para quem tem `media-library`, o item da lateral passa a ser **Biblioteca** e `/midia` redireciona para `/biblioteca` (com o filtro do acervo selecionado); `/midia/{id}` (player) não muda. (BR-1)
- FR-8: clicar numa linha pronta abre o player; o botão ▶ da linha toca direto (com a posição salva, sem perguntar) e o mini-player aparece; em "Continuar ouvindo" o rótulo é "Continuar de 23:10".

## Non-functional requirements
- NFR-1: `GET /media/library` com 2.000 mídias e 10 acervos responde em p95 ≤ 300 ms no teste de integração (SQLite com índices em `playback(principal, updated_at)` e `media(topic, status, created_at)`).
- NFR-2: a lista de 2.000 itens rola sem travar (virtualizada; INP ≤ 200 ms medido no E2E) e trocar um chip atualiza a lista em ≤ 500 ms.
- NFR-3: nenhum item de outra pessoa ou de acervo sem acesso aparece em nenhuma resposta (testado com duas contas).

## Acceptance criteria
- **AC-1** (FR-6, FR-7, BR-1): Given uma pessoa com `media` e `media-library`, When abre o app, Then vê **Biblioteca** na lateral, e `/midia` a leva para `/biblioteca`.
- **AC-2** (BR-1): Given uma pessoa só com `media`, When abre o app, Then vê **Mídia** como hoje e `GET /media/library` responde 403.
- **AC-3** (FR-2, BR-3, BR-8): Given três mídias em andamento (uma de vídeo) e uma ouvida, When abre a Biblioteca, Then "Continuar ouvindo" mostra as três, a mais recente primeiro, cada uma com "Continuar de m:ss" e a barra de progresso, a de vídeo com o selo "Vídeo" em texto, e não mostra a ouvida.
- **AC-4** (FR-8): Given uma mídia em "Continuar ouvindo" em 23:10, When a pessoa clica ▶ na linha, Then o mini-player aparece e a reprodução começa em 23:10 (±1 s).
- **AC-5** (FR-1, BR-2): Given mídias em dois acervos, um que a pessoa não vê, When abre "Todas", Then só aparecem as do acervo que ela vê, e o filtro "Acervo" só lista esse.
- **AC-6** (FR-1, BR-6): Given os chips "Vídeo" e "Em andamento", When a pessoa marca os dois, Then só aparecem vídeos em andamento, e a contagem diz "2 mídias".
- **AC-7** (FR-3, BR-5): Given duas mídias selecionadas, uma em andamento, When a pessoa escolhe "Marcar como ouvida", Then as duas ficam "Ouvida", a em andamento sai de "Continuar ouvindo" e abrir o player dela não oferece "Continuar de".
- **AC-8** (FR-3, BR-5): Given uma mídia ouvida, When a pessoa escolhe "Marcar como não ouvida", Then ela volta a "Não ouvida" com a posição 0:00.
- **AC-9** (FR-4, BR-4): Given cinco mídias em "Ouvidas recentemente", When a pessoa clica **Limpar recentes** e confirma, Then a seção fica vazia ("Nada ouvido desde que você limpou."), e as posições e "Continuar ouvindo" continuam iguais.
- **AC-10** (FR-5, BR-7): Given ordenação "Duração" e visão em grade num navegador, When a pessoa entra em outro navegador com a mesma conta, Then a Biblioteca abre em grade e por duração.
- **AC-11** (FR-1): Given `PUT /media/played` com um id de mídia que a pessoa não vê, When a API responde, Then devolve 200 sem esse id na lista aplicada, e nada muda nele.
- **AC-12** (FR-6): Given "Buscar na biblioteca" com "conselheira", When não há título nem autor com a palavra, Then aparece "Nenhuma mídia com 'conselheira' no título ou no autor." com **Limpar busca** e **Buscar na fala**, que abre a busca de mídia com a palavra (KBC-039).
- **AC-13** (BR-2): Given uma mídia em conversão enviada por outra pessoa, When um membro abre a Biblioteca, Then ela não aparece; para quem a enviou, aparece com "Convertendo… 40%".
- **AC-14** (acessibilidade): Given só o teclado e um leitor de tela, When a pessoa usa os chips, a ordenação, a busca, a seleção múltipla e abre uma mídia, Then tudo funciona, a mudança de resultado é anunciada ("12 mídias"), e não há violações sérias ou críticas do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2 | integração (permissão) + E2E | Contas com e sem `media-library` |
| AC-3, AC-4 | integração + E2E | Posições semeadas; áudio e vídeo reais gerados por ffmpeg |
| AC-5, AC-11, AC-13, NFR-3 | integração (API) | Duas contas, dois acervos |
| AC-6, AC-12 | componente + E2E | |
| AC-7, AC-8, AC-9 | integração + E2E | |
| AC-10 | E2E | Dois contextos de navegador, mesma conta |
| AC-14 | E2E | axe nos três temas, duas larguras |
| NFR-1 | integração com medição | 2.000 mídias semeadas |
| NFR-2 | E2E com medição | INP pela Performance API |

## References
Tela: `docs/design/screens.md` T16 (e T14 para o envio) · ADR: [0022](../adr/0022-media-library-store-queue-and-streaming.md), [0025](../adr/0025-own-media-player-for-audio-and-video.md) · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.1 · Permissões: KBC-010, KBC-028, KBC-047 · Barra de qualidade da fase 2: `docs/backlog/README.md`

## Decisões assumidas (o dono pode mudar)
- A Biblioteca reúne **todos os acervos** que a pessoa vê (como o "Your Library" do Spotify), com o filtro "Acervo"; o acervo selecionado na lateral só vira o filtro inicial quando ela chega por `/midia`.
- Lista é a visão padrão: palestras quase nunca têm capa, e a grade usa uma capa gerada (iniciais do título sobre a cor do acervo).
- "Ouvidas recentemente" guarda 50 mídias, como o painel de recentes do Spotify no desktop.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions
- [x] Fits one goal
