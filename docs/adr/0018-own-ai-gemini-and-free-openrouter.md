# 0018 — One's own AI: Gemini, OpenRouter connected by OAuth on free models, and a guided setup

- Status: accepted (2026-10-26)
- Amends: [0007](0007-ai-providers-and-local-settings.md) (a sixth provider, per-provider plans, the last test kept), [0016](0016-house-ai-plan-and-access-policy.md) (the OAuth connection gains the `own` purpose; `free` billing for one's own free models)
- Drivers: KBC-023; the owner's decision of 2026-10-26 (everything configured in the UI; very low, transparent cost)

## Context

KBC-022 gave invited people the app's AI. Some will want their own: more researches, better models, privacy. Pasting an API key into a form with no guidance is what most of them cannot do. Research of 2026-10-26: OpenRouter lets a person connect their account by OAuth PKCE and returns a key they control ([OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth)); Google AI Studio gives a free Gemini key whose free tier includes function calling, with the data of the free tier usable by Google to improve its products ([pricing](https://ai.google.dev/gemini-api/docs/pricing)); Gemini 3 returns `thoughtSignature`s on function calls that must come back unchanged, and every `functionResponse` must carry the call's `id` and `name` ([thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)); `parametersJsonSchema` accepts full JSON Schema for function declarations. Anthropic forbids subscription OAuth in third-party products (The Register, 2026-02-20) and "Sign in with ChatGPT" is not open: Claude and OpenAI only by API key.

## Decision

- **OpenRouter by OAuth for oneself.** The KBC-022 connection takes `purpose: 'own'` for a person with `own-ai-settings`; the callback stores the key in their settings (sealed, ADR 0017) and chooses OpenRouter.
- **OpenRouter plans** (`settings.ai.openrouter`): `mode: 'free'` (the default of a new connection) sends the free chain (the master's live list of KBC-022, or the person's own choice, then `openrouter/free`) through `models`, exactly as the house plan does (`HouseLlm` with the person's key); `mode: 'models'` keeps ADR 0009's fast and deep models. An optional paid model enters the end of the chain only while the person's spend today plus the call's estimate fits their daily cap (ADR 0004), reserved per turn while it runs (the house's `PaidMeters`). A file without the field and with a saved OpenRouter key reads as `models` (what it did before).
- **Gemini** (`GeminiAdapter`, REST `v1beta/models/<model>:streamGenerateContent?alt=sse`, key in `x-goog-api-key`): system prompt as `systemInstruction`, tools as `functionDeclarations` with `parametersJsonSchema`, `toolConfig.functionCallingConfig.mode` `AUTO` or `NONE`; a model turn with function calls is kept and sent back unchanged (its `thoughtSignature`s and call ids), keyed by its first call's id like the Anthropic adapter; tool results go back as one user turn of `functionResponse { id, name, response: { result } }`. A model turn the adapter did not write itself (the fast model's turn after an escalation to the deep one, or a turn from before a restart) is rebuilt with Google's placeholder `thoughtSignature: "skip_thought_signature_validator"` on its first call, since one model's signatures are not valid for another; escalation from fast to deep therefore works as for the other providers. Defaults: fast `gemini-3.5-flash-lite`, deep `gemini-3.8-flash` (both with a free tier and function calling, 2026-10-26). `settings.ai.gemini.tier`: `free` (default; priced at zero, billing `free`) or `paid` (priced from Google's list, unknown models at the dearest; the Flash prices double on 2027-01-01). 400 `API_KEY_INVALID`, 401 and 403 are a refused key; 429 is the provider's capacity.
- **Paid fallback in flight.** The registry keeps one set of meters per process: each turn of one's own OpenRouter with a paid model opens a meter when it starts and closes it after its spend is in the ledger, so parallel turns of the same person count each other's paid calls. A free tier (`billing: free`) is never stopped by the daily cap.
- **`free` billing for one's own AI.** A per-token turn that cost US$ 0 and whose answering model is free (`:free`, `openrouter/free`, Gemini's free tier) is reported `free`, as on the house plan.
- **Status.** `GET /api/v1/ai/status` adds today's spend and cap, whether the AI is free, and the last connection test (`settings.ai.lastTest`, written by "Testar conexão": provider, ok, code, time).
- **Guide.** ⚙ > IA becomes "Sua IA": the status card, then one card per option with numbered steps, cost, privacy and limits, and direct links (openrouter.ai, aistudio.google.com/apikey, console.anthropic.com, platform.openai.com). The subscriptions stay the owner's, in their own cards (KBC-024 lends the Claude one).

## Options considered

1. **Guided own AI with OAuth for OpenRouter and Gemini's free tier (chosen).** One click for OpenRouter, a free option that needs no card, and clear costs.
2. **Keys only (ADR 0007).** Too hard for most guests; no free default.
3. **Gemini through OpenRouter.** One provider less, but the person's free Google tier would not apply.
4. **Google's OpenAI-compatible endpoint.** Fewer lines, but it drops thought signatures, which Gemini 3 requires for function calling.

## Consequences

- Good: a guest gets a free AI of their own in a minute (OpenRouter free models, or Gemini free) and always sees who pays.
- Bad: Gemini's free tier may train Google's models on the questions and passages; the guide says so before the key is pasted.
- Bad: free models are slower and less capable than paid ones; the guide says so and offers the paid options.
- Revisit when: Google changes the free tier or the thought-signature contract; OpenRouter changes OAuth; or Anthropic/OpenAI open subscription sign-in to third parties.
- Compliance: Gemini adapter tests on recorded streams (text, function calls with signatures, errors); the own OAuth against the fake OpenRouter; no real provider call in automated tests.
