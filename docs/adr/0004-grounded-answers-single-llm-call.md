# 0004 — Grounded AI answers with one OpenRouter call over retrieved passages

- Status: superseded by [0006](0006-research-agent-over-kb-tools.md) for answers; its spend controls stay (2026-10-24)
- Amended by: [0016](0016-house-ai-plan-and-secrets-at-rest.md) (the house plan keeps its own spend ledger)
- Drivers: Q3 cost, Q4 grounding

## Context

"Responder com IA" should cost about one cent. `kb find` ranks documents by asking the decision model one question per candidate. That spends money before the answer is even written. The free search already produces ranked, filtered passages.

## Decision

`answers` takes the current query and filters and runs the same search. It selects up to 8 passages: for each found document, the window of consecutive paragraphs (≤ 2,500 characters) with the most occurrences of the question's words, prefixed by the document's kb summary (revised 2026-10-24: the first occurrence was often only the title), and makes **one streaming chat completion** through OpenRouter, with model reasoning disabled (a reasoning model spent its whole 800-token budget thinking and returned no text) and at most 800 output tokens.

- The model defaults to the vault's `kb.toml` generation model (currently `deepseek/deepseek-v4-flash`), overridable by `KB_CHAT_MODEL`.
- The system prompt treats passages as quoted data, requires a `[n]` citation per claim, and requires "o acervo não traz informação suficiente" when the passages do not support an answer.
- The estimate is computed before the call, from the token counts and the model's price (OpenRouter `/models`).
- The real cost comes from the generation's usage. Each answer appends `{ts, model, tokens, usd}` to the spend ledger.
- The API refuses an answer when today's spend plus the estimate would pass `KB_CHAT_DAILY_CAP_USD` (`DAILY_CAP_REACHED`). It also refuses when the account balance (`/api/v1/credits`, total minus usage) is insufficient (`LLM_INSUFFICIENT_CREDIT`).

## Options considered

1. **One call over retrieved passages (chosen).** About US$ 0.002–0.01, and it streams.
2. **`kb find` then the generation call.** Better candidate precision, at several times the cost and latency. It is kept as a later "deep answer" option.
3. **A multi-turn agent with tools.** Out of scope for R1.

## Consequences

- Good: bounded, visible cost, and citations that map to documents the user can open.
- Bad: answer quality is limited by the top-8 passages.
- The OpenRouter balance check adds one HTTP call. Its result is cached for 60 s.
- Compliance: a test with a stub LLM asserts that the citations map to sources and that the cap refuses. Revisit after the research report (the share of searches that ask for AI).
