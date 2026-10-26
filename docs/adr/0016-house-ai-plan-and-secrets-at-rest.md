# 0016 — The house AI plan, the AI access policy, secrets encrypted at rest and no AI defaults in production

- Status: accepted (2026-10-26)
- Amends: [0004](0004-grounded-answers-single-llm-call.md) (a second spend ledger for the house), [0007](0007-ai-providers-and-local-settings.md) (provider resolution, keys on disk, a `house` provider), [0008](0008-google-login-and-permissions.md) ("guests bring their own key": they now get the house plan by default)
- Drivers: KBC-022; the owner's decision of 2026-10-26 ("Nada deve ser configurado por nós via código; tudo pela UI do usuário"; very low, transparent cost; few invited users), Q3 cost, Q-security

## Context

Until now a guest had no AI unless they pasted a key (ADR 0008), and the owner's AI came from the Claude CLI on PATH or from env keys (ADR 0007 BR-4). Production therefore needed an `OPENROUTER_API_KEY` in the VM's `.env` to give anyone AI. The owner wants the opposite: everything configured in the UI, invited people researching with no setup, cost close to zero and always visible.

Research of 2026-10-26:

- Anthropic forbids using Free/Pro/Max subscription OAuth in third-party products; products must use API keys ([The Register, 2026-02-20](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546)).
- OpenAI's "Sign in with ChatGPT" with plan billing launched on 2026-09-29 for launch partners only; open availability is unconfirmed, so ChatGPT/OpenAI stays API-key only.
- OpenRouter: models ending in `:free` cost nothing, at 20 requests/min and 50 requests/day while the account bought less than US$ 10 of credits ever, 1,000/day from US$ 10 ([limits](https://openrouter.ai/docs/api-reference/limits)); `GET /api/v1/key` reports `free_model_daily_requests { used, limit, remaining }`. The `openrouter/free` router picks a free model. A `models` array falls back on rate limits, downtime and refusals and bills only the model that answered, named in the response's `model` ([model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)). OAuth PKCE lets a person connect their account; the app receives a user-controlled key ([OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth)). Per-key credit limits with a monthly reset exist, set through a management key's `/api/v1/keys` ([management keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)).
- Every tool step of the research agent is one model request: a fast turn takes up to 7, a deep one about 16, an exhaustive one up to 80 plus 300 sub-agent steps (ADR 0013, 0014).

## Decision

**A `house` provider: the app's shared OpenRouter account, configured by a master in the UI.**

- *Connection.* "IA da aplicação" (a Settings section for masters) connects the house account with **OAuth PKCE** or a pasted key. `POST /api/v1/openrouter/connect { purpose }` creates a 32-byte `code_verifier`, its S256 `code_challenge` and a 24-byte `state`, kept **in memory** for 10 minutes and bound to the signed-in principal and the purpose, and answers the authorization URL (`https://openrouter.ai/auth?callback_url=<WEB_ORIGIN>/api/v1/openrouter/callback&code_challenge=…&code_challenge_method=S256&state=…&key_label=Nova Alexandria`). The callback (`GET`, signed in) takes the pending entry once, checks the principal (and, for `house`, the master role again), exchanges the code at `POST https://openrouter.ai/api/v1/auth/keys { code, code_verifier, code_challenge_method: "S256" }` (8 s timeout), stores the key and redirects to `/?openrouter=connected` (or `?openrouter=error`). The verifier never leaves the server; a restart only means clicking again. The purpose is `house` here; KBC-023 adds `own` on the same route.
- *Configuration* (`KB_CHAT_STATE_DIR/house-ai.json`, 0600, atomic, module `house-ai`): the sealed key with `via`, `last4`, `connectedAt`, `connectedBy`; the free chain (`auto` or the master's ordered list), `includeRouter` (`openrouter/free` last, on by default), an optional paid model (off by default), the default daily quota (5), an optional sealed management key, and the per-person OpenRouter keys it provisioned.
- *Free models, live.* `GET https://openrouter.ai/api/v1/models` (public) is filtered to ids ending in `:free` whose `supported_parameters` contain `tools` (the agent needs tool calling), sorted by context length, cached 24 h; a failed refresh keeps the last list. With `auto`, the chain is the first five of that list, then `openrouter/free`. Slugs are never hard-coded except the router's.
- *Requests.* `OpenRouterAdapter` takes an optional model chain and sends it as `models`, at most 3 per request (the documented cap of OpenRouter's Anthropic-style `fallbacks`; we stay under it for both shapes); when a whole window answers 429, 402, 5xx or a mid-stream error before any text, the adapter tries the next window, then fails with `AI_CAPACITY_EXHAUSTED`. The `model` field of the stream is the model that answered; it becomes `done.model` and the ledger's model.
**The AI access policy: which AI serves each person, chosen by a master** (owner's requirements of 2026-10-26, same day):

- *App-owned AIs.* The app owns at most two AIs a master can hand out: **"Plano da casa"** (the house OpenRouter account above) and, from KBC-024, **"Assinatura Claude da aplicação"** (the owner's subscription on the VM). A person's **assignment** (`person.ai.appAi`) is one of `house`, `claude-subscription` (KBC-024), `none` ("Nenhuma: a pessoa usa a própria IA ou só a busca") or `default` (follow the house default). The **house default** (`house-ai.json` → `defaultAppAi`: `house` or `none`, initially `house`) applies to every person left on `default`, including people invited later. The owner's subscription is never a default: it is granted person by person (KBC-024).
- *Grant to one, several or all.* `PATCH /api/v1/people/:id` sets one person; `POST /api/v1/people/ai-assignment { personIds | "all", appAi, setDefault? }` sets several, or everyone at once (and, with `setDefault`, the default for future people too). Revoking is the same call with `none` (or `default` when the default is `none`). Every change appends `{ appAi, by, at }` to the person's `ai.history` (the last 50), the audit trail of who granted or revoked what and when.
- *Precedence* (replaces ADR 0007 BR-4), per research turn:
  1. **Enforced assignment.** A master may tick "Usar sempre a IA da aplicação" (`person.ai.enforced`); then the assigned app AI serves the person even when they configured their own.
  2. **The person's own AI** (KBC-023), when they configured one and chose it in Settings (`provider` other than `app`/`none`): **"Sua IA"**, paid by them.
  3. **The assigned app AI** (or the house default): **"IA da aplicação (cedida pelo administrador)"**, paid by the app. A person may also choose it explicitly (`provider: 'app'`).
  4. The stub (`KB_CHAT_LLM=stub`, tests only); else none (search only).
  The master's own AI follows the same rules: the owner's Settings choice serves the owner.
- *Shown on both sides.* The people screen shows each person's assignment, whether it is enforced and what serves them now ("Sua IA: OpenRouter" or "IA da aplicação: Plano da casa"); the person's Settings and every answer say which AI served and who pays (`GET /api/v1/ai/status` → `{ source: 'app' | 'own' | 'none', appAi, provider, … }`).
- *No key moves between environments in code.* The owner's local OpenRouter key stays in his local Settings; in production he connects or pastes it in "IA da aplicação".

**Per-person limits** (on the person record, `people.json`, master-only through `PATCH /api/v1/people/:id`):

- `ai.dailyResearches`: researches per day on the house plan (null = the house default, 0 = none). Weights: **fast 1, deep 2, exhaustive 5**, because a deep turn spends about twice the requests of a fast one and an exhaustive turn is bounded by its budgets, not by the question. The units are reserved when the turn starts and refunded when it ends in an error before any model answered. The day is the server's local day (the VM runs in UTC, like OpenRouter's counter).
- *Capacity.* Before the turn, `GET /api/v1/key` (cached 60 s) must report enough free requests left today for the profile: **fast 8, deep 16, exhaustive 100** (the exhaustive turn may spend more; the number keeps one exhaustive question from starving the day). Otherwise, without an active paid fallback, the turn is refused with `AI_CAPACITY_EXHAUSTED` and nothing is counted.
- `ai.paidFallback { enabled, monthlyCapUsd }` (off by default). The paid model enters a person's chain only when the house has one, the person's fallback is on, and their house spend this month plus the call's estimate (prompt + output budget at the paid model's price) fits the cap. With a management key, enabling it also creates an OpenRouter key for that person (`POST /api/v1/keys { name, limit, limit_reset: "monthly" }`), used for that person's house requests; changing the cap patches it and turning it off deletes it, so OpenRouter enforces the same cap. Without a management key, our ledger is the only guard (it can overshoot by at most one call).
- House spend goes to its own ledger (`house-spend.jsonl`), so a person's own-key daily cap (ADR 0004) is not affected; house units go to `house-usage.jsonl`. Both are JSONL in the state folder like the spend ledger.

**Transparency.** `done` gains `plan` (`house` | `own`; KBC-024 adds `app-subscription`) and `remaining` (house researches left today); `billing` gains `free` (US$ 0 with free models: OpenRouter `:free` or `openrouter/free`). The model is the one that answered. The saved turn keeps `model`, `billing` and `plan`. `GET /api/v1/ai/status` gives the active plan and today's quota for the composer and Settings. Refusals before streaming are `HOUSE_QUOTA_EXHAUSTED` (429) and `AI_CAPACITY_EXHAUSTED` (503); the web offers to wait until tomorrow or to connect one's own AI.

**Secrets encrypted at rest.** Every stored provider key (each person's `settings/<principal>.json` and the house file, management and provisioned keys included) is sealed with **AES-256-GCM**: a random 12-byte IV per value, the 16-byte tag, stored as `enc:v1:<iv>.<tag>.<ciphertext>` (base64url). The 32-byte master key comes from `KB_CHAT_SECRETS_KEY` (base64), generated once on the VM with `openssl rand -base64 32` written straight to `.env`, never echoed. The settings store seals on write and opens on read; a value without the prefix (a file from before this change) is accepted once and the file is rewritten sealed on the next load. A value that does not open (another key) is dropped with a warning and the person sees "chave não salva". Production (`NODE_ENV=production` or a non-loopback `HOST`) refuses to start without a valid key; in development, without the variable, the API creates `<state>/secrets.key` (0600) once. The state backup (ADR 0010) never contains the production key, which lives only in `.env`.

**No AI defaults in production.** The ADR 0007 BR-4 defaults (the Claude subscription when `claude` is on PATH, then `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) apply only with `KB_CHAT_AI_DEFAULTS=local`, meant for the owner's Mac; production refuses it, and refuses `KB_CHAT_LLM=stub`. In production the owner picks "Assinatura do Claude" in Settings like any other choice. The env keys stay readable for that local mode only.

## Options considered

1. **House account on OpenRouter free models, an assignment and a quota per person, keys sealed (chosen).** Zero running cost, one account, the master controls everything from the UI.
1b. **The person's own AI always wins, no enforcement.** Simpler, but the owner asked to be able to assign otherwise; enforcement is one flag per person, off by default.
2. **Keep env keys on the VM.** Configuration by code, a paid key shared by everyone, no per-person control: what the owner rejected.
3. **Every guest brings a key (ADR 0008).** Most guests cannot or will not; KBC-023 keeps it as an option.
4. **The owner's Claude subscription for everyone.** Forbidden by Anthropic's terms for serving other people; KBC-024 handles the owner's informed exception per person.
5. **Encrypt with a key derived from a passphrase typed at boot.** Breaks unattended restarts and automatic rollback (ADR 0010).

## Consequences

- Good: production needs no AI key; an invited person researches at once; cost is US$ 0 unless the master opts a person into the paid fallback, and every answer says what it cost and which model answered.
- Bad: free models are slower and weaker than the deep defaults and may be unavailable; the fallback chain and the clear refusal messages are the mitigation, and KBC-023 lets a person bring their own AI.
- Bad: the 1,000 free requests a day need US$ 10 of credits bought once on the house account (50/day otherwise); the runbook and the screen say so.
- Bad: losing `KB_CHAT_SECRETS_KEY` makes every saved key unreadable (people reconnect); the runbook keeps a copy in the owner's password manager.
- Threats added: the OAuth callback is a signed-in GET; `state` is single-use, bound to the session's principal and short-lived, so a forged callback cannot bind someone else's key (CSRF) and a replayed one finds nothing. The redirect target is fixed (`/`), never taken from the request.
- Breaking for local use: `pnpm dev:api` no longer picks the Claude CLI or the env keys unless `.env` sets `KB_CHAT_AI_DEFAULTS=local` (documented in `.env.example` and CLAUDE.md).
- Compliance: tests read the settings and house files, the log and every response for the plain key; config tests for the production refusals; fake OpenRouter for OAuth, `/key`, `/models` and chat (no real call).
