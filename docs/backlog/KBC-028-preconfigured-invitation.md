---
id: KBC-028
title: "Convite pré-configurado: IA, permissões, preferências e perfis de convite"
status: in-review
slice: release-1
outcome: o master convida já com tudo pronto (IA da aplicação, cota, permissões, preferências iniciais), reaproveitando perfis como "Aluno" e "Pesquisador", e a pessoa entra sem precisar configurar nada
depends_on: [KBC-010, KBC-022, KBC-026]
---

# KBC-028 — Convite pré-configurado e perfis de convite

## Story
Como master, quero configurar a pessoa no próprio convite (ou escolher um perfil pronto), para que ela entre com a IA, os acervos, os recursos e as preferências certos, sem eu precisar abrir o editor dela depois do convite.

Decisão do dono em 2026-10-26: pré-configurar a pessoa no convite ("Configurar agora"): IA da aplicação, cota, fallback pago e teto; permissões (acervos, recursos, papel); preferências iniciais (acervo, visão, perfil de pesquisa, tema), com o assistente respeitando o preset; perfis de convite reutilizáveis ("Aluno", "Pesquisador") e um perfil padrão; o mesmo editor serve para pessoas existentes.

## Scope
**In:**
- **Preset de convite**: papel, acervos, recursos, IA da aplicação (Padrão, Plano da casa ou Nenhuma), "Usar sempre", pesquisas por dia, reserva paga e teto mensal, e preferências iniciais (acervo padrão, visão inicial, perfil de pesquisa, tema).
- **Convidar** com "Configurar agora" (o preset aberto, a partir do perfil escolhido) ou só escolhendo um perfil; sem escolha, vale o perfil padrão (se houver); sem perfil padrão, o convite de hoje (só busca, nenhum acervo).
- **Perfis de convite** (master): criar, editar, renomear, apagar e marcar um como padrão; o mesmo editor do preset.
- **Pessoas existentes**: "Aplicar perfil" no editor da pessoa (papel, acervos, recursos e IA; as preferências só valem enquanto a pessoa não salvou as dela).
- As preferências iniciais ficam na pessoa e preenchem as Configurações (e o assistente de primeira abertura) até a pessoa salvar as dela.

**Out:**
- Ceder assinaturas pelo preset (exigem o dono e os termos pessoa a pessoa, KBC-024/027).
- Escolher a IA própria da pessoa (é dela; KBC-023).

## Business rules
- BR-1: só masters convidam, gerenciam perfis e aplicam perfis (como hoje).
- BR-2: o preset nunca cede uma assinatura do dono (só Padrão, Plano da casa ou Nenhuma).
- BR-3: um único perfil padrão; apagar o padrão deixa a casa sem padrão.
- BR-4: o acervo padrão das preferências precisa estar entre os acervos do preset (ou o papel ser master).
- BR-5: aplicar um perfil a uma pessoa existente registra a mudança de IA no histórico dela (quem e quando), como o editor.
- BR-6: as preferências iniciais nunca sobrescrevem preferências que a pessoa já salvou.

## Functional requirements
- FR-1: contrato `invitePresetSchema` (role, topics, features, ai sem assinaturas, preferences parciais), `inviteProfileSchema` ({ id, name, preset, isDefault }), `inviteRequestSchema` ganha `preset?` e `profileId?`.
- FR-2: `GET/POST /api/v1/invite-profiles`, `PUT/DELETE /api/v1/invite-profiles/:id` (masters; `invite-profiles.json` no estado, 0600, gravação atômica).
- FR-3: `POST /api/v1/people` aplica, nesta ordem, o `preset` enviado, o perfil `profileId`, o perfil padrão; a pessoa nasce com papel, acervos, recursos, IA e `initialPreferences`; a mudança de IA vai ao histórico.
- FR-4: `POST /api/v1/people/:id/profile { profileId }` aplica um perfil a uma pessoa existente.
- FR-5: `GET /api/v1/settings` de quem ainda não salvou mescla as `initialPreferences` da pessoa nos padrões.
- FR-6: tela: em Pessoas e permissões, o convite com "Perfil" e "Configurar agora" (o editor de preset), a seção "Perfis de convite" e "Aplicar perfil" no editor da pessoa.

## Non-functional requirements
- NFR-1: WCAG 2.2 AA no editor de preset e nos perfis, em 1440 e 390 px, sem rolagem horizontal.
- NFR-2: nenhum dado pessoal novo em log.

## Acceptance criteria
- **AC-1 (FR-3, FR-5)**
  - Given um master com o perfil "Aluno" (acervo hermetismo, busca e pesquisa, Plano da casa com 3 pesquisas por dia, visão inicial Pesquisa com IA, perfil Rápido, tema escuro)
  - When convida alguém com esse perfil
  - Then a pessoa nasce com esses acervos, recursos e IA, o histórico registra quem atribuiu, e na primeira abertura as Configurações e o assistente já mostram as preferências do perfil
- **AC-2 (FR-6)**
  - Given o convite
  - When o master escolhe "Configurar agora" e muda a cota e o tema
  - Then o convite sai com o preset ajustado, sem alterar o perfil
- **AC-3 (FR-2, BR-3)**
  - Given dois perfis
  - When o master marca "Pesquisador" como padrão
  - Then "Aluno" deixa de ser o padrão, e um convite sem escolha usa "Pesquisador"
- **AC-4 (FR-4, BR-5, BR-6)**
  - Given uma pessoa existente que já salvou as próprias preferências
  - When o master aplica o perfil "Pesquisador"
  - Then papel, acervos, recursos e IA mudam (com histórico) e as preferências dela continuam as dela
- **AC-5 (BR-2, BR-4, BR-1)**
  - Given um preset
  - When ele tenta ceder uma assinatura, ou o acervo padrão não está entre os acervos, ou quem pede não é master
  - Then a API recusa (400 ou 403)

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-3, AC-4, AC-5 | integração (`invite-profiles.integration.test.ts`) + contrato | — |
| AC-2 | unitário web (`invite-preset-editor.spec.ts`, `people-panel.spec.ts`) + E2E (`invite-presets.spec.ts`) | — |

## References
Telas: `docs/design/screens.md` (T9, T7) · ADR 0008 (pessoas e permissões), 0016 (política de IA).

## Open questions
Nenhuma. Premissas: assinaturas fora do preset; sem perfil padrão o convite é o de hoje; aplicar perfil a uma pessoa existente não mexe nas preferências que ela já salvou.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
