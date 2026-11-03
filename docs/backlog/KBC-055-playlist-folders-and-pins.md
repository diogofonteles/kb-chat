---
id: KBC-055
title: "Organizar a Biblioteca: pastas de playlists, ordem própria e fixar no topo"
status: ready
slice: phase-2-library
outcome: quem tem muitas playlists (por curso, por ano, por tradição) encontra a que quer em até 2 cliques
depends_on: [KBC-054]
---

# KBC-055 — Pastas, ordem própria e fixar

## Story
Como quem estuda com muitas playlists, quero agrupá-las em pastas, pôr a lista na minha ordem e fixar as que uso todo dia no topo, para não rolar a Biblioteca procurando.

## Scope
**In:** **Nova pasta** (nome); mover playlists para dentro e para fora de uma pasta (menu ⋯ **Mover para pasta** e arrastar no desktop); renomear e apagar pasta (as playlists voltam para a raiz, com **Desfazer**); página da pasta com as playlists dela e **Tocar tudo** (em ordem, playlist por playlist); ordem **Personalizada** das listas (arrastar e **Mover para cima/baixo**), além de Recentes, Adicionadas e A–Z; **Fixar** / **Desafixar** até 4 itens (playlists, pastas, Favoritas) no topo.
**Out:** pastas dentro de pastas; pastas compartilhadas (KBC-058 compartilha só playlists); fixar mídias soltas.

## Business rules
- BR-1: regra do dono (2026-10-28): pastas, ordem personalizada e fixar exigem a permissão nova `media-library-organize` ("Organizar a Biblioteca"), além de `media-playlists`; masters têm todas; convites e perfis não a concedem por padrão. Sem ela, a seção Playlists fica como no KBC-054.
- BR-2: um nível só de pastas (pasta → playlists), o mesmo limite dos sub-acervos (KBC-048 BR-2); uma playlist está em no máximo uma pasta; até 100 pastas por pessoa.
- BR-3: apagar uma pasta nunca apaga playlists: elas voltam para a raiz, na posição da pasta, com **Desfazer** por 8 s.
- BR-4: até 4 itens fixados; o 5º é recusado com "Você pode fixar até 4 itens. Desafixe um para fixar este."; itens fixados ficam no topo, na ordem em que foram fixados, em qualquer ordenação.
- BR-5: a ordem personalizada é da pessoa, vale em todos os aparelhos e só se aplica quando ela escolhe "Personalizada"; uma playlist nova entra no topo.
- BR-6: **Tocar tudo** numa pasta toca as playlists dela em ordem, cada uma do primeiro item não ouvido, como um único contexto da fila (KBC-053), limitado a 500 itens.
- BR-7: pastas e fixados são privados da pessoa.

## Functional requirements
- FR-1: `POST/GET/PATCH/DELETE /api/v1/media/playlist-folders` devem criar, listar, renomear e apagar pastas da pessoa; `PATCH /media/playlists/{id}` deve aceitar `folderId` (ou `null`). (BR-2, BR-3, BR-7)
- FR-2: `PUT /api/v1/media/library/order` com a lista de itens da raiz (playlists e pastas) e a `version` deve gravar a ordem personalizada; versão antiga → 409 com a ordem atual. (BR-5)
- FR-3: `PUT /api/v1/media/library/pins` com até 4 referências (`favorites`, `playlist:{id}`, `folder:{id}`) deve gravar os fixados; 5 ou mais → 400 `PIN_LIMIT`. (BR-4)
- FR-4: a seção "Playlists" da Biblioteca (T16) deve mostrar fixados (com ícone e o texto "Fixada"), pastas recolhíveis com a contagem e as playlists, e a página da pasta deve ter **Tocar tudo**. (BR-4, BR-6)

## Non-functional requirements
- NFR-1: com 100 pastas e 500 playlists, a seção abre em ≤ 1 s e o arrastar/mover responde em INP ≤ 200 ms.

## Acceptance criteria
- **AC-1** (FR-1, BR-2): Given três playlists, When a pessoa cria a pasta "UDV" e move duas para ela, Then a Biblioteca mostra "UDV · 2 playlists" e, ao abrir, as duas.
- **AC-2** (BR-2): Given uma pasta, When a pessoa tenta mover uma pasta para dentro de outra (arrastando), Then nada muda e o menu nem oferece essa opção; a API responde 400.
- **AC-3** (BR-3): Given a pasta "UDV" com duas playlists, When a pessoa apaga a pasta, Then as duas voltam à raiz no lugar da pasta; When clica **Desfazer**, Then a pasta volta com as duas.
- **AC-4** (FR-3, BR-4): Given 4 itens fixados, When a pessoa fixa um 5º, Then vê a mensagem do limite e nada muda.
- **AC-5** (BR-4): Given Favoritas e "Curso" fixados e a ordenação A–Z, When abre a Biblioteca, Then os dois aparecem no topo, na ordem em que foram fixados, antes da lista em A–Z.
- **AC-6** (FR-2, BR-5): Given a ordem "Personalizada", When a pessoa move "Revisão" para o topo com **Mover para cima**, Then a ordem continua assim em outro navegador da mesma conta.
- **AC-7** (BR-6): Given a pasta "UDV" com "Aulas 1" [A, B] e "Aulas 2" [C], When a pessoa clica **Tocar tudo**, Then A começa e o painel A seguir mostra B e C.
- **AC-8** (BR-1, BR-7): Given uma pessoa com `media-playlists` e sem `media-library-organize`, When abre a Biblioteca, Then não vê Nova pasta, Fixar nem a ordem Personalizada, e `POST /media/playlist-folders` responde 403; Given as pastas de outra pessoa, Then nunca aparecem.
- **AC-9** (acessibilidade): Given só o teclado, When a pessoa cria pasta, move playlists pelo menu, reordena e fixa, Then tudo funciona sem arrastar, as pastas expõem `aria-expanded`, e não há violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-3, AC-5, AC-7 | componente + E2E | |
| AC-2, AC-4, AC-8 | integração (API) + componente | Duas contas |
| AC-6 | E2E | Dois contextos de navegador |
| AC-9 | E2E | axe |
| NFR-1 | E2E com medição | Dados semeados |

## References
Tela: `docs/design/screens.md` T16 (Playlists, fixados, pastas) · KBC-054 · KBC-053 (contexto) · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.1–1.2

## Decisões assumidas (o dono pode mudar)
- Um nível de pastas e até 4 fixados (o Spotify permite aninhar; um nível basta e combina com os sub-acervos).

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
