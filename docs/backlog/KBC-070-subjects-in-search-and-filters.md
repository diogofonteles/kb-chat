---
id: KBC-070
title: "Assuntos na busca e nos filtros: achar faixas pelo conceito, ver os assuntos da faixa e as faixas no \"Veja também\" de cada conceito"
status: ready
slice: phase-2-editing
outcome: quem pesquisa um conceito do acervo encontra as perguntas e respostas sobre ele na mesma busca dos documentos
depends_on: [KBC-069, KBC-039]
---

# KBC-070 — Assuntos na busca e nos filtros

## Story
Como quem pesquisa, quero filtrar pelo assunto e encontrar as faixas de pergunta e resposta sobre ele junto dos documentos, e a partir de uma faixa chegar aos assuntos e documentos relacionados, para estudar um tema por todos os caminhos.

## Scope
**In:** permissão nova `media-subjects` ("Assuntos na mídia"); o filtro de conceitos da busca (KBC-002) passa a valer para o grupo de mídia (ADR 0024 §2): com um conceito ativo, a mídia mostra as faixas ligadas a ele (aceitas, KBC-069) e as ocorrências na fala dentro delas; o resultado de uma faixa mostra os assuntos como chips; a página da faixa mostra "Assuntos" (chips que abrem a busca filtrada) e o resumo; o painel de um conceito ("Veja também", KBC-003) ganha "Perguntas e respostas sobre este assunto" (até 5, com "Ver todas"); a Biblioteca (KBC-051) ganha o filtro "Assunto".
**Out:** pesquisa com IA sobre mídia (fase C, ADR 0024 §4); assuntos de documentos (vêm do `kb`); recomendações.

## Business rules
- BR-1: só ligações aceitas contam (KBC-069 BR-3).
- BR-2: com um conceito ativo, uma faixa entra no grupo de mídia se está ligada a ele, mesmo sem a palavra buscada na fala; com texto na busca, ela precisa também casar o texto (na fala, no título ou no resumo).
- BR-3: as regras de acervo e permissão são as da busca de hoje (404 para o que a pessoa não vê); sem `media-subjects`, a busca e a Biblioteca ficam como antes.
- BR-4: as contagens do filtro de conceitos somam documentos e faixas separadamente ("Cabala (12 · 3 faixas)").

## Functional requirements
- FR-1: `POST /api/v1/topics/{topic}/searches` deve aplicar `concepts` ao grupo de mídia pelas ligações e devolver, em cada resultado de faixa, `subjects` (aditivo; clientes antigos ignoram). (BR-1, BR-2, BR-3)
- FR-2: As facetas devem trazer a contagem de faixas por conceito para quem tem `media-subjects`. (BR-4)
- FR-3: `GET /api/v1/topics/{topic}/concepts/{name}/media` deve listar as faixas ligadas ao conceito, mais recentes primeiro, paginado. (BR-1, BR-3)
- FR-4: A Biblioteca deve oferecer o filtro "Assunto" (combobox), lembrado como os demais filtros.

## Non-functional requirements
- NFR-1: o grupo de mídia com filtro de conceito mantém p95 ≤ 150 ms com 2.000 h de mídia e 20.000 ligações (alvo da ADR 0024), medido no teste de carga da busca.

## Acceptance criteria
- **AC-1** (FR-1, BR-2): Given a faixa "O que é a burracheira?" ligada ao conceito "Burracheira", When alguém com `media-subjects` filtra por "Burracheira" sem texto, Then a faixa aparece no grupo de mídia com o chip do assunto.
- **AC-2** (BR-2): Given o mesmo filtro e o texto "chá", When a fala da faixa não tem "chá" nem o título nem o resumo, Then ela não aparece.
- **AC-3** (BR-1): Given uma sugestão de assunto não aceita, When filtrado por ele, Then a faixa não aparece.
- **AC-4** (FR-2, BR-4): Given 12 documentos e 3 faixas no conceito "Cabala", When as facetas são mostradas, Then o chip diz "Cabala (12 · 3 faixas)".
- **AC-5** (FR-3): Given o painel do conceito "Cabala", When aberto, Then mostra "Perguntas e respostas sobre este assunto" com as 3 faixas, cada uma abrindo o player no começo.
- **AC-6** (BR-3, permissão): Given quem não tem `media-subjects`, When busca com o filtro "Cabala", Then as contagens e o grupo de mídia ficam como hoje (sem faixas pelo assunto); Given uma faixa de um acervo que a pessoa não vê, Then não aparece em nada.
- **AC-7** (FR-4): Given a Biblioteca com o filtro "Assunto: Cabala", When aplicado, Then só as faixas ligadas aparecem e o filtro volta na próxima visita.
- **AC-8** (acessibilidade): chips e combobox com nome acessível, sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-4, AC-6 | integração da busca | duas contas |
| AC-5, AC-7 | E2E | |
| AC-8 | E2E | axe |
| NFR-1 | carga com dados sintéticos | script da busca de mídia |

## References
ADR 0024, 0003, [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) · KBC-002, KBC-003, KBC-039, KBC-051 · Telas T2/T3 (busca e painel), T16

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled
- [x] Fits one goal
