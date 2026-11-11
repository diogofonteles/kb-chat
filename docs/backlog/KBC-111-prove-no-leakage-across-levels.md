---
id: KBC-111
title: "Prova de que nada vaza entre níveis: suíte de vazamento em todas as rotas e eventos, teste de fronteira no CI, recall e latência do orçamento adaptativo e o modelo de ameaças"
status: ready
slice: levels-release-2
outcome: qualquer superfície nova ou antiga que exponha conteúdo acima do nível de alguém falha no CI antes de chegar à produção
depends_on: [KBC-104, KBC-105, KBC-106, KBC-110]
parent: LEVELS
---

# KBC-111 — Prova de não vazamento

## Story
Como dono, quero uma prova automática de que nenhuma parte do app revela conteúdo acima do nível de quem acessa, para confiar nos níveis hoje e depois de cada nova funcionalidade.

## Scope
**In:** suíte de vazamento: percorre toda rota `/api/v1` com `topicParam` ou que devolve conteúdo (lista gerada do registro de rotas, como o `route-access.test.ts`) e todo evento SSE da pesquisa, com Ana (CI) e um vault + `media.db` de fixture com itens "sentinela" em CDC cujos títulos, ids e textos têm marcas únicas, e falha se uma marca aparecer; teste de fronteira (lint/arquitetura) que recusa importar `CatalogRegistry.get/scope` ou as listas do `media-store` fora de `catalog`, `access-levels` e da raiz de composição; script de recall@10 e latência do orçamento adaptativo com fatias visíveis de 100 %, 50 %, 20 % e 5 %; modelo de ameaças dos níveis em `docs/architecture/overview.md`; regra registrada para as funcionalidades ainda não construídas (playlists, compartilhamento, Favoritas, fila, offline com o motivo `level`).
**Out:** coleção do QMD por nível (só se o recall falhar; ADR 0036 opção 3, novo item).

## Business rules
- BR-1: nenhuma resposta ou evento a uma pessoa contém id, título, trecho, autor ou contagem que inclua um item que ela não vê.
- BR-2: toda rota nova que devolve conteúdo entra na suíte sozinha (pela lista de rotas); uma rota fora dela precisa de exceção declarada com motivo.
- BR-3: só os módulos permitidos leem o catálogo e as listas de mídia sem a `LevelView`.

## Functional requirements
- FR-1: `levels-leakage.integration.test.ts` gera as chamadas pelas rotas registradas e confere as marcas sentinela no corpo e nos eventos. (BR-1, BR-2)
- FR-2: regra de fronteira no ESLint (`boundaries`) ou teste de arquitetura para BR-3. (BR-3)
- FR-3: `src/scripts/levels-recall.ts` mede recall@10 (oráculo: busca do master filtrada só pelos visíveis, com orçamento ilimitado) e p95 por modo e fatia. (NFR-1, NFR-2)
- FR-4: seção "Access levels" no modelo de ameaças da arquitetura e nota no README do backlog sobre KBC-052 a KBC-058.

## Non-functional requirements
- NFR-1: recall@10 ≥ 0,95 nas fatias de 20 % e 50 % e ≥ 0,90 na de 5 %, com 20 perguntas reais por modo no vault de fixture ampliado.
- NFR-2: p95 da busca com fatia de 20 % ≤ 1,25 × o p95 sem escala, em cada modo (Q1/Q2).
- NFR-3: a suíte roda em ≤ 60 s no CI.

## Acceptance criteria
- **AC-1** (BR-1): Given a suíte com Ana (CI), Then nenhuma marca sentinela de CDC aparece em nenhuma rota nem evento; Given o master, Then todas aparecem onde devem (controle positivo).
- **AC-2** (BR-2, negativo): Given uma rota de teste nova que devolve o título de qualquer documento sem a visão, When a suíte roda, Then falha nomeando a rota.
- **AC-3** (BR-3): Given um arquivo de `modules/search` que importa `CatalogRegistry.get`, When o lint roda, Then falha com a regra.
- **AC-4** (NFR-1, NFR-2): Given o script, Then o relatório em `work/KBC-111/` traz recall e p95 por modo e fatia dentro dos limites; se não, o item abre um novo item para a opção 3 da ADR e não fecha.
- **AC-5** (canais laterais): Given um grupo de cópias, uma relação, um repetido no envio, a cobertura do Exaustivo e "Ver todas (N)" com itens ocultos, Then nenhuma contagem difere da de um acervo onde esses itens não existem.
- **AC-6** (FR-4): Given a arquitetura, Then o modelo de ameaças dos níveis responde às quatro perguntas e cita os testes.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-5 | integração | suíte gerada pelas rotas; fixtures sentinela |
| AC-3 | lint | regra de fronteira com caso de teste |
| AC-4 | script | relatório anexado |
| AC-6 | revisão | `software-architect` |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §7, §12 · `docs/architecture/overview.md` (modelo de ameaças, funções de aptidão) · `apps/api/src/plugins/route-access.ts`.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR referenciada (sem tela)
- [x] Depende de KBC-104, 105, 106 e 110
- [x] Cabe num goal
