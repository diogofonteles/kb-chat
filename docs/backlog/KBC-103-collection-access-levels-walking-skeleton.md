---
id: KBC-103
title: "Níveis de acesso por acervo (esqueleto): o master cria a escala, escolhe o nível de cada pessoa e de cada documento, e a busca e a leitura só mostram o que está no nível da pessoa"
status: ready
slice: levels-walking-skeleton
outcome: num acervo com níveis, um membro nunca vê título, trecho, contagem ou "Veja também" de documento acima do seu nível; nada muda nos acervos sem níveis
depends_on: []
parent: LEVELS
---

# KBC-103 — Níveis de acesso por acervo (esqueleto)

## Story
Como master de um acervo, quero cadastrar níveis ordenados (ex.: QS, CI, CDC, QM, QM+), dar um nível a cada pessoa e a cada documento, para que cada um só encontre e leia o que corresponde ao seu nível.

## Scope
**In:** página **Níveis de acesso** do acervo (T24, só masters): criar nível (código e descrição), renomear, mover para cima/baixo; na criação da primeira escala, todo documento e mídia do acervo (e dos sub-acervos) e toda pessoa com acesso recebem o nível mais baixo; editor da pessoa (T9) com **Nível** por acervo de topo que tenha escala; no painel do documento (T3), para masters, o selo do nível e **Mudar nível**; módulo `access-levels` com a regra (ADR 0036 §6) e a `LevelView`; filtro na busca de documentos (itens, trechos, cópias, total, `capped`, facetas do resultado) com o orçamento adaptativo, nas facetas do acervo, nas sugestões iniciais, na contagem da lista de acervos, ao abrir um documento, no "Veja também" e na página de relação; documento sem nível ("Sem nível") visível só a masters, com a contagem na T24; auditoria `audit/levels-YYYY-MM.jsonl` de toda escrita; **falha fechada**: num acervo com níveis, para quem não é master, a pesquisa com IA responde `LEVELS_PENDING` e a mídia do acervo não aparece, até o KBC-104 e o KBC-105.
**Out:** IA (KBC-104), mídia (KBC-105, KBC-106), fila "Sem nível" e lote (KBC-107), convites e perfis (KBC-109), apagar nível e histórico na tela (KBC-108), conversas guardadas (KBC-110).

## Business rules
- BR-1: a escala é de um acervo de topo; um sub-acervo usa a do pai. Um acervo sem níveis se comporta como hoje.
- BR-2: o código tem até 12 caracteres, é único na escala (sem diferenciar maiúsculas e acentos); o id vem do código e não muda ao renomear.
- BR-3: um nível vê tudo o que está nele e abaixo dele; a ordem da lista é a hierarquia (o primeiro é o mais baixo).
- BR-4: ao criar a primeira escala de um acervo, todo conteúdo existente dele e dos sub-acervos e toda pessoa com acesso recebem o nível mais baixo, numa só operação auditada.
- BR-5: pessoa com acesso e sem nível (ou com um nível que não existe mais) tem o nível mais baixo. Masters veem tudo; agindo como uma pessoa, vale o nível dela.
- BR-6: documento sem nível num acervo com escala só aparece para masters.
- BR-7: item que a pessoa não pode ver responde como inexistente (404), nunca 403.
- BR-8: nenhuma contagem, faceta, total, `capped`, número de cópias, título de cópia ou relação considera itens que a pessoa não vê.
- BR-9: só masters gerem escalas, níveis de pessoas e (neste item) níveis de documentos. Permissão nova `collection-levels` ("Gerenciar níveis de acesso"), só de masters.
- BR-10: até o KBC-104/KBC-105, num acervo com escala, a pesquisa com IA e a mídia ficam fechadas para quem não é master.

