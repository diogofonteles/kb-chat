---
id: KBC-146
title: "Busca completa por termos na tela de Buscar: todo documento com os termos, com o total e até o fim"
status: ready
slice: complete-answers
outcome: quem busca uma expressão vê a lista inteira dos documentos que a contêm, com a garantia de que nada ficou de fora
depends_on: []
---

# KBC-146 — Busca completa por termos

## Story
Como estudante, quando busco "lei do ritmo", quero poder ver todos os documentos que contêm a expressão, com o total, para ter a certeza de que vi tudo.

## Scope
**In:**
- a opção "Todas as ocorrências" na tela de Buscar, ao lado dos modos de hoje;
- a varredura literal de todos os documentos que a pessoa vê, sem diferenciar acento e maiúscula, com variantes por `|`, reaproveitando o `find_text` (ADR 0013);
- o total ("37 documentos, 112 ocorrências, 2.957 varridos"), as páginas até "Fim da lista" e os filtros de hoje.

**Out:** a busca por sentido (é ranking por natureza); exportar a lista.

## Business rules
- BR-1: a lista tem todo documento visível para a pessoa que contém os termos, e só ele (níveis, KBC-110).
- BR-2: o total e "documentos varridos" contam só o que a pessoa vê.

## Functional requirements
- FR-1: a API deve expor a busca completa (`mode: all-occurrences`) com página, total e "varridos", no contrato de `@kb-chat/contracts`. (BR-1, BR-2)
- FR-2: o web deve mostrar a opção, o total, as ocorrências com o contexto e a paginação até o fim. (BR-1)

## Non-functional requirements
- NFR-1: a primeira página sai em p95 ≤ 1,5 s no Hermetismo inteiro (2.957 documentos).

## Acceptance criteria
- AC-1 (FR-1, FR-2, BR-1): Given 29 documentos com "lei do ritmo", When busco em "Todas as ocorrências", Then vejo "29 documentos" e as páginas chegam a "Fim da lista" com os 29.
- AC-2 (BR-1, BR-2, permissão): Given Ana vê só parte do acervo, When ela busca, Then o total e a lista contam só o que ela vê, e nada de fora aparece.
- AC-3 (negativo): Given uma expressão que não existe, When busco, Then vejo "Nenhum documento contém…" com a sugestão de buscar por sentido.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | E2E | Vault de fixture, 1440 e 390 |
| AC-2 | integração | Suíte de níveis (KBC-111) |
| AC-3 | E2E | — |
| NFR-1 | medição | Vault real |

## References
ADR 0013 (`find_text`) · KBC-126 e KBC-134 (busca na v2) · `docs/research/2026-11-16-complete-answers-deep.md`

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
