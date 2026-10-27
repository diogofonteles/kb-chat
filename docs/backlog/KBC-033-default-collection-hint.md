---
id: KBC-033
title: "Acervo padrão no editor de convite e de perfil: dica quando nenhum acervo está marcado, pré-seleção do único marcado e aviso quando o padrão é limpo"
status: in-review
slice: release-1
outcome: o master entende por que o "Acervo padrão" só oferece "Sem preferência" e não acha que o campo está quebrado
depends_on: [KBC-028]
---

# KBC-033 — Acervo padrão: dica, pré-seleção e aviso

## Story
Como master que convida alguém (convite com "Configurar agora" ou perfil de convite), quero entender por que o "Acervo padrão" só oferece os acervos marcados, para escolher o padrão sem achar que o campo está quebrado.

Relato do dono em produção, 2026-10-27: com nenhum acervo marcado, o campo mostrava só "Sem preferência", sem explicação.

## Scope
**In:** o editor de pré-configuração (`invite-preset-editor`), usado no convite ("Configurar agora") e nos perfis de convite.
**Out:** mudar a regra (o padrão continua entre os acervos concedidos, BR-4 do KBC-028); a tela de Preferências da própria pessoa.

## Business rules
- BR-1: o acervo padrão é um dos acervos marcados (KBC-028 BR-4); o master vê todos.
- BR-2: a escolha explícita do master nunca é trocada pelo aplicativo.

## Acceptance criteria
- **AC-1**: Given nenhum acervo marcado (e o vault com acervos), When o editor aparece, Then o "Acervo padrão" mostra só "Sem preferência" e, logo abaixo, "Marque ao menos um acervo em “Acervos” acima para escolher o padrão.", ligado ao campo por `aria-describedby`.
- **AC-2**: Given nenhuma escolha explícita de acervo padrão, When o master deixa exatamente um acervo marcado, Then esse acervo vira o padrão (ainda pode voltar a "Sem preferência").
- **AC-3**: Given um acervo escolhido como padrão, When o master o desmarca, Then o padrão volta a "Sem preferência" e um aviso educado (`role="status"`) diz "O acervo padrão foi limpo porque ele não está mais entre os acervos marcados."
- **AC-4**: o mesmo vale no convite ("Configurar agora") e no perfil de convite; E2E no fluxo do convite em 1440 px e 390 px, sem violações do axe.

## Test strategy
- AC-1 a AC-3: testes de componente em `invite-preset-editor.spec.ts`.
- AC-4: `e2e/specs/invite-presets.spec.ts` (convite com "Configurar agora").
