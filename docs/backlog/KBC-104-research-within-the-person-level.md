---
id: KBC-104
title: "A pesquisa com IA só usa o que está no nível da pessoa: ferramentas, Exaustivo, cobertura e as IAs externas (Claude cedido, Codex) pelo MCP do turno"
status: ready
slice: levels-release-1
outcome: num acervo com níveis, nenhuma resposta, fonte, passo ou cobertura da IA cita ou conta um documento acima do nível de quem pergunta
depends_on: [KBC-103]
parent: LEVELS
---

# KBC-104 — Pesquisa com IA no nível da pessoa

## Story
Como membro de nível CI, quero perguntar à IA sobre o acervo e receber respostas baseadas só no que posso ler, para que a pesquisa respeite o meu nível como a busca.

## Scope
**In:** `ResearchToolsFactory` com a `LevelView` do turno (ADR 0036 §7): `search_collection` (mesma busca do KBC-103), `list_subjects`, `read_document(s)`, `related_documents`, `list_sources`, `find_text`/grep (o corpo dobrado continua compartilhado; o conjunto entregue é o da visão), `resolveEntry` pela visão; Exaustivo: `targetSet`, lotes, cobertura e "Continuar varredura" (cursor do cliente revalidado); ids citados num follow-up revalidados; ferramentas do token MCP do turno (Claude cedido, Codex pelo runner) construídas com a visão; tira o `LEVELS_PENDING` do KBC-103.
**Out:** conversas já guardadas (KBC-110); faixas como documentos (KBC-106/KBC-099).

## Business rules
- BR-1: toda ferramenta da IA vê exatamente a `LevelView` de quem pergunta (ou da pessoa por quem o master age).
- BR-2: um id oculto pedido por uma ferramenta é tratado como inexistente ("documento não encontrado"), igual a um id inventado.
- BR-3: a cobertura do Exaustivo conta só o conjunto visível ("N documentos no conjunto" = documentos visíveis).
- BR-4: um cursor de varredura ou um follow-up com ids que a pessoa não vê mais segue sem eles; achados ocultos são descartados e a cobertura é recontada.
- BR-5: uma IA externa (assinatura cedida, Codex) alcança só as ferramentas do turno, com a mesma visão.
- BR-6: os passos mostrados ("Lendo …", "Buscando …") e o evento `sources` nunca nomeiam um documento oculto.

## Functional requirements
- FR-1: `ResearchToolsFactory = (topic, view) => …`; `TurnResearchTools` e `tool-context.ts` levam a visão. (BR-1)
- FR-2: `resolveEntry`, `read_document(s)` e `related_documents` recusam id fora da visão com a mesma saída de um id inexistente. (BR-2)
- FR-3: `SweepPlanner.targetSet` e `measureSweep` usam `view.entries(scope)`; `sweepCoverageSchema` não muda. (BR-3)
- FR-4: ao receber `sweep` ou `history`, a rota revalida `findings[].id` e ids citados contra a visão antes do primeiro passo. (BR-4)
- FR-5: `mcp-turns.ts` cria as ferramentas do token com a visão do turno; `serveKbMcpStdio` sem pessoa recusa acervos com escala. (BR-5)
- FR-6: `POST …/research` num acervo com escala volta a atender não-masters. (BR-1)

## Non-functional requirements
- NFR-1: a filtragem acrescenta p95 ≤ 10 ms por chamada de ferramenta num acervo de 10.000 documentos (teste de desempenho sem modelo).
- NFR-2: a estimativa do Exaustivo continua exata (pedidos previstos = feitos ± 1) num acervo com 50 % do conjunto oculto.

## Acceptance criteria
- **AC-1** (BR-1, FR-1): Given QS < CI < CDC, 2 documentos por nível com o termo "lua" e Ana em CI, When Ana pergunta "o que dizem sobre a lua?" com o stub do modelo, Then `search_collection`, `find_text` e `list_sources` devolvem só os 4 de QS e CI, e nenhum evento SSE contém um título ou id de CDC.
- **AC-2** (BR-2, negativo): Given o stub pede `read_document` do id de um documento CDC, Then a ferramenta responde "documento não encontrado" com o mesmo texto de um id inexistente.
- **AC-3** (BR-3): Given o Exaustivo no mesmo acervo, Then a cobertura diz "4 documentos no conjunto" para Ana e "6" para o master.
- **AC-4** (BR-4): Given uma varredura de Ana parada com um achado num documento que depois foi para CDC, When **Continuar varredura**, Then o achado some, a cobertura é recontada e a resposta não o cita.
- **AC-5** (BR-5): Given Ana servida pela assinatura do Claude cedida (runner stub) ou pelo Codex pelo runner, When o modelo chama as ferramentas MCP do turno, Then vê só os 4.
- **AC-6** (BR-6): Given o stub tenta citar `[n]` de um id oculto, Then a fonte não é emitida e a resposta registra a citação como inválida, como hoje para um id não lido.
- **AC-7** (BR-1, master agindo): Given o master agindo como Ana, Then a pesquisa vê os 4; sem agir, vê os 6.
- **AC-8** (FR-6): Given Ana num acervo com escala, Then a pesquisa com IA aparece de novo e não responde `LEVELS_PENDING`.
- **AC-9** (sem regressão): Given acervos sem escala, Then os testes de pesquisa, Exaustivo e MCP existentes passam sem mudança.
- **AC-10** (sub-acervo): Given um documento CDC no sub-acervo, When Ana pesquisa no pai, Then `find_text` e a varredura não o acham.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-6, AC-10 | integração | `research-levels.integration.test.ts` com stub de modelo; asserção sobre todos os eventos SSE |
| AC-3, AC-4 | integração | `sweep-levels.integration.test.ts` |
| AC-5 | integração | runners stub (`cli-runners.test.ts`, MCP por token) |
| AC-7, AC-8 | integração + E2E | `e2e/specs/levels.spec.ts` estendido |
| AC-9 | existentes | sem mudança |
| NFR-1, NFR-2 | teste de desempenho | evidência em `work/KBC-104/` |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §7–§8 · [0006](../adr/0006-research-agent-over-kb-tools.md), [0013](../adr/0013-exhaustive-research-grep-tools-and-compaction.md), [0019](../adr/0019-lend-owner-claude-subscription.md), [0020](../adr/0020-sandboxed-codex-runner.md), [0021](../adr/0021-app-driven-exhaustive-sweep.md) · Tela T4 sem mudança visual.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-103
- [x] Cabe num goal
