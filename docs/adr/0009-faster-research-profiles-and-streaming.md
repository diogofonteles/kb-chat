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

**Auto-escalation from fast to deep** (owner-aligned decision, 2026-10-24: the reader should never get "not in the collection" when a deeper pass would find it). With Settings' "Aprofundar automaticamente" on (the default), the fast prompt tells the model that, when its research cannot fully answer from the collection (nothing found, an incomplete list, doubt), it must write only a line with `<<APROFUNDAR>>` and a short reason. The runner then:
- detects the marker (the answer stream holds a segment that starts with `<` until its call ends), or, as a safety net, a fast answer that gives up on the collection ("não nomeia", "não encontrei", "não traz", "não há informação");
- takes back anything shown (`retract`), emits a `deepen` step ("Aprofundando a pesquisa…") and goes on in the **same turn** with the deep profile;
- in-API loop: the same messages (every tool result stays), the deep model and the deep prompt, a note with the reason, and the rest of the deep budget (15 steps in all), with the same `[n]` numbering;
- subscription CLIs: a second CLI run with the deep model, the same turn tools (so the same numbering), the rest of the deep budget, and the fast pass's findings (its reason, its steps and the numbered documents) in the input;
- `done` carries the deep model and `escalated: true`. A deep turn, or a turn with the setting off, never escalates.
- The marker never reaches the reader: once a segment is shown, text from a `<` on is held until the next character shows it is not `<<`, and the marker is taken out of what is shown and of the "Pensando" text. The deep model's conversation keeps only what the fast model wrote before the marker.
- In-API loop: the hand-over note goes as a **user** turn, after the fast text, so the deep request never ends on an assistant turn (Anthropic moves `system` messages to the top, and current Claude models refuse a prefill). The fast pass's "answer now" note of a spent budget is dropped; while it may still escalate, a fast turn that spends its budget is told to answer or write the marker, not to list what is missing.
- The safety net (`absence.ts`) reads only the answer's first paragraph (after any heading): a negation ("não", "nenhum", "nem") near the collection as subject or place (acervo, documentos, textos, fontes, material, eles) and a verb of saying, naming or showing (diz, nomeia, lista, menciona, traz, revela, cita, aparece, consta, explica, especifica, detalha, dá…, unstressed pronouns allowed: "não os nomeiam"), the agent's own "não encontrei / localizei", "não há informação", and explicit refusals ("de propósito", "deliberadamente") anywhere in the paragraph. A sentence with a citation, or one that goes on to answer ("…, mas descreve o ciclo [1]"), is content, and so is a paragraph that already answered with a citation before it. 24 give-up phrases (two of them verbatim from QA) and 12 answers are table tests.
- The fast prompt also says: never tell the reader the collection does not have, say or name something; write the marker instead when `find_text` with the variants was not used, or found nothing.
- Spend: an escalated per-token turn writes one ledger entry per model (fast and deep), each with its share.
- Where the fast and the deep default model are the same (OpenAI API, ChatGPT subscription), escalation still runs: the deep pass has the deep prompt and the rest of the 15 steps. Choosing a different deep model in Settings makes it count more.

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
- Bad: an escalated answer takes about as long as a deep one, plus the fast pass. Questions the fast pass settles stay fast.
- Bad (cost): with a per-token provider, auto-deepening (on by default) spends the deep model, the dearer one, on every escalated turn; only the daily cap bounds it. The Settings hint says so, and the eval reports how many turns escalate (3/10 on the real vault).
- Measured after the review and QA fixes (commit d0f4cec, `work/KBC-011/eval-fast.md`): median first text 10.1 s, median total 10.7 s (longest 40.6 s), 10/10 cite the expected document, both five-principles answers name all five, 2/10 escalated. The owner's question asked 5 times in a row in the fast profile (`eval-nfr5-5runs.md`): 5/5 name all five, all 5 escalated, about 24–39 s to the first text and 27–59 s in all.
- An escalated turn takes about 30 s to its first text (the fast pass, then the deep one). Accepted here for never answering "not in the collection" when a deeper pass finds it; the owner is asked to confirm.
- Breaking contract, accepted: `ai.model` became `ai.models[provider] = { fast, deep }`; a `PUT` with `model` is now a 400 (strict schema). The web is the only client and ships with the API; files on disk are migrated on read. The research events change the same way (`token.segment`, `retract`, the `deepen` step, `done.escalated`).
- The deep pass starts its research over. Told the fast pass's reason and steps (first version), Opus followed the same false lead ("oitavo, nono princípio") and the escalated five-principles answer still missed the list. It now gets only the numbered documents (so `[n]` stays valid) and is asked to redo the literal search and read every document whose passage carries the phrase.
- Measured with auto-escalation (fast profile, default settings, `work/KBC-011/eval-fast.md`, commit 90635c7): median first text 9.9 s, median total 12.1 s (longest 35.0 s, an escalated turn), 9/10 cite the expected document, both five-principles answers name all five (2/2), 3/10 turns escalated to Opus. "First text" counts text that is later retracted (3 turns), as the reader sees it.
- Measured before auto-escalation: in the fast profile, Sonnet stopped at "o acervo não nomeia" on the five-principles questions (0/2), although `find_text` had shown the list; escalation hands those turns to the deep profile.
- Measured on 2026-10-24, real vault, Claude subscription, 10 questions (`work/KBC-011/eval-*.md`, two runs per profile). Fast (Sonnet): median first text 10.8 s and 11.3 s, median total 12.1 s and 12.4 s (longest 14.6 s), 8/10 cite the expected document in both runs, and the five principles are not named (0/2). Deep (Opus): median first text 22.7 s and 17.8 s, median total 30.2 s and 26.0 s, 9/10 and 10/10 cite, and both five-principles answers name all five. Before: about 18 s to the first text and 32 s in all on the owner's question; KBC-008's OpenRouter run had a median first text of 21.7 s and a median total of 36.8 s.
- Where the fast profile's time goes (step timings in the report): about 2.5 s to the first tool result (0.5 s of CLI start, one model round), two or three rounds of parallel tools by about 5 s, then 4–6 s before the final call writes its first character, with no visible thinking blocks. Smaller reads (5,000 characters), `--effort=low` and `MAX_THINKING_TOKENS=0` left that last wait unchanged, so the first text lands at about 10–11 s: KBC-011 NFR-1 (≤ 10 s) is missed by under a second, NFR-2 (≤ 20 s) is met.
- The research event contract changes (`token.segment`, `retract`); the web is the only client.
