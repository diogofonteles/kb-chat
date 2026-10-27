---
id: KBC-031
title: "Assinatura do ChatGPT escolhível em produção, motivos corretos do cartão e cessão de assinaturas no convite"
status: in-review
slice: release-1
outcome: em produção o dono escolhe e testa a assinatura do ChatGPT depois de ligá-la, cada cartão bloqueado diz o motivo real e o que fazer, e o dono cede uma assinatura já no convite, com a mesma confirmação dos termos
depends_on: [KBC-024, KBC-027, KBC-028]
---

# KBC-031 — Motivos corretos da assinatura do ChatGPT e cessão no convite

## Story
Como dono, quero que o cartão "Assinatura do ChatGPT" em ⚙ → Sua IA diga o motivo real quando não posso escolhê-lo e funcione (com "Testar conexão") depois que eu ligo o Codex, e quero ceder uma assinatura minha já no convite, para não precisar abrir o editor da pessoa depois.

Relatos do dono em 2026-10-27 (produção `main` @ 360b6da): (1) o cartão aparecia desativado, com instrução de instalar o Codex CLI, embora o Codex rode no contêiner isolado (ADR 0020) e o executor responda logado; (2) o "Configurar agora" do convite (KBC-028) não oferece as assinaturas do dono.

Causa (reproduzida no servidor E2E com o executor real e o Codex falso, sem `house-ai.json`): a API respondia `not-enabled` e a tela mostrava a cópia de desenvolvimento local ("inicie o servidor com KB_CHAT_CODEX=on"); depois de ligado, "Testar conexão" procurava o binário `codex` no PATH do contêiner da API e falhava com `CLI_MISSING` ("A ferramenta não foi encontrada no servidor"); o executor fora do ar ou sem login não aparecia no cartão.

## Scope
**In:**
- Motivos do cartão "Assinatura do ChatGPT" por situação: desligado em IA da aplicação (`house-off`), sem login no servidor (`login-required`), contêiner isolado indisponível (`sandbox-unavailable`); `not-enabled` só no desenvolvimento local sem `KB_CHAT_CODEX`.
- "Testar conexão" da assinatura do ChatGPT passa pelo executor no modo sandbox.
- Convite com "Configurar agora": o dono pode ceder a assinatura do Claude ou do ChatGPT, só quando ela pode ser cedida agora, com a confirmação dos termos do KBC-024; a cessão entra no histórico da pessoa (quem, quando, termos confirmados).

**Out:**
- Perfis de convite guardando uma cessão (decisão abaixo).
- Ceder ao aplicar um perfil a uma pessoa existente: a cessão continua no campo "Qual IA atende esta pessoa" do mesmo editor (KBC-024), logo abaixo de "Aplicar perfil".

## Business rules
- BR-1: só o dono cede uma assinatura no convite; qualquer outro master recebe 403 (como no KBC-024).
- BR-2: o convite só cede com `subscriptionTermsAccepted: true` no mesmo pedido; sem isso, 400.
- BR-3: perfis de convite nunca guardam uma assinatura (KBC-028 BR-2 continua para perfis); o preset enviado no convite pode cedê-la.
- BR-4: a tela oferece cada assinatura no convite só enquanto ela pode ser cedida (`lendable`: Claude logado; ChatGPT ligado, logado e com o contêiner respondendo).
- BR-5: em produção (`NODE_ENV=production`) nenhum motivo pede `KB_CHAT_CODEX=on` nem a instalação do Codex CLI.

## Functional requirements
- FR-1: `providerUnavailableReasonSchema` ganha `house-off`, `login-required` e `sandbox-unavailable`.
- FR-2: o registro calcula o motivo da assinatura do ChatGPT nesta ordem: só do dono; sem modo (produção: `sandbox-unavailable`; local: `not-enabled`); desligado (`house-off`); sandbox: `/status` do executor (`login-required` com `loggedIn:false`, `sandbox-unavailable` sem resposta); local: binário no PATH (`cli-missing`).
- FR-3: o teste de conexão da assinatura do ChatGPT no modo sandbox não procura `codex` no PATH; vai ao executor.
- FR-4: `presetInviteRequestSchema.preset` aceita `ai.appAi` de assinatura com `ai.subscriptionTermsAccepted: true`; os perfis continuam com o `invitePresetSchema` sem assinaturas.
- FR-5: tela: cópias dos novos motivos em Sua IA; no editor de preset do convite, as assinaturas cedíveis (só para o dono) com a confirmação dos termos antes de convidar.

