---
id: KBC-107
title: "Documentos novos sem nível: a fila \"Sem nível\", classificar em lote por filtro ou seleção, e a permissão \"Classificar nível de conteúdo\""
status: ready
slice: levels-release-1
outcome: todo documento que chega do kb num acervo com níveis recebe nível em poucos cliques, e a fila "Sem nível" volta a zero em até 7 dias depois de cada sincronização
depends_on: [KBC-103]
parent: LEVELS
---

# KBC-107 — Documentos sem nível e classificação em lote

## Story
Como master (ou quem classifica conteúdo), quero ver os documentos que chegaram do kb sem nível e classificá-los em lote, para cumprir a regra de que todo conteúdo inserido tem nível sem abrir documento por documento.

## Scope
**In:** na T24, a seção **Sem nível (N)**: lista paginada com título, sub-acervo, origem, autoria e "chegou em"; filtros (sub-acervo, origem, autoria, pasta do vault, "chegou desde"); seleção por linha, "Selecionar os N filtrados" e **Dar nível** com confirmação ("Dar o nível CI a 37 documentos?"); mesma ação em lote sobre documentos já classificados ("Mudar nível" na busca de documentos do acervo, para masters e quem classifica); permissão nova `content-levels` ("Classificar nível de conteúdo"), dada por pessoa, que permite classificar e mudar documentos até o próprio nível e vê a fila e os selos; aviso na lateral para masters "N documentos sem nível" no acervo; auditoria `bulk` com o filtro.
**Out:** escolher o nível no Mac/frontmatter (ADR 0036 opção 2); um "nível padrão para documentos novos" (o dono decidiu em 2026-11-07 que o documento novo fica fechado até ser classificado).

## Business rules
- BR-1: documento sem nível só aparece para masters e para quem tem `content-levels` naquele acervo (KBC-103 BR-6, ampliado).
- BR-2: quem tem `content-levels` classifica e muda documentos só para o seu nível ou abaixo, e só documentos que vê ou que estão sem nível.
- BR-3: a classificação em lote vale para o conjunto filtrado no momento da confirmação; documentos que chegarem depois não entram.
- BR-4: cada lote gera uma entrada `bulk` na auditoria com quem, quando, o nível, a contagem e o filtro, e uma entrada por documento com antes → depois.
- BR-5: um documento que sai do vault (removido no Mac) sai da fila e mantém a linha em `document-levels.json` por 30 dias (volta com o mesmo nível se reaparecer no mesmo caminho).

## Functional requirements
- FR-1: `GET /api/v1/topics/:topic/levels/unassigned?filters&cursor` (masters e `content-levels`) com paginação opaca (10, máx. 50). (BR-1)
- FR-2: `POST /api/v1/topics/:topic/document-levels` com `{ level, ids? | filter? }` aplica em lote; recusa nível acima do de quem chama (403) e ids invisíveis (ignorados e contados em `skipped`). (BR-2, BR-3)
- FR-3: `content-levels` entra em `FEATURES`, aparece no editor da pessoa (T9) e nunca liga sozinha. (BR-2)
- FR-4: as escritas geram as entradas de auditoria de BR-4. (BR-4)
- FR-5: o catálogo marca `firstSeenAt` de cada documento novo num acervo com escala; a limpeza de 30 dias roda na carga. (BR-5)
- FR-6: a web mostra a seção **Sem nível**, a seleção em lote e o aviso na lateral.

## Non-functional requirements
- NFR-1: classificar 2.000 documentos num lote leva ≤ 2 s e uma escrita atômica de `document-levels.json`.
- NFR-2: a lista "Sem nível" com 5.000 itens responde p95 ≤ 150 ms por página.

## Acceptance criteria
- **AC-1** (BR-1, FR-1): Given 40 documentos novos sem nível, When o master abre a T24, Then vê "Sem nível (40)" com a lista; Ana (CI, sem `content-levels`) não vê a seção e a rota responde 403.
- **AC-2** (BR-3, FR-2): Given o filtro "origem: Áudio", 12 documentos, When o master escolhe "Selecionar os 12 filtrados" e **Dar nível** CI, Then os 12 vão para CI, a fila diz 28 e Ana passa a achá-los.
- **AC-3** (BR-3, borda): Given 3 documentos novos chegam entre o filtro e a confirmação, Then eles continuam sem nível.
- **AC-4** (BR-2, negativo): Given Caio com `content-levels` e nível CI, When tenta dar CDC, Then 403 e a opção CDC não aparece na tela.
- **AC-5** (BR-2): Given Caio, When muda em lote documentos de QS para CI, Then funciona; documentos CDC não aparecem para ele e, se enviados por id, vêm em `skipped`.
- **AC-6** (BR-4): Given o lote de AC-2, Then a auditoria tem 1 entrada `bulk` com o filtro e 12 entradas por documento.
- **AC-7** (BR-5): Given um documento CI removido no Mac e devolvido no mesmo caminho em 10 dias, Then volta em CI; depois de 31 dias, volta sem nível.
- **AC-8** (FR-6, UI): Given 390 px, Then a seleção em lote funciona por toque, com o botão fixo no rodapé e a confirmação na linha (MA-27).
- **AC-9** (vazio): Given nenhum documento sem nível, Then a seção diz "Todos os documentos têm nível." e o aviso da lateral some.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-7 | integração | `document-levels.integration.test.ts` com relógio fixo |
| AC-8, AC-9 | E2E | `e2e/specs/levels.spec.ts`, 1440 e 390, axe |
| NFR-1, NFR-2 | teste de desempenho | vault sintético de 5.000 documentos |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §3, §5, §9, §11 · Tela T24 (seção "Sem nível") · Regra de permissão por funcionalidade (definição de pronto global).

## Open questions
Resolvidas em 2026-11-07 (dono, conversa: "aprovo todos"), com o padrão recomendado:
- Documento novo fica fechado até ser classificado (sem "nível padrão para documentos novos" por acervo).

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-103
- [x] Cabe num goal
