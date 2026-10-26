---
id: KBC-024
title: "Assinatura do Claude do dono cedida, por decisão do dono, a pessoas específicas"
status: in-review
slice: release-1
outcome: o dono cede a sua assinatura do Claude a uma, várias ou todas as pessoas, sabendo o que os termos dizem, e cada pessoa sabe que está usando a IA da aplicação temporariamente e como configurar a própria
depends_on: [KBC-007, KBC-022, KBC-023]
---

# KBC-024 — Assinatura do Claude do dono cedida a pessoas específicas

## Story
Como dono da Nova Alexandria, quero ceder a minha assinatura do Claude a pessoas que eu escolher, para que elas pesquisem com o modelo mais capaz enquanto não configuram a própria IA, sabendo que os termos da Anthropic não permitem atender terceiros com a assinatura e registrando quem concedeu e quando.

Decisão do dono em 2026-10-26: "o master cede a assinatura Claude do dono a usuários específicos". Os termos da Anthropic proíbem usar as assinaturas Free/Pro/Max para atender outras pessoas (The Register, 2026-02-20); ceder é uma decisão informada do dono, registrada na ADR 0019, com confirmação explícita na tela e na API.

## Scope
**In:**
- Nova IA da aplicação `claude-subscription` ("Assinatura do Claude do administrador") ao lado do plano da casa, no editor da pessoa e na ação em massa (selecionadas ou todos).
- Confirmação obrigatória antes de ceder (tela e API), com o texto dos termos; auditoria de quem concedeu ou revogou, quando e que a confirmação foi feita.
- A pesquisa de quem recebeu a assinatura roda pelo Claude Code do servidor (o mesmo da assinatura do dono), com a cota diária da pessoa, sem custo por token; cada turno vai ao registro de gasto da casa com US$ 0 e cobrança `subscription`; o `done` diz `plan: app-subscription`.
- Aviso em destaque nas Configurações da pessoa: "Você está usando temporariamente a IA da aplicação (assinatura do Claude do administrador)", com o botão para configurar a própria IA.

**Out:**
- A assinatura do ChatGPT (Codex) cedida (KBC-027).
- Pré-configurar a IA no convite (KBC-028).
- Medir o uso da assinatura em tokens ou limitar por janela de 5 horas (o Claude Code não expõe isso de forma estável).

## Business rules
- BR-1: só o **dono** cede a assinatura (é a dele); qualquer master pode revogar (trocar a IA da pessoa por outra). A API recusa a cessão por outro master (403).
- BR-2: ceder exige a confirmação explícita dos termos (`subscriptionTermsAccepted: true`), por pessoa e na ação em massa; sem ela a API recusa (400).
- BR-3: a assinatura **nunca** vira padrão: não pode ser a "IA padrão" da casa nem ir com "também para os próximos convidados".
- BR-4: quem recebeu a assinatura pesquisa com a cota diária dela (a mesma do plano da casa: Rápido 1, Profundo 2, Exaustivo 5), sem aprofundamento automático (um Rápido conta 1); a resposta diz "IA da aplicação · Assinatura do Claude · Incluído na assinatura do administrador · Pesquisas restantes hoje: N".
- BR-5: a precedência da ADR 0016 continua: a IA própria da pessoa vence, salvo "Usar sempre a IA da aplicação". Se o Claude Code não estiver disponível no servidor, a pessoa segue como no KBC-022 (a própria IA ou nenhuma).
- BR-6: a pessoa vê, em destaque nas Configurações, que usa temporariamente a assinatura do administrador, com o botão "Configurar a minha IA" (quando tem "Configurações de IA próprias").
- BR-7: cada cessão e revogação fica no "Histórico da IA" da pessoa (quem, quando, para quê e, na cessão, "termos confirmados").

