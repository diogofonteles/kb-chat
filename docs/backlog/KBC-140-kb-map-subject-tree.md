---
id: KBC-140
title: "Mapa do acervo (2): árvore de assuntos fina, com sinônimos, revisada pelo dono"
status: ready
slice: complete-answers
outcome: assuntos de estudo como "Sete Princípios → Ritmo" existem com os seus sinônimos, e toda seção do acervo está em pelo menos um assunto
depends_on: [KBC-139]
---

# KBC-140 — Árvore de assuntos com sinônimos

## Story
Como estudante que não conhece o acervo, quero que a pesquisa saiba que "fluxo e refluxo" e "pêndulo" são a lei do ritmo, para achar tudo sobre o assunto mesmo sem saber as palavras que os autores usaram.

## Scope
**In:**
- a árvore por acervo em `<topic>/map/tree.json`:
  - a raiz são os conceitos do kb (`wiki/concepts`);
  - os subassuntos saem do agrupamento das proposições (KBC-139);
  - a IA dá nome, descrição, sinônimos e critério a cada nó;
- a atribuição de cada seção a um ou mais nós;
- a revisão do dono: um arquivo legível com a árvore e o número de seções por nó, e um formato de correção (renomear, fundir, mover, apagar) aplicado pela ferramenta;
- a fila de revisão para nós propostos;
- o `index.md` do acervo gerado da árvore (padrão LLM Wiki, análise §2a): um catálogo por categoria, com uma linha por página e o número de fontes, que a IA lê primeiro e o estudante usa como sumário.

**Out:** a tela de revisão no app (a revisão é pelo arquivo, nesta versão); o dossiê (KBC-141).

## Business rules
- BR-1: toda seção `ok` está em pelo menos um nó folha, ou fica `a-revisar` no nó mais próximo.
- BR-2: um nó tem entre 3 e 300 seções. Acima disso, o nó é dividido; abaixo, é fundido com o vizinho, a menos que o dono o fixe.
- BR-3: os nomes e as fusões que o dono corrige são fixos: uma reconstrução não os desfaz.
- BR-4: sinônimos são expressões que aparecem no acervo e significam o assunto, sem tradução livre.

## Functional requirements
- FR-1: `kb-map tree build <topic>` deve gerar a árvore e a atribuição das seções, e `kb-map tree review <topic>` deve gerar o arquivo de revisão. (BR-1, BR-2)
- FR-2: `kb-map tree apply <topic> <corrections>` deve aplicar as correções do dono e marcá-las como fixas. (BR-3)
- FR-3: cada nó deve ter `id` estável, `name`, `description`, `synonyms[]`, `criterion`, `parent` e a contagem de seções. (BR-4)

## Non-functional requirements
- NFR-1: a reconstrução incremental (100 seções novas) leva ≤ 10 min na assinatura e não muda os `id` dos nós que já existiam.

## Acceptance criteria
- AC-1 (FR-1, BR-1): Given as seções de fixture com textos sobre ritmo, polaridade e vibração, When a árvore é gerada, Then existem os três nós sob "Sete Princípios", e toda seção está em algum nó.
- AC-2 (FR-3, BR-4): Given seções que dizem "fluxo e refluxo" e "lei do ritmo", When a árvore é gerada, Then o nó Ritmo tem os dois como sinônimos.
- AC-3 (FR-2, BR-3): Given o dono renomeou um nó e fundiu dois, When a árvore é reconstruída, Then o nome e a fusão continuam.
- AC-4 (BR-2): Given um nó com 400 seções, When a árvore é gerada, Then ele é dividido em subnós.
- AC-5 (negativo): Given uma seção que não cabe em nenhum nó, When a atribuição roda, Then ela fica `a-revisar` no nó mais próximo e uma proposta de nó novo entra na fila.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1–AC-5 | unitário (pytest) | Provedor fake; agrupamento determinístico com semente |
| Revisão real | manual | O dono revisa a árvore do piloto (KBC-143) |

## References
`docs/research/2026-11-16-complete-answers-deep.md` §3 · RAPTOR e GraphRAG (agrupamento e resumos por nível) · `wiki/concepts` do kb

## Decisões assumidas (o dono pode mudar)
- A revisão do dono é pelo arquivo nesta versão; a tela vem com a Página do assunto (KBC-137), se o dono quiser.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
