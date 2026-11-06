---
id: KBC-109
title: "Nível no convite, nos perfis de convite, na aprovação de solicitações e em lote em Pessoas e permissões"
status: ready
slice: levels-release-1
outcome: o master dá o nível certo a quem entra no mesmo passo em que libera o acervo, sem voltar à pessoa depois
depends_on: [KBC-103]
parent: LEVELS
---

# KBC-109 — Nível no convite, nos perfis e na aprovação

## Story
Como master, quero definir o nível de cada acervo ao convidar, nos perfis de convite e ao aprovar uma solicitação, e mudar o nível de várias pessoas de uma vez, para não configurar pessoa por pessoa.

## Scope
**In:** `presetFieldsSchema` com `levels` (aditivo); no editor de preset (convite e perfis), ao lado de cada acervo marcado que tenha escala, o seletor **Nível** (padrão: o mais baixo); "Aplicar perfil" leva os níveis; aprovação de solicitação: o editor da pessoa abre com o nível mais baixo pré-marcado em cada acervo escolhido; barra de seleção em lote: "Nível em <acervo>: [nível] · Aplicar"; a lista de pessoas mostra o nível por acervo ("Hermetismo · CI"); auditoria de cada mudança.
**Out:** grupos (KBC-047).

## Business rules
- BR-1: um preset só guarda nível para acervo marcado nele e que tenha escala; nível de acervo desmarcado é descartado.
- BR-2: aplicar um perfil troca os níveis dos acervos que o perfil traz e não mexe nos demais.
- BR-3: um nível que deixou de existir num perfil vale como o mais baixo e o editor do perfil avisa "O nível X não existe mais; escolha outro.".
- BR-4: toda mudança de nível de pessoa, por convite, perfil, aprovação ou lote, é auditada por pessoa.
- BR-5: master não tem seletor de nível (vê tudo).

## Functional requirements
- FR-1: `invitePresetSchema` aceita `levels: Record<topSlug, levelId>` e o refine de BR-1. (BR-1)
- FR-2: `POST /people` (convite) e `POST /people/:id/profile` gravam os níveis. (BR-2)
- FR-3: `POST /people/levels` (masters) com `{ ids | all, topic, level }` aplica em lote. (BR-4)
- FR-4: a leitura de perfis marca níveis inexistentes com `staleLevel`. (BR-3)
- FR-5: a web mostra os seletores, a coluna na lista e a barra em lote. (BR-5)

## Non-functional requirements
- NFR-1: aplicar um nível a 500 pessoas leva ≤ 1 s e uma escrita de `people.json`.

## Acceptance criteria
- **AC-1** (FR-1, FR-2): Given o perfil "Aluno" com Hermetismo em CI, When o master convida com ele, Then a pessoa nova entra em CI e a auditoria registra o convite.
- **AC-2** (BR-1, negativo): Given um preset com nível para um acervo desmarcado, When salva, Then o nível é descartado; pela API, 400 `VALIDATION_FAILED`.
- **AC-3** (BR-2): Given Bia em CDC no Hermetismo e QS na UDV, When aplica um perfil que traz só Hermetismo em CI, Then fica CI no Hermetismo e QS na UDV.
- **AC-4** (BR-3): Given o perfil com CI e o nível CI apagado depois, When o master abre o perfil, Then vê o aviso e o convite com ele dá o nível mais baixo.
- **AC-5** (aprovação): Given uma solicitação aprovada com Hermetismo marcado, Then a pessoa fica no nível mais baixo e o editor mostra o seletor.
- **AC-6** (FR-3, lote): Given 3 pessoas selecionadas, When "Nível em Hermetismo: CI · Aplicar", Then as 3 ficam em CI, com 3 entradas na auditoria; um master selecionado é ignorado e a mensagem diz "Masters veem todos os níveis.".
- **AC-7** (BR-5, UI): Given um master no editor, Then não há seletor de nível; Given 390 px, Then os seletores ficam abaixo de cada acervo, com rótulo visível.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-6 | integração | `people-levels.integration.test.ts`, `invite-profiles` |
| AC-7 | componente + E2E | `invite-preset-editor`, `people.spec.ts`, 1440 e 390, axe |
| NFR-1 | teste de desempenho | — |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §2, §9, §11 · KBC-028, KBC-014 · Tela T9 com a emenda de 2026-11-06.

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