## Functional requirements
- FR-1: contrato: `APP_AIS = ['house', 'claude-subscription', 'none']`; a IA padrão da casa aceita só `house` ou `none`; `personAiUpdateSchema` e `aiAssignmentRequestSchema` ganham `subscriptionTermsAccepted` (obrigatório e `true` ao ceder `claude-subscription`); `setDefault` com `claude-subscription` é inválido; `researchPlanSchema` ganha `app-subscription`; a mudança no histórico ganha `termsAccepted`.
- FR-2: `PATCH /api/v1/people/:id` e `POST /api/v1/people/ai-assignment` recusam a cessão por quem não é o dono (403 `FORBIDDEN`).
- FR-3: `AppAiPlan` ganha o tratador da assinatura cedida: disponível quando o Claude Code está no PATH; o turno reserva a cota da pessoa, roda o `ClaudeCliRunner` com os modelos do dono, sem aprofundamento, e no fim grava `{ model, usd: 0, billing: 'subscription' }` em `house-spend.jsonl` e marca o `done` com `plan: 'app-subscription'`, `billing: 'subscription'` e `remaining`.
- FR-4: `GET /api/v1/house-ai` diz se a assinatura pode ser cedida agora (`subscriptionAvailable`).
- FR-5: tela: a opção "Assinatura do Claude do administrador" aparece só para o dono, no editor da pessoa e na barra em massa, com a confirmação na linha (texto dos termos, "Ceder assim mesmo" e "Cancelar", foco no botão de confirmar); quando indisponível, a ajuda diz que o Claude Code não está pronto no servidor. O cartão "Quem atende você agora" mostra o aviso em destaque e o botão.

## Non-functional requirements
- NFR-1: nenhuma chamada real ao Claude nos testes (CLI falsa nos testes de integração; runner falso no E2E).
- NFR-2: WCAG 2.2 AA na confirmação e no aviso, em 1440 e 390 px, sem rolagem horizontal.
- NFR-3: o turno cedido não recebe chave nem credencial além do ambiente permitido da CLI (ADR 0007); nenhuma credencial em resposta ou log.

## Acceptance criteria
- **AC-1 (FR-2, BR-1, BR-2)**
  - Given o dono no editor de uma pessoa
  - When escolhe "Assinatura do Claude do administrador"
  - Then a confirmação mostra o texto dos termos; "Ceder assim mesmo" salva com `subscriptionTermsAccepted: true` e o histórico mostra o dono, a data e "termos confirmados"
  - And outro master recebe 403 ao ceder, e a API recusa a cessão sem a confirmação (400)
- **AC-2 (FR-3, BR-4)**
  - Given uma pessoa com a assinatura cedida e o Claude Code disponível
  - When ela pesquisa
  - Then a resposta vem pelo Claude Code com o `done` `plan: app-subscription`, `billing: subscription`, `usd: 0` e `remaining`, e o registro de gasto da casa ganha uma linha de US$ 0 com cobrança `subscription`
- **AC-3 (BR-4)**
  - Given a cota diária da pessoa esgotada
  - When ela pesquisa com a assinatura cedida
  - Then recebe `HOUSE_QUOTA_EXHAUSTED` sem chamar o Claude Code
- **AC-4 (BR-3)**
  - Given a casa
  - When um master tenta tornar a assinatura a IA padrão (`PUT /house-ai` ou "também para os próximos")
  - Then a API recusa (400) e a tela não oferece essa opção
- **AC-5 (BR-6, FR-5)**
  - Given uma pessoa com a assinatura cedida
  - When ela abre ⚙ > Sua IA
  - Then vê em destaque "Você está usando temporariamente a IA da aplicação (assinatura do Claude do administrador)" e "Configurar a minha IA", que leva às opções
- **AC-6 (FR-5, BR-2)**
  - Given o dono na ação em massa
  - When escolhe a assinatura e aplica às selecionadas ou a todos
  - Then a confirmação dos termos aparece antes, e "também para os próximos convidados" fica desabilitado
- **AC-7 (BR-5)**
  - Given a assinatura cedida e o Claude Code ausente no servidor
  - When a pessoa pesquisa
  - Then ela segue como no KBC-022 (a própria IA ou nenhuma), e o editor do dono avisa que a assinatura não está disponível agora

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-4 | integração (`lent-subscription.integration.test.ts`) + unitário web (`person-ai-editor.spec.ts`) + E2E (`lent-subscription.spec.ts`) | — |
| AC-2, AC-3, AC-7 | integração com a CLI falsa (`test/fakes/fake-claude.mjs`) + unitário (`subscription-ledger-runner.test.ts`, `app-ai-plan.test.ts`) | — |
| AC-5 | unitário web (`ai-status-card.spec.ts`) + E2E (runner falso da assinatura no servidor de E2E) | — |
| AC-6 | unitário web (`ai-assignment-bar.spec.ts`) + E2E | — |

## References
ADR: `docs/adr/0019-lend-owner-claude-subscription.md` (emenda 0007 e 0016) · Telas: `docs/design/screens.md` (T6, T9, T12) · The Register, 2026-02-20.

## Open questions
Nenhuma. Premissas: só o dono cede (é a assinatura dele); a cota diária do plano da casa vale também para a assinatura cedida (protege os limites de uso da assinatura); sem aprofundamento automático na assinatura cedida, como no plano da casa.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
