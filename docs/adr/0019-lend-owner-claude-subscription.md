# 0019 — The owner lends his Claude subscription to chosen people

- Status: accepted (2026-10-26)
- Amends: [0007](0007-ai-providers-and-local-settings.md) (subscriptions were the owner's only), [0016](0016-house-ai-plan-and-access-policy.md) (a second app AI, `claude-subscription`, and the `app-subscription` plan)
- Drivers: KBC-024; the owner's decision of 2026-10-26 ("o master cede a assinatura Claude do dono a usuários específicos")

## Context

ADR 0016 named a second app-owned AI, the owner's Claude subscription on the VM, to be handed out person by person, never as a default. Anthropic's terms forbid using Free/Pro/Max subscriptions to serve other people ([The Register, 2026-02-20](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546)). The owner knows this and wants the choice anyway, for a few invited people, as his own informed decision. The subscription runs through the official Claude Code CLI already logged in on the server (ADR 0007); kb-chat never sees the credential.

## Decision

- **A second app AI.** `APP_AIS` becomes `house`, `claude-subscription`, `none`. The house default (`defaultAppAi`) stays `house` or `none`: the subscription is never a default, and "também para os próximos" with it is invalid in the contract.
- **Only the owner lends it; anyone who is a master may take it back.** Granting `claude-subscription` (`PATCH /api/v1/people/:id`, `POST /api/v1/people/ai-assignment`) answers 403 to any other master. Granting needs `subscriptionTermsAccepted: true` in the same request, which the screen sends only after its confirmation names the terms; without it the contract refuses (400). The person's AI history records the change with `termsAccepted: true`, beside who and when (ADR 0016's audit trail).
- **The lent turn.** `AppAiPlan` gets a handler for `claude-subscription`, fed by the registry: available while `claude` is on PATH; its runner is a `ClaudeCliRunner` with the **owner's** chosen models for that profile and **no escalation** (as on the house plan, so a fast question counts 1). `LentSubscriptionRunner` wraps it: it reserves the person's daily quota first (the house quota, the same weights; refunded when the turn fails before any answer), relays the turn, writes one entry of US$ 0 with `billing: 'subscription'` to `house-spend.jsonl`, and labels `done` with `plan: 'app-subscription'`, `billing: 'subscription'` and `remaining`. The registry's owner check for subscriptions stays for a person's *own* choice; the lent path goes through the app AI, not through the person's settings.
- **Unavailable means not served.** When the CLI is missing, `available('claude-subscription')` is false and the person falls back as ADR 0016 says (their own AI, else none). The people screen says the subscription is not ready on the server (`GET /api/v1/house-ai` → `subscriptionAvailable`).
- **Told to the person.** The status gives `appAi: 'claude-subscription'`; Settings shows a highlighted notice ("Você está usando temporariamente a IA da aplicação (assinatura do Claude do administrador)") with a button to their own AI, and each answer says "Incluído na assinatura do administrador".
- **E2E.** The E2E server injects a lent subscription backed by the stub runner, so the screens are tested without a CLI; integration tests run the real `ClaudeCliRunner` against the fake CLI.

## Options considered

1. **A per-person app AI with an explicit, recorded confirmation, owner-only (chosen).** The owner decides each case knowingly; the record shows who agreed to what and when.
2. **Any master may lend it.** Simpler, but it is the owner's personal subscription and the terms risk is his.
3. **A subscription for everyone by default.** Rejected by the owner and against ADR 0016.
4. **Not offering it.** Safest with the terms, but the owner asked for it.

## Consequences

- Good: chosen people research with Claude at no per-token cost, and see that it is temporary.
- Bad: it breaks Anthropic's consumer terms; the account may be limited or closed. The owner accepted this risk; the confirmation text says so every time.
- Bad: the subscription's usage limits are shared with the owner; the daily quota per person is the only guard (no token meter for the CLI).
- Revisit when: Anthropic changes its terms or opens subscription sign-in to third parties; the owner wants an hourly limit.
- Compliance: integration tests (owner-only grant, terms, never default, quota, ledger entry, plan) with the fake CLI; web tests for the confirmation and the notice; E2E with the stub-backed lent subscription.
