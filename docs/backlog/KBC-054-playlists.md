---
id: KBC-054
title: "Playlists: criar, renomear, descrever e apagar; adicionar áudios e vídeos de qualquer lugar; reordenar; página da playlist com tocar tudo e aleatório"
status: ready
slice: phase-2-library
outcome: quem estuda monta um percurso de estudo (por exemplo, "Curso de Cabala em 8 aulas") em menos de 2 minutos e o ouve em ordem
depends_on: [KBC-051, KBC-053]
---

# KBC-054 — Playlists

## Story
Como quem estuda, quero montar playlists de palestras (áudio e vídeo) na ordem que eu escolher, para estudar um tema como um curso, aula por aula.

## Scope
**In:** **Nova playlist** (nome obrigatório, descrição opcional); renomear e editar a descrição; **Apagar** com **Desfazer**; **Adicionar à playlist** no menu ⋯ de qualquer mídia (Biblioteca, Favoritas, busca, player, mini-player), com a lista das playlists da pessoa e "Nova playlist" no mesmo menu; seleção múltipla na Biblioteca → **Adicionar à playlist**; **Criar playlist com estas** a partir de uma lista filtrada ou das Favoritas; página da playlist (`/biblioteca/playlists/{id}`, T17) com nome, descrição, contagem, duração total, quanto falta ouvir, **Tocar** (em ordem), **Aleatório**, reordenar (arrastar e teclado), remover item com **Desfazer**, buscar dentro da playlist; playlists na Biblioteca (seção "Playlists", com Favoritas no topo); aviso de mídia repetida.
**Out:** pastas e fixar no topo (KBC-055); baixar a playlist (KBC-057); compartilhar com outras pessoas (KBC-058); capa enviada pela pessoa; playlists automáticas por assunto (fase C).

## Business rules
- BR-1: regra do dono (2026-10-28): playlists exigem a permissão nova `media-playlists` ("Criar playlists"), além de `media-library`; masters têm todas; convites e perfis não a concedem por padrão.
- BR-2: uma playlist é da pessoa que a criou; até o KBC-058, ninguém mais a vê, nem masters.
- BR-3: nome de 1 a 100 caracteres (sem só espaços); descrição até 1.000; nomes repetidos são permitidos (a lista mostra a data de criação para distinguir).
- BR-4: uma playlist tem até 1.000 itens; uma pessoa tem até 500 playlists. Passar de um limite recusa com a mensagem do limite ("Esta playlist chegou a 1.000 mídias.").
- BR-5: adicionar uma mídia que já está na playlist pergunta "'<título>' já está em '<playlist>'. Adicionar de novo?" com **Adicionar mesmo assim** e **Não adicionar** (padrão); na seleção múltipla, as repetidas são puladas e o aviso diz quantas ("2 já estavam na playlist e foram puladas.").
- BR-6: um item cuja mídia a pessoa deixou de ver continua na playlist, oculto, sem contar na duração; reaparece quando o acesso volta. Uma mídia removida sai de todas as playlists.
- BR-7: apagar uma playlist mostra "Playlist apagada" com **Desfazer** por 8 s; depois disso ela fica 30 dias recuperável por um master (pedido da pessoa) e então é apagada de vez.
- BR-8: tocar a partir da playlist define o contexto da fila (KBC-053) como a playlist, a partir do item escolhido; **Tocar** começa do primeiro item não ouvido.
- BR-9: vale igual para áudio e vídeo; uma playlist pode misturar os dois.

## Functional requirements
- FR-1: `POST/GET/PATCH/DELETE /api/v1/media/playlists` (e `POST …/{id}/restore` só para masters) devem criar, listar, editar, apagar (lógico) e restaurar, com 403 sem `media-playlists` e 404 para playlist de outra pessoa. (BR-1, BR-2, BR-3, BR-7)
- FR-2: `POST /api/v1/media/playlists/{id}/items` com `{ mediaIds: [...], position?, allowDuplicates? }` deve adicionar (até 200 por chamada), aplicando BR-4 e BR-5 (409 `PLAYLIST_DUPLICATE` com os ids repetidos quando `allowDuplicates` é falso), e `DELETE …/items/{itemId}` deve remover. (BR-4, BR-5)
- FR-3: `PUT /api/v1/media/playlists/{id}/order` com a lista de `itemId` e a `version` atual deve gravar a nova ordem; uma `version` antiga responde 409 `PLAYLIST_CHANGED` com a ordem atual. (BR-2)
- FR-4: `GET /api/v1/media/playlists/{id}` deve devolver os itens que a pessoa vê, com estado de escuta e posição, a contagem de ocultos, a duração total e o tempo que falta ouvir. (BR-6)
- FR-5: o menu **Adicionar à playlist** deve listar as playlists da pessoa (mais recentemente usadas primeiro, com busca acima de 10) e "Nova playlist", e confirmar com "Adicionada a '<playlist>'." e **Desfazer**. (BR-5)
- FR-6: a página da playlist deve seguir T17: cabeçalho, **Tocar**, **Aleatório**, ⋯ (Renomear, Editar descrição, Apagar), lista com reordenar por arrastar e por **Mover para cima/baixo**, remover com **Desfazer**, buscar na playlist, e os estados de T17. (BR-8)
- FR-7: remover uma mídia deve apagar os itens dela em todas as playlists na mesma transação. (BR-6)

