---
id: KBC-062
title: "Pessoas e permissões: o foco fica na caixa marcada enquanto a mudança salva"
status: ready
slice: phase-2-a
outcome: quem usa só o teclado marca vários acervos e funcionalidades de uma pessoa sem perder o lugar a cada clique
depends_on: []
---

# KBC-062 — Foco estável em "Pessoas e permissões"

## Story
Como master que usa só o teclado (ou um leitor de tela), quero marcar e desmarcar acervos e funcionalidades de uma pessoa em sequência, sem que o foco volte ao início da página a cada mudança.

## Context
Achado do QA do KBC-048 (2026-11-03), anterior a ele: enquanto a mudança salva, o editor desabilita o grupo inteiro (`fieldset [disabled]`), e o navegador tira o foco da caixa marcada (vai para o `<body>`). Com a árvore de acervos do KBC-048, são mais caixas por pessoa.

## Scope
**In:** o editor da pessoa e o editor de perfis de convite mantêm o foco na caixa usada; mudanças seguidas não se perdem nem correm entre si.
**Out:** mudar o desenho do editor.

## Business rules
- BR-1: nenhuma mudança se perde: duas marcações rápidas viram duas mudanças aplicadas, na ordem.

## Functional requirements
- FR-1: durante o salvamento o grupo fica `aria-busy` e não desabilitado; a próxima mudança espera a anterior terminar.

## Acceptance criteria
- **AC-1** (FR-1): Given o editor de uma pessoa, When o master marca um acervo pelo teclado (Espaço), Then o foco continua nessa caixa depois de salvo.
- **AC-2** (BR-1): Given duas caixas marcadas em sequência rápida, When as duas mudanças terminam, Then a pessoa tem as duas.
- **AC-3**: o mesmo vale para o editor de perfis de convite; axe sem violações sérias.

## Test strategy
| AC | Nível |
|---|---|
| AC-1, AC-3 | E2E (só teclado) |
| AC-2 | unit (fila de mudanças) + E2E |

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC
- [x] Test level chosen for every AC
- [x] Fits one goal
