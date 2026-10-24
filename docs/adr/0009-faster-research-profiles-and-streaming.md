# 0009 — Faster research: profiles, a model per profile and answers that stream at once

- Status: accepted (2026-10-24)
- Amends: [0006](0006-research-agent-over-kb-tools.md) (the narration rule, the step cap, the tools) and [0007](0007-ai-providers-and-local-settings.md) (one model per provider, the Claude subscription's default model)
- Drivers: KBC-011 (the owner's test: "achei um pouco demorado na resposta"), Q1 latency, Q4 grounding

## Context

With the Claude subscription and the CLI's default model (Opus 5.5), "quais são os 5 princípios ocultos" took about 32 s on the real vault: about 5 s before the first step, 14 s of research in 10 mostly sequential steps and 13 s of writing. ADR 0006 held each model call's text until it passed 800 characters, so the reader saw nothing for about 18 s. The owner approved: Sonnet by default, configurable, and the answer shown as soon as it starts.

## Decision

**Two research profiles**, chosen per question by a "Rápido | Profundo" toggle in the research composer (the default comes from Settings; the browser remembers the last choice). The request carries `profile: 'fast' | 'deep'` (default `fast`).

| | Fast (default) | Deep |
|---|---|---|
| Model | the provider's fast model | the provider's deep model |
| Tool steps | at most 6 | at most 15 (ADR 0006) |
| Prompt | one parallel round of search and `find_text`, one batched read, a focused answer | ADR 0006's prompt |
| Claude Code effort | `--effort=low` | the CLI's default |

**A fast and a deep model per provider** (replaces ADR 0007's single `ai.model`). Settings keep `ai.models[provider] = { fast?, deep? }`, so switching providers and back keeps each choice. A file written before this ADR reads its single `model` as both profiles of its provider. The subscription CLIs accept only an allowlist (contract `MODEL_ALLOWLISTS`): Claude Code `sonnet`, `opus`, `haiku`, `fable` and their full ids; Codex `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`. Per-token providers take any id that passes ADR 0007's regex.

| Provider | Fast | Deep |
|---|---|---|
| Claude subscription | `sonnet` (Sonnet 5.5) | `opus` (Opus 5.5) |
| Anthropic API | `claude-sonnet-5-5` | `claude-opus-5-5` |
| OpenRouter | `deepseek/deepseek-v4-flash` | `deepseek/deepseek-v4-pro` (`KB_CHAT_MODEL` sets both) |
| OpenAI API | `gpt-5.4-mini` | `gpt-5.4-mini` (the existing default; dearer models stay a choice) |
| ChatGPT subscription | the CLI's own | the CLI's own |

**Answers stream at once; text written before a tool call is retracted** (replaces ADR 0006's 800-character hold). One `AnswerStream` serves the in-API loop and the CLI runners, which report the same three moments (text, tool call, end of a model call):
- each model call writes one **segment**; `token` events carry its number;
- a segment's text is shown as soon as its first sentence ends (at most ~120 characters held), so a preamble about the agent's own work ("Tenho tudo o que preciso.") can still be dropped; an exclamation ("Ótimo!") does not end that sentence;
- when the call that wrote a shown segment then asks for tools, the server sends `{ type: 'retract', segment }` and the web takes that text out of the answer;
- a first sentence that announces research ("Vou buscar…", "Deixe-me ler…") is held until its call ends, so the common narration never flashes on screen;
- the forced last call (no tools) is the answer even if the provider also asks for a tool.

The retracted text moves, collapsed, into the steps list as a muted "Pensando: …" item, instead of being dropped. The reader keeps a trace of why the text disappeared (no content vanishes unexplained, UP-01), the answer stays clean, and the steps list is where Claude shows its intermediate work too. Saved turns keep only the answer text; the thoughts live only in the session.

**Fewer round trips.**
- `search_collection` and `find_text` show the kb summary and a passage of about 400 characters per hit. The `find_text` passage leans forward (120 characters before the occurrence, 320 after), because what a phrase like "cinco princípios" names usually follows it. On the real vault, the five principles sit 220 characters after the first "Cinco Princípios Universais" of `a-setuplicidade-do-espa-o-tempo`, outside the old ±200 passage.
- A new tool, `read_documents(documents[], around?)`, reads up to 4 documents in one step with a 6,000-character window each, and shows one "Lendo …" step per document.
- The MCP tools declare `readOnlyHint` and `openWorldHint: false`. Claude Code 2.1.310 already runs two MCP calls of one message in parallel (measured with and without the hint: both start within 2 ms); the hint states the contract.

**Warm-ups.**
- The API builds the start collection's `find_text` cache in the background at boot (Settings' default collection, else `KB_TOPIC`, else the first one) and logs how long it took.
- **No warm Claude Code process pool.** Measured on 2026-10-24 (Claude Code 2.1.310, Sonnet): `claude -p` reaches its init event 0.5 s after spawn, the Streamable HTTP MCP handshake takes about 30 ms, and a process kept waiting with `--input-format stream-json` saves only those 0.5 s on the first event. The ~5 s the owner saw before the first step is the model's first round, not the CLI's start. A pool would have to pre-open a turn token with late-bound tools, one process per principal, model, profile and topic, plus idle timeouts and crash handling, to save half a second. Not worth its failure modes.

**Evaluation.** `agent-eval` takes `--profile fast|deep`, reports the time to the first text, when each step came and how many texts were retracted, and serves the kb tools to a subscription CLI on an MCP endpoint of its own (before this, a subscription eval ran the CLI against whatever listened on `PORT`, usually nothing, so the agent had no tools).

## Options considered

1. **Profiles with a model each and streaming with retract (chosen).** The reader sees text as soon as it is written; the rare thinking-aloud text is taken back in place and kept in the steps.
2. **Keep the hold, lower it to ~300 characters.** Still holds every answer for seconds and still leaks a long narration.
3. **Drop retracted text silently.** Simpler, but text vanishing with no trace reads as a glitch.
4. **One model, Sonnet, for everything.** Faster, but the deep answers (the five principles, for one) need Opus's longer research.

## Consequences

- Good: the first answer text no longer waits for 800 characters; the default profile answers in about half the time of the deep one; the owner can pick the model per profile for every provider, subscriptions included.
- Bad: a reader may briefly see text that is then taken back. Mitigations: narration-looking sentences are held, the prompt still asks for no narration, and the text stays visible as a thought.
- Bad: in the fast profile, Sonnet may stop at "o acervo não nomeia" for questions whose answer needs more than 6 steps; the deep profile is the way to dig further.
- Measured (KBC-011, `work/KBC-011/eval-*.md`): see the KBC-011 eval reports for the figures of each run.
- The research event contract changes (`token.segment`, `retract`); the web is the only client.
