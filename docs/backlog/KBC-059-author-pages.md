---
id: KBC-059
title: "Página do autor na Biblioteca: todas as palestras de um autor que a pessoa pode ouvir, com horas, progresso, tocar tudo e filtros"
status: ready
slice: phase-2-library
outcome: quem estuda a obra de um mestre ou autor encontra e ouve tudo dele em um lugar, sabendo quanto já ouviu
depends_on: [KBC-051, KBC-049]
---

# KBC-059 — Página do autor

## Story
Como quem estuda a obra de um autor (por exemplo, Mestre Laércio ou Mestre Gabriel), quero uma página com todas as palestras dele que posso ouvir, quanto já ouvi e um "Tocar tudo", para seguir a obra inteira sem montar filtros.

## Scope
**In:** página `/biblioteca/autores/{topic}/{author}` (T16, variação "Autor"); acesso pelo nome do autor na linha, no player e no filtro da Biblioteca; cabeçalho com o nome, ✦ quando é o autor principal do acervo (KBC-049), o acervo, "n mídias · h:mm", "Você ouviu x de n"; seções "Continuar ouvindo" (deste autor) e "Todas"; os mesmos chips e ordenação da Biblioteca (com "Mais antigas primeiro" para seguir a obra); **Tocar tudo** (do primeiro item não ouvido, como contexto da fila) e **Aleatório**; lista **Autores** na Biblioteca (todos os autores com mídia que a pessoa vê, com contagem).
**Out:** biografia, foto e "seguir" o autor (sem feed de novidades num acervo fechado); mesclar autores repetidos (KBC-049 Out); página de autor de documentos (só mídia).

## Business rules
- BR-1: regra do dono (2026-10-28): a página do autor e a lista **Autores** são liberadas pela permissão nova `media-authors` ("Páginas de autor"), além de `media-library`; masters têm todas; convites e perfis não a concedem por padrão. Sem ela, o nome do autor não é link.
- BR-2: a página mostra só mídias prontas dos acervos que a pessoa vê; um autor sem nenhuma mídia visível para ela responde como não encontrado ("Não há mídias deste autor que você possa ouvir.").
- BR-3: autores são por acervo (KBC-049 BR-1): o mesmo nome em dois acervos são duas páginas; um sub-acervo usa os autores do pai.
- BR-4: "Você ouviu x de n" conta as mídias "Ouvida" (KBC-051 BR-6) entre as visíveis.
- BR-5: mídias sem autor informado ficam em "Outros autores" (KBC-049 BR-4), que também tem página.
- BR-6: **Tocar tudo** e **Aleatório** seguem o KBC-053 (contexto até 500 itens; sem `media-queue`, toca a primeira não ouvida e para ao fim).
- BR-7: vale igual para áudio e vídeo.

## Functional requirements
- FR-1: `GET /api/v1/media/authors?topic=` deve listar os autores com ao menos uma mídia visível para a pessoa, com contagem e duração; `GET /api/v1/media/authors/{topic}/{author}` deve devolver o cabeçalho (nome, principal, acervo, contagem, duração, ouvidas) e as mídias com os mesmos filtros, ordenação e paginação do KBC-051 FR-1. (BR-1 a BR-5)
- FR-2: o nome do autor na linha da Biblioteca, no player e em Favoritas/playlists deve ser link para a página (quando há a permissão), com nome acessível "Ver todas as mídias de <autor>". (BR-1)
- FR-3: a página deve seguir T16 (variação Autor), com os estados de carregando, vazio, erro e não encontrado; **Tocar tudo** e **Aleatório** como na BR-6. (BR-2, BR-6)
- FR-4: a Biblioteca deve ter a lista **Autores** (ordenada por nome, com o autor principal de cada acervo primeiro). (BR-3)

## Non-functional requirements
- NFR-1: a página de um autor com 1.000 mídias responde em p95 ≤ 300 ms na API e abre em ≤ 1 s.

## Acceptance criteria
- **AC-1** (FR-1, FR-3, BR-4): Given 12 mídias de Mestre Laércio no Hermetismo, 3 ouvidas (uma de vídeo), When a pessoa abre a página, Then vê "✦ Mestre Laércio · Hermetismo", "12 mídias · <duração>" e "Você ouviu 3 de 12".
- **AC-2** (FR-2): Given a linha de uma mídia na Biblioteca, When a pessoa clica no nome do autor, Then abre a página dele.
- **AC-3** (BR-2): Given um autor só com mídias num acervo que a pessoa não vê, When ela abre o endereço direto, Then vê "Não há mídias deste autor que você possa ouvir." e a API responde 404.
- **AC-4** (BR-3): Given "Mestre Gabriel" cadastrado na UDV e um homônimo no Hermetismo, When a pessoa abre a lista **Autores**, Then vê dois itens, cada um com o acervo.
- **AC-5** (BR-6): Given 12 mídias, as 3 primeiras (ordem "Mais antigas primeiro") ouvidas, When a pessoa clica **Tocar tudo**, Then a 4ª começa e o painel A seguir mostra as demais.
- **AC-6** (BR-5): Given mídias sem autor, When a pessoa abre "Outros autores", Then as vê ali.
- **AC-7** (BR-1): Given uma pessoa sem `media-authors`, When abre a Biblioteca, Then o nome do autor não é link, não há a lista **Autores**, e a API responde 403.
- **AC-8** (acessibilidade): Given só o teclado, When a pessoa navega da linha à página do autor e toca tudo, Then tudo funciona, o título da página e o foco inicial ficam no nome do autor, e não há violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-5 | integração + E2E | Autores do KBC-049 semeados |
| AC-3, AC-4, AC-6, AC-7 | integração (API) | Duas contas, dois acervos |
| AC-8 | E2E | axe |
| NFR-1 | integração com medição | 1.000 mídias de um autor |

## References
KBC-049 (autores livres por acervo; PR #47), KBC-051 (filtros e ordenação), KBC-053 (contexto) · Tela: `docs/design/screens.md` T16 (variação Autor) · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.6

## Decisões assumidas (o dono pode mudar)
- Sem foto, biografia ou "seguir": o acervo é fechado e pequeno; a página é para estudar a obra, não para acompanhar novidades.
- A ordem padrão da página é "Mais antigas primeiro" (seguir a obra na ordem em que foi dada), diferente da Biblioteca.

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
