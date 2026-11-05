---
id: KBC-101
title: "Faixas no Exaustivo: varredura e cobertura contam as faixas, filtros de autoria e origem, sub-acervos e faixas no \"Veja também\""
status: ready
slice: phase-2-research-media
outcome: uma pergunta exaustiva sobre um acervo com faixas lê todas elas e diz quantas leu; quem lê um texto chega às faixas ligadas a ele
depends_on: [KBC-099, KBC-030]
parent: KBC-098
---

# KBC-101 — Faixas no Exaustivo e no "Veja também"

## Story
Como quem pesquisa a obra inteira, quero que o Exaustivo varra também o que foi falado e me diga quantas faixas leu, para confiar que nada ficou de fora.

## Scope
**In:** faixas no conjunto da varredura (ADR 0021) e na cobertura medida pelo aplicativo; trecho resolvido pela citação literal dos achados (ADR 0035 §6 c); filtro `source` com a origem "Faixas de áudio" e `list_sources` com ela; `find_text`, leituras e varredura nos sub-acervos como `search_collection` já faz; faixas no "Veja também" do painel do documento, com ♪, abrindo o T22 no começo; as faixas como documentos do grupo de autoria certo nas fontes agrupadas (KBC-020).
**Out:** faixas na lista de documentos da busca (T2), que seguem em "Na fala"; vídeo.

## Business rules
- BR-1: no Exaustivo, uma faixa visível (KBC-099 BR-4) é um documento do conjunto como um texto: entra no plano, no corte por expressões, nos lotes e na cobertura.
- BR-2: a cobertura separa as faixas: "2.700 documentos no conjunto (145 faixas de áudio)" e "· 412 analisados pela IA (30 faixas)".
- BR-3: o filtro de autoria vale para as faixas como para os textos; a origem "Faixas de áudio" restringe a elas, e `exclude` a tira.
- BR-4: um achado da varredura numa faixa resolve o trecho pela citação literal; sem achar a citação, pelo lote (o começo da janela lida).
- BR-5: o "Veja também" mostra faixas ligadas pelo `kb link` só a quem as veria na pesquisa (KBC-099 BR-4).

## Functional requirements
- FR-1: `SweepPlanner.targetSet` e `measureSweep` devem incluir as entradas de faixa visíveis e contar `tracks` em `sweepCoverageSchema` (aditivo). (BR-1, BR-2)
- FR-2: `batchText` deve rotular faixas como "faixa de áudio" com gravação e manter as âncoras. (BR-1)
- FR-3: `FindingSet` deve resolver o trecho de um achado de faixa pela citação (sem marcação de link do kb), senão pelo começo da janela. (BR-4)
- FR-4: `filterShape.source` deve aceitar `faixas-de-audio`, e `list_sources` deve listá-la com a contagem. (BR-3)
- FR-5: `find_text`, `read_document(s)`, `list_sources` e a varredura devem usar o escopo com sub-acervos (`catalog.scope`). (BR-1)
- FR-6: `GET /topics/:topic/documents/:id` deve trazer, em "Veja também", as faixas visíveis com `media`, e a web deve abri-las no T22. (BR-5)

## Non-functional requirements
- NFR-1: com 2.000 faixas a mais, o planejamento e o corte por expressões do Exaustivo levam no máximo +15 % (vault de teste, sem modelo).
- NFR-2: a estimativa do Exaustivo continua exata: pedidos previstos = pedidos feitos ± 1 no teste com faixas.

## Acceptance criteria
- **AC-1** (BR-1, BR-2, FR-1): Given um acervo de teste com 6 textos e 3 faixas e o stub do Exaustivo sem expressões, When a pergunta varre o acervo, Then os 9 documentos são lidos e a cobertura diz "9 documentos no conjunto (3 faixas de áudio) · 9 lidos por inteiro pela IA (3 faixas)".
- **AC-2** (BR-1, borda): Given expressões que só aparecem numa faixa, Then só ela vai a um lote e a cobertura conta as outras como conferidas pelas expressões.
- **AC-3** (BR-3): Given autoria "Mestre Laércio" e uma faixa de outros autores com a expressão, Then a faixa fica fora do conjunto; com "Faixas de áudio", só faixas entram.
- **AC-4** (BR-4, FR-3): Given um achado com a citação de uma fala de 3:10, Then a fonte traz `passages[0].startMs` daquela fala; Given uma citação que não está no texto, Then o trecho é o começo da janela lida.
- **AC-5** (BR-1, negativo): Given alguém sem `media-research`, When roda o Exaustivo, Then o conjunto e a cobertura não têm faixas e nada diz "faixas".
- **AC-6** (FR-5): Given uma faixa num sub-acervo, When a pesquisa é no acervo pai, Then `find_text` e a varredura a acham.
- **AC-7** (BR-5, FR-6): Given um texto ligado a uma faixa pelo `kb link`, When a pessoa abre o texto, Then "Veja também" mostra "♪ <título da faixa> · <gravação>", e o clique abre o T22 no começo, com "← Voltar" ao texto; sem `media-research`, a faixa não aparece.
- **AC-8** (continuação): Given uma varredura incompleta com faixas, When **Continuar varredura**, Then retoma depois da última faixa ou texto varrido e a cobertura soma as faixas.
- **AC-9** (KBC-098 ponto 7): Given os specs de pesquisa exaustiva e de busca existentes, Then passam sem mudança.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-6, AC-8 | integração | `sweep-tracks.integration.test.ts` no vault de fixture com faixas e `media.db` semeado; stub de lote |
| AC-4 | unidade | `findings.test.ts` com a resolução pela citação |
| AC-7 | componente + E2E | `document-panel.spec.ts`; `e2e/specs/research-tracks.spec.ts` estendido |
| AC-9 | E2E existentes | sem mudança |
| NFR-1, NFR-2 | script | medida sem modelo no vault de teste, evidência em `work/KBC-101/` |

## References
ADR [0035](../adr/0035-tracks-as-kb-documents.md), [0021](../adr/0021-app-driven-exhaustive-sweep.md), [0015](../adr/0015-authorship-in-catalog-and-tool-contracts.md) · Telas T4 (cobertura) e T3 ("Veja também") com as emendas de 2026-11-05.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-099
- [x] Cabe num goal
