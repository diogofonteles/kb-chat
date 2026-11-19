---
id: KBC-137
title: "Página do assunto: prateleiras com os documentos centrais, aprofundamentos, relacionados e áudios do assunto"
status: ready
slice: ui-v2-features
outcome: quem toca num assunto estuda o tema por inteiro, não só a lista filtrada da busca
depends_on: [KBC-127]
---

# KBC-137 — Página do assunto

## Story
Quando toco num assunto (como "Cabala") num documento ou na home, quero uma página do assunto com o que há de central, o que aprofunda e o que se relaciona, para estudar o tema por inteiro.

## Scope
**In:** página `/assunto/:id` com cabeçalho de capa (sigla e cor), contagem de documentos, "Buscar neste assunto" e "Perguntar à IA sobre <assunto>"; prateleiras: Centrais (ligação "Central"), Para aprofundar (profundidade ≥ Aprofundado), Relacionados ("Relacionado" e "Material de estudo"), Na fala (faixas do assunto, só com áudio no acervo), Assuntos próximos; "Ver tudo" de cada prateleira abre a busca filtrada; entrada pelos chips de assunto do documento, pelos cartões "Comece por um assunto" e pelas sugestões (KBC-134).
**Out:** editar assuntos (vem do kb); assuntos entre acervos.

## Business rules
- BR-1: as prateleiras usam só as facetas que o kb já produz (concepts, relevance, depth) e respeitam o acesso e o nível de hoje.
- BR-2: "Fora do tema" nunca entra nas prateleiras.
- BR-3: uma prateleira vazia não aparece; com tudo vazio, a página mostra o estado vazio com "Buscar neste assunto".

## Functional requirements
- FR-1: a API deve ter `GET /api/v1/topics/:topic/subjects/:subject` com as prateleiras (até 10 itens cada) e a contagem total, filtradas por acesso e nível. (BR-1, BR-2)
- FR-2: o web deve mostrar as prateleiras em linha rolável (desktop) e em lista (celular), cada uma com "Ver tudo". (BR-3)
- FR-3: os chips de assunto do documento e os cartões de assunto da home devem abrir esta página (hoje filtram a busca). (BR-1)

## Non-functional requirements
- NFR-1: a página responde em p95 ≤ 300 ms no vault de fixture grande.
- NFR-2: axe sem violação séria; as prateleiras são listas com rótulo.

## Acceptance criteria
- AC-1 (FR-1, FR-2): Given o assunto Cabala no Hermetismo, When a página abre, Then mostra "A Árvore da Vida" em Centrais e as demais prateleiras conforme as facetas, como em `chat-document-see-also` (captura).
- AC-2 (BR-2): Given um documento "Fora do tema" com o assunto, When a página abre, Then ele não aparece.
- AC-3 (BR-1, negativo): Given um documento acima do nível da pessoa, When ela abre a página, Then ele não aparece nem entra na contagem.
- AC-4 (FR-2): Given a prateleira Centrais, When a pessoa toca "Ver tudo", Then abre a busca com o filtro do assunto e de ligação Central.
- AC-5 (BR-3): Given um assunto sem documentos visíveis, When a página abre, Then mostra o estado vazio com "Buscar neste assunto".
- AC-6 (FR-3): Given um documento com o chip Cabala, When a pessoa o toca, Then abre a página do assunto.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-4, AC-6 | E2E + captura | Vault de fixture |
| AC-2, AC-3, AC-5 | integração (API) | Níveis |
| NFR-1 | script de latência | |

## References
Figma: [v2 · Conversa](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=376-2) (`chat-document-see-also`: o assunto como página com prateleiras) · Plano: `docs/design/redesign-v2.md` · Telas v1: T3 (Veja também) · KBC-003, KBC-002

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