## Non-functional requirements
- NFR-1: adicionar a uma playlist responde na tela em ≤ 100 ms (otimista) e reverte com aviso se a API falhar; p95 da API ≤ 150 ms com 1.000 itens.
- NFR-2: a página de uma playlist com 1.000 itens abre em ≤ 1 s e reordena sem travar (INP ≤ 200 ms).
- NFR-3: nenhuma playlist de outra pessoa aparece ou é alterável por nenhuma rota (testado com duas contas em todas as rotas do FR-1 a FR-3).

## Acceptance criteria
- **AC-1** (FR-1, FR-6): Given uma pessoa com `media-playlists`, When cria "Curso de Cabala" e adiciona 3 mídias (uma de vídeo), Then a playlist aparece na Biblioteca com "3 mídias · <duração>" e abre a página com as 3 na ordem em que entraram.
- **AC-2** (FR-5): Given o player de uma mídia, When a pessoa escolhe ⋯ → **Adicionar à playlist** → "Nova playlist", digita "Revisão" e confirma, Then a playlist é criada com essa mídia e o aviso "Adicionada a 'Revisão'." aparece.
- **AC-3** (FR-3, FR-6): Given a playlist [A, B, C], When a pessoa arrasta C para o topo (ou usa **Mover para cima** duas vezes), Then a ordem vira C, A, B e continua assim ao recarregar.
- **AC-4** (FR-3): Given a playlist aberta em dois navegadores, When um reordena e o outro reordena com a versão antiga, Then o segundo recebe "A playlist mudou em outro aparelho. Mostramos a ordem atual." e vê a ordem gravada.
- **AC-5** (BR-5, FR-2): Given A já na playlist, When a pessoa adiciona A de novo, Then vê a pergunta com **Não adicionar** em foco; When seleciona A, B e C (A e B já estão) e adiciona, Then só C entra e o aviso diz "2 já estavam na playlist e foram puladas.".
- **AC-6** (BR-7): Given uma playlist, When a pessoa a apaga e clica **Desfazer** em até 8 s, Then ela volta igual, com os itens e a ordem.
- **AC-7** (BR-7, FR-1): Given uma playlist apagada há 5 dias, When um master a restaura a pedido da pessoa, Then ela volta para a pessoa; When um membro chama `restore`, Then recebe 403.
- **AC-8** (BR-6, FR-4): Given uma playlist com uma mídia de um acervo que a pessoa deixou de ver, When abre a playlist, Then a mídia não aparece, a duração não a conta e há a nota "1 mídia oculta: você não tem mais acesso a ela."; When o acesso volta, Then reaparece no mesmo lugar.
- **AC-9** (FR-7, BR-6): Given uma mídia em duas playlists, When um master a remove, Then ela sai das duas.
- **AC-10** (BR-8): Given a playlist [A ouvida, B, C], When a pessoa clica **Tocar**, Then B começa e o painel A seguir mostra "A seguir de: <playlist>" com C.
- **AC-11** (BR-2, NFR-3): Given a playlist de outra pessoa, When alguém chama `GET`, `PATCH`, `DELETE`, `POST …/items` ou `PUT …/order` nela, Then recebe 404 e nada muda.
- **AC-12** (BR-3, BR-4): Given um nome só com espaços, When a pessoa salva, Then o campo mostra "Dê um nome à playlist." e nada é criado; Given 1.000 itens, When adiciona outro, Then vê o aviso do limite.
- **AC-13** (BR-1): Given uma pessoa sem `media-playlists`, When abre a Biblioteca e o menu ⋯, Then não há "Playlists" nem "Adicionar à playlist", e `POST /media/playlists` responde 403.
- **AC-14** (acessibilidade): Given só o teclado e um leitor de tela, When a pessoa cria, renomeia, adiciona, reordena com o teclado, remove com Desfazer e apaga, Then tudo funciona, cada mudança de ordem é anunciada ("Movida para a posição 1 de 3"), e não há violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-3, AC-5, AC-6, AC-10 | componente + E2E | Mídias reais curtas; áudio e vídeo |
| AC-4 | integração + E2E | Dois contextos de navegador |
| AC-7, AC-8, AC-9, AC-11, AC-12, AC-13, NFR-3 | integração (API) | Duas contas e um master |
| AC-14 | E2E | axe |
| NFR-1, NFR-2 | integração + E2E com medição | 1.000 itens semeados |

## References
Tela: `docs/design/screens.md` T16 (seção Playlists) e T17 (página da playlist) · ADR: [0022](../adr/0022-media-library-store-queue-and-streaming.md) (tabelas `playlists` e `playlist_items` com `position` e `version` no `media.db`) · KBC-053 (contexto da fila) · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.2

## Decisões assumidas (o dono pode mudar)
- Apagar usa "Desfazer" (UP-07) e 30 dias de recuperação por um master, no lugar dos 90 dias de autoatendimento do Spotify.
- Sem capa enviada: a capa é gerada (mosaico das 4 primeiras mídias ou as iniciais), para não guardar nem moderar imagens.
- Repetidas são permitidas depois da pergunta (um curso pode repetir uma aula de revisão).

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
