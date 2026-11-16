---
id: KBC-134
title: "Busca global na barra superior: sugestões enquanto digita, buscas recentes e navegação pelo teclado"
status: ready
slice: ui-v2-features
outcome: quem busca chega ao documento, ao acervo ou à mídia antes de terminar de digitar; menos buscas sem resultado
depends_on: [KBC-125]
---

# KBC-134 — Busca global com sugestões e recentes

## Story
Quando começo a digitar na busca do topo, quero ver sugestões de documentos, assuntos, acervos e mídias e as minhas buscas recentes, para ir direto ao que quero com o teclado.

## Scope
**In:** ao focar a busca vazia: até 8 buscas recentes (com remover uma e "Limpar"); ao digitar (≥ 2 letras): grupos Documentos (título), Assuntos, Acervos e Mídias (só com áudio no acervo), até 5 por grupo, com o termo destacado; ↑ ↓ Enter Esc; Enter sem sugestão escolhida faz a busca completa; a última linha "Perguntar à IA: <texto>" abre a Pesquisa com IA; no celular, a aba Buscar mostra o mesmo.
**Out:** correção ortográfica; busca em outros acervos que a pessoa não vê.

## Business rules
- BR-1: as sugestões só trazem o que a pessoa pode ver hoje (acervos, permissões e nível, KBC-103).
- BR-2: as buscas recentes são da conta (aparecem em outro aparelho), guardam no máximo 50 e não guardam buscas feitas em "Ver como".
- BR-3: as sugestões casam pelo título e pelos nomes (sem busca semântica), para responder rápido.

## Functional requirements
- FR-1: a API deve ter `GET /api/v1/search/suggest?q=&topic=` que devolve os grupos com até 5 itens cada, filtrados por acesso e nível. (BR-1, BR-3)
- FR-2: a API deve guardar e devolver as buscas recentes da pessoa (`GET/DELETE /api/v1/search/recent`), com o limite de 50. (BR-2)
- FR-3: o web deve mostrar o painel de sugestões sob a busca, com debounce de 150 ms e cancelamento da requisição anterior, e navegação completa pelo teclado (combobox ARIA).
- FR-4: escolher uma sugestão abre o alvo (documento, assunto, acervo, mídia); Enter sem escolha faz a busca completa e grava em recentes. (BR-2)

## Non-functional requirements
- NFR-1: `suggest` p95 ≤ 150 ms no acervo de fixture grande (2.000 documentos), medido no script de latência.
- NFR-2: o painel segue o padrão combobox da WAI-ARIA e o axe não aponta violação séria.

## Acceptance criteria
- AC-1 (FR-3, FR-1): Given o acervo Hermetismo, When a pessoa digita "rit", Then vê "A Lei do Ritmo" em Documentos e "Ritmo" em Assuntos, com "rit" destacado.
- AC-2 (FR-3): Given as sugestões abertas, When a pessoa usa ↓ ↓ Enter, Then abre o segundo item; Esc fecha e devolve o foco ao campo.
- AC-3 (BR-1, negativo): Given um documento acima do nível da pessoa com "ritmo" no título, When ela digita "ritmo", Then esse documento não aparece.
- AC-4 (BR-2, FR-2): Given buscas feitas no computador, When a pessoa foca a busca no celular, Then vê as mesmas recentes; When remove uma, Then some nos dois.
- AC-5 (BR-2, negativo): Given um master vendo como Ana, When busca "x", Then "x" não entra nas recentes de Ana nem nas dele.
- AC-6 (FR-4): Given "lei do ritmo" digitado e nenhuma sugestão escolhida, When Enter, Then abre os resultados completos e "lei do ritmo" vira a primeira recente.
- AC-7 (Perguntar à IA): Given texto digitado, When a pessoa escolhe "Perguntar à IA: …", Then a Pesquisa com IA abre com a pergunta.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2, AC-6, AC-7 | E2E | Vault de fixture |
| AC-3 | integração | Níveis |
| AC-4, AC-5 | integração + E2E | Dois contextos; Ver como |
| NFR-1 | script de latência | |

## References
Figma: barra superior em [v2 · Telas-chave](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=367-2) e [v2 · Conversa](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=376-2) · Plano: `docs/design/redesign-v2.md` · `docs/product/spotify-funcionalidades-desejaveis.md` (⌘K e sugestões) · KBC-002, KBC-103

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