## Non-functional requirements
- NFR-1: WCAG 2.2 AA nos cartões e na confirmação do convite, em 1440 e 390 px, sem rolagem horizontal.
- NFR-2: nenhuma chamada real ao Codex/ChatGPT nos testes (Codex falso, executor real).

## Acceptance criteria
- **AC-1 (FR-1, FR-2, BR-5)**
  - Given produção com o executor configurado e o Codex desligado em IA da aplicação
  - When o dono abre ⚙ → Sua IA
  - Then o cartão "Assinatura do ChatGPT" aparece "Desativado." com "Ligue em ⚙ Configurações → IA da aplicação → Ligar a assinatura do ChatGPT (Codex)", sem citar instalação nem `KB_CHAT_CODEX`
- **AC-2 (FR-2, FR-3)**
  - Given o Codex ligado e o executor logado
  - When o dono escolhe o cartão e clica "Testar conexão"
  - Then o cartão está disponível e o teste passa pelo executor (ok)
- **AC-3 (FR-2)**
  - Given o Codex ligado e o executor sem login, ou fora do ar
  - When o dono abre Sua IA
  - Then o cartão diz "Sem login no servidor." (com `codex login --device-auth`) ou "Indisponível no servidor." (contêiner do Codex não respondeu)
- **AC-4 (FR-2)**
  - Given o desenvolvimento local sem executor e sem `KB_CHAT_CODEX`
  - When o dono abre Sua IA
  - Then o cartão continua "Desativado." com a instrução de `KB_CHAT_CODEX=on` (como hoje)
- **AC-5 (FR-4, FR-5, BR-2, BR-4)**
  - Given o dono convidando com "Configurar agora" e a assinatura do Claude cedível
  - When escolhe "Assinatura Claude da aplicação", confirma os termos e convida
  - Then a pessoa nasce com a assinatura cedida e o histórico registra o dono, a data e os termos confirmados
- **AC-6 (BR-1, BR-2, BR-3)**
  - Given um convite que cede uma assinatura sem os termos, ou feito por um master que não é o dono, ou um perfil que tenta guardar uma assinatura
  - When a API recebe o pedido
  - Then recusa (400 sem termos ou no perfil, 403 para quem não é o dono)
- **AC-7 (BR-4)**
  - Given o Codex desligado (ou sem login)
  - When o dono abre "Configurar agora"
  - Then a assinatura do ChatGPT não é oferecida; e um master que não é o dono não vê nenhuma assinatura

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-3, AC-4 | unitário API (`providers.test.ts`) + integração (`lent-codex.integration.test.ts`) + unitário web (`ai-provider-form`) | executor real com Codex falso, `/status` falso para login/queda |
| AC-2 | integração (`lent-codex.integration.test.ts`) + E2E (`codex.spec.ts`) | teste de conexão pelo executor |
| AC-5, AC-6 | integração (`invite-profiles.integration.test.ts`) + contrato | auditoria com `termsAccepted` |
| AC-5, AC-7 | unitário web (`invite-preset-editor.spec.ts`) + E2E (`invite-presets.spec.ts`) | confirmação dos termos antes de convidar |

## Decisions
- 2026-10-27: perfis de convite **não** guardam cessões: um perfil é reutilizado por qualquer master, inclusive quem não pode ceder, e a confirmação dos termos é por pessoa (ADR 0019). A cessão no convite vale só para o preset enviado ("Configurar agora"), confirmado naquele momento.
- 2026-10-27: ao aplicar um perfil a uma pessoa existente, a cessão continua no campo de IA do mesmo editor (KBC-024), que já pede os termos; não se cria um segundo caminho.
- 2026-10-27: o cartão do ChatGPT fica bloqueado sem login ou sem o contêiner (o executor diz isso); antes ficava disponível e só falhava no primeiro turno.

## References
ADR 0019 (emendada: cessão no convite), ADR 0020, KBC-024, KBC-027, KBC-028 (BR-2 emendada); telas `docs/design/screens.md` (T6, T9).

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
