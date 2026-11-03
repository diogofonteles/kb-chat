---
id: KBC-052
title: "Favoritas: favoritar um áudio ou vídeo de qualquer lugar e ter a lista \"Favoritas\" na Biblioteca"
status: ready
slice: phase-2-library
outcome: quem estuda guarda as palestras que quer rever com um toque e as encontra no topo da Biblioteca
depends_on: [KBC-051]
---

# KBC-052 — Favoritas

## Story
Como quem estuda, quero favoritar uma palestra (áudio ou vídeo) com um toque, onde quer que ela apareça, para ter as minhas preferidas reunidas e tocá-las em sequência.

## Scope
**In:** botão ♥ **Favoritar** / **Desfavoritar** na linha da Biblioteca, no player (T15), no mini-player e no resultado de mídia da busca (KBC-039); a lista **Favoritas** fixa no topo das listas da Biblioteca, com contagem e duração total; ordenar Favoritas (Adicionadas recentemente — padrão —, Título, Duração); filtro "Favoritas" nos chips da Biblioteca; **Tocar tudo** (começa pela primeira, na ordem da lista) e **Criar playlist com estas** quando houver o KBC-054.
**Out:** fila e aleatório (KBC-053; até lá, "Tocar tudo" toca a primeira e, ao fim, a próxima da lista); baixar favoritas (KBC-057); compartilhar a lista (KBC-058).

## Business rules
- BR-1: regra do dono (2026-10-28): favoritar exige a permissão nova `media-favorites` ("Favoritar mídias"), além de `media-library`; masters têm todas; convites e perfis não a concedem por padrão. Sem ela, o ♥ não aparece.
- BR-2: as favoritas são da pessoa; ninguém mais as vê, nem masters.
- BR-3: perder acesso ao acervo esconde a favorita, sem apagá-la; o acesso de volta a faz reaparecer na mesma posição de ordem.
- BR-4: se a mídia for removida, a favorita é apagada junto.
- BR-5: favoritar é idempotente: favoritar duas vezes não duplica nem muda a data de quando foi favoritada.
- BR-6: até 5.000 favoritas por pessoa; a 5.001ª é recusada com "Você chegou ao limite de 5.000 favoritas. Desfavorite alguma para continuar."

## Functional requirements
- FR-1: `PUT /api/v1/media/{id}/favorite` e `DELETE /api/v1/media/{id}/favorite` devem favoritar e desfavoritar, com as regras de acesso do stream (404 sem acesso) e 403 sem `media-favorites`. (BR-1, BR-5)
- FR-2: `GET /api/v1/media/favorites?sort=` deve listar as favoritas da pessoa em mídias que ela ainda vê, com `favoritedAt`; a lista e o detalhe da mídia devem trazer `favorite: true|false`. (BR-2, BR-3)
- FR-3: o ♥ deve mudar na hora (otimista) e, se a API falhar, voltar ao estado anterior e avisar "Não consegui favoritar. Tente de novo." numa região de status. (BR-5)
- FR-4: a Biblioteca deve mostrar **Favoritas** como a primeira lista da seção de listas, com "n mídias · h:mm", e o chip "Favoritas" filtra "Todas". (FR-6 do KBC-051)
- FR-5: **Tocar tudo** deve tocar a primeira favorita da ordem atual a partir da posição salva e, sem o KBC-053, seguir para a próxima ao terminar. (BR-2)
- FR-6: remover a mídia deve apagar as favoritas dela na mesma transação. (BR-4)

## Non-functional requirements
- NFR-1: o ♥ responde na tela em ≤ 100 ms (otimista); `PUT/DELETE …/favorite` em p95 ≤ 100 ms no teste de integração.
- NFR-2: a lista de 5.000 favoritas abre em ≤ 1 s e rola sem travar (INP ≤ 200 ms).

## Acceptance criteria
- **AC-1** (FR-1, FR-3): Given uma mídia não favorita no player, When a pessoa clica ♥, Then o botão vira "Desfavoritar" com `aria-pressed="true"` e a mídia aparece em Favoritas.
- **AC-2** (FR-4): Given três favoritas (uma de vídeo), When a pessoa abre a Biblioteca, Then vê "Favoritas · 3 mídias · 3:12:40" no topo das listas.
- **AC-3** (FR-1, BR-5): Given uma favorita de ontem, When `PUT …/favorite` é enviado de novo, Then responde 200, não há duplicata e `favoritedAt` continua o de ontem.
- **AC-4** (BR-2): Given as favoritas de outra pessoa, When alguém lista as próprias favoritas, Then não vê as dela.
- **AC-5** (BR-3): Given uma favorita num acervo que a pessoa deixou de ver, When abre Favoritas, Then ela não aparece; When o acesso volta, Then reaparece no mesmo lugar.
- **AC-6** (FR-6, BR-4): Given uma favorita, When um master remove a mídia, Then a favorita some do banco.
- **AC-7** (BR-1): Given uma pessoa sem `media-favorites`, When abre o player, Then não há ♥; When chama `PUT …/favorite`, Then recebe 403.
- **AC-8** (FR-3): Given a API fora do ar, When a pessoa clica ♥, Then o botão volta ao estado anterior e a mensagem "Não consegui favoritar. Tente de novo." é anunciada.
- **AC-9** (BR-6): Given 5.000 favoritas, When a pessoa favorita outra, Then vê a mensagem do limite e nada muda.
- **AC-10** (FR-5): Given duas favoritas curtas, When a pessoa clica **Tocar tudo**, Then toca a primeira e, ao terminar, a segunda começa sozinha.
- **AC-11** (acessibilidade): Given só o teclado, When a pessoa favorita no player, no mini-player e na linha, Then cada ♥ tem nome acessível com o título ("Favoritar Palestra de 1998"), alvo ≥ 44 px, e não há violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-10 | componente + E2E | Áudio e vídeo de teste de 10 s |
| AC-3, AC-4, AC-5, AC-6, AC-7, AC-9 | integração (API) | Duas contas; limite semeado |
| AC-8 | componente + E2E | `route.abort` |
| AC-11 | E2E | axe |
| NFR-1, NFR-2 | integração + E2E com medição | 5.000 favoritas semeadas |

## References
Tela: `docs/design/screens.md` T16 e T15 · ADR: [0022](../adr/0022-media-library-store-queue-and-streaming.md) (tabela `favorites` no `media.db`) · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.2

## Decisões assumidas (o dono pode mudar)
- O nome na tela é **Favoritas** (de "mídias favoritas"), com o ícone ♥, seguindo o pedido do dono ("salvar como favorito").
- As favoritas são uma lista própria (não uma playlist), como "Liked Songs"; "Criar playlist com estas" copia para uma playlist quando houver o KBC-054.

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