## Functional requirements
- FR-1: `GET/POST/PATCH /api/v1/topics/:topic/levels` (masters): listar, criar, renomear e reordenar (`{ order: levelId[] }`); 404 para acervo invisível, 403 para não-master, 409 `LEVEL_CODE_TAKEN`. (BR-1, BR-2, BR-9)
- FR-2: a primeira criação grava `access-levels.json`, `document-levels.json` com todos os documentos do escopo, e o nível mais baixo nas pessoas com acesso, e uma entrada `bulk` na auditoria. (BR-4)
- FR-3: `PATCH /api/v1/people/:id` aceita `levels: { [topSlug]: levelId }`; nível de outro acervo ou inexistente → 400 `VALIDATION_FAILED`. (BR-5)
- FR-4: `PUT /api/v1/topics/:topic/documents/:id/level` (masters) muda o nível de um documento e audita antes → depois. (BR-9)
- FR-5: `ContentGate.viewFor(viewer, topic)` devolve a `LevelView`; `SearchService`, `topicFacets`, sugestões, `toTopic`, `getDocument` e `relationPage` passam a recebê-la. (BR-3, BR-6, BR-8)
- FR-6: `keepCataloged` filtra pela visão antes de agrupar, e a busca pede `min(1000, ceil(base / visibleShare))` candidatos, com uma segunda chamada (× 4, mesmo teto) quando a página vem curta e o índice devolveu o limite. (BR-8)
- FR-7: abrir um documento invisível responde 404 `DOCUMENT_NOT_FOUND`. (BR-7)
- FR-8: `/api/v1/me` traz, por acervo de topo com escala, o código do nível da pessoa; para masters, `levelsManager: true`. (BR-5)
- FR-9: `POST …/research` num acervo com escala, para não-master, responde 409 `LEVELS_PENDING`; `GET /topics/:topic/media`, a Biblioteca, "Na fala" e `GET /media/:id` tratam itens desse acervo como inexistentes para não-masters. (BR-10)
- FR-10: toda escrita de FR-1 a FR-4 é anexada a `audit/levels-YYYY-MM.jsonl` com quem (e quem agia como quem), quando, o quê, antes e depois. (BR-9)
- FR-11: a web mostra a T24, o campo **Nível** no editor da pessoa e o selo/**Mudar nível** no painel do documento para masters.

## Non-functional requirements
- NFR-1: construir a `LevelView` de um acervo com 10.000 documentos leva p95 ≤ 5 ms (memoizada por versão), medido por teste de desempenho no vault sintético.
- NFR-2: num acervo sem escala, a latência p95 da busca não muda mais que 5 % (script `latency`, 20 perguntas por modo).
- NFR-3: uma mudança de nível vale na próxima requisição (≤ 1 s), sem reiniciar; o cache de pessoas é atualizado na escrita.

## Acceptance criteria
- **AC-1** (FR-1, FR-2, BR-4): Given o acervo "hermetismo" sem escala, com 6 documentos e 2 membros, When o master cria "QS", Then os 6 documentos e os 2 membros ficam em QS, a auditoria tem uma entrada `bulk` com 6 itens e 2 pessoas, e a busca dos membros devolve o mesmo que antes.
- **AC-2** (BR-3, FR-6): Given a escala QS < CI < CDC, 2 documentos em cada nível e Ana em CI, When Ana busca um termo presente nos 6, Then vê só os 4 de QS e CI, `total` = 4, as facetas contam 4 e nenhum título de CDC aparece no corpo da resposta.
- **AC-3** (BR-8, negativo): Given um grupo de cópias com um membro em QS e outro em CDC, When Ana (CI) busca, Then o resultado não diz "2 cópias" nem traz o título da cópia em CDC.
- **AC-4** (BR-7, FR-7): Given um documento em CDC, When Ana abre o id direto, Then 404 `DOCUMENT_NOT_FOUND`, igual a um id que não existe.
- **AC-5** (BR-8): Given um documento CI ligado a um CDC por `kb link`, When Ana abre o CI, Then "Veja também" não lista o CDC e o total do grupo não o conta; a página da relação também não.
- **AC-6** (BR-8): Given o acervo com 2 documentos visíveis a Ana, When ela lista os acervos e as facetas/sugestões, Then `documentCount` = 2 e nenhuma faceta conta os ocultos.
- **AC-7** (BR-5): Given Bia com acesso e sem nível, When busca, Then vê como QS; Given o master põe Bia em CDC, When ela busca de novo, Then vê os 6, sem reiniciar.
- **AC-8** (BR-5, master): Given o master, When busca, Then vê os 6; When age como Ana, Then vê os 4.
- **AC-9** (BR-6): Given um documento novo no vault sem nível, When Ana busca, Then não o vê; When o master busca, Then vê com o selo "Sem nível", e a T24 diz "1 documento sem nível".
- **AC-10** (BR-1): Given o sub-acervo `hermetismo/aulas`, Then ele não tem escala própria; o nível de Ana em "hermetismo" vale nele, e a busca no pai respeita o nível nos dois.
- **AC-11** (BR-2): Given "CI" existe, When o master cria "ci", Then 409 com "Já existe um nível com o código CI."; When renomeia CI para "C.I.", Then o id continua `ci` e os itens continuam nele.
- **AC-12** (BR-3, reordenar): Given QS < CI < CDC, When o master move CDC para baixo de CI, Then Ana (CI) passa a ver os de CDC na próxima busca, e a auditoria registra a ordem antes e depois.
- **AC-13** (BR-9, permissão): Given um membro, When chama `POST …/levels`, `PUT …/documents/:id/level` ou `PATCH /people/:id`, Then 403; num acervo que não vê, 404.
- **AC-14** (BR-10): Given um acervo com escala, When Ana pede uma pesquisa com IA, Then 409 `LEVELS_PENDING` e a tela diz "A pesquisa com IA ainda não está disponível neste acervo."; e a mídia do acervo não aparece para ela; o master usa as duas.
- **AC-15** (sem regressão): Given um acervo sem escala, Then todos os testes de busca, documento, facetas e sugestões existentes passam sem mudança.
- **AC-16** (orçamento adaptativo): Given um acervo de 1.000 documentos com só 50 visíveis a Ana e 12 deles com o termo, When ela busca, Then recebe os 12 (o pedido ao índice cresce, até 1.000).
- **AC-17** (FR-11, UI): Given a T24 em 1440 px e 390 px, Then criar, renomear e mover funcionam por teclado e toque, com os estados vazio, carregando, erro e "Sem nível (N)".

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-11, AC-12, AC-13 | integração | `access-levels.integration.test.ts` com diretório de estado temporário e vault de fixture |
| AC-2 a AC-10, AC-16 | integração | `search-levels.integration.test.ts`: duas pessoas, índice de fixture; a asserção de AC-2/3/5 procura os títulos ocultos no JSON inteiro |
| regra, ranks, padrões, orçamento | unidade | `level-view.test.ts`, `candidate-budget.test.ts` (fast-check: visível nunca contém oculto) |
| AC-14 | integração + E2E | rota de pesquisa e mídia com escala; `e2e/specs/levels.spec.ts` |
| AC-15 | existentes | sem mudança |
| AC-17 | E2E + componente | `levels-page.spec.ts`, `person-editor.spec.ts`, 1440 e 390, axe |
| NFR-1 a NFR-3 | script/teste | `level-view.bench.ts`; `pnpm --filter @kb-chat/api latency` antes e depois |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §1–§7, §9, §11 · [0028](../adr/0028-app-owned-collections-and-sub-collections.md) · [0008](../adr/0008-google-login-and-permissions.md) · Telas T24 (nova), T9, T3 em `docs/design/screens.md` · Contratos: `libs/contracts/src/auth.ts`, novo `libs/contracts/src/access-levels.ts`.

## Open questions
Resolvidas em 2026-11-07 (dono, conversa: "aprovo todos"), com o padrão recomendado:
- Conteúdo existente vai para o nível mais baixo quando a escala é criada (ADR 0036 §4).
- Pessoa com acesso e sem nível fica no nível mais baixo.
- Documento novo sem nível fica só com masters (e com quem tem `content-levels`, KBC-107).
- Sub-acervo usa a escala do acervo pai.
- Membros não veem selos de nível.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Sem dependências abertas
- [x] Cabe num goal (UI mínima; gestão completa no KBC-108)
