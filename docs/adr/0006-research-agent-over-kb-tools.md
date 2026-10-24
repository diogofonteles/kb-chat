# 0006 — Conversational research agent over kb tools

- Status: accepted (2026-10-24)
- Supersedes: [0004](0004-grounded-answers-single-llm-call.md) for answers (its spend controls stay)
- Amended by: [0009](0009-faster-research-profiles-and-streaming.md) (research profiles, `read_documents`, answers that stream at once with retract)
- Drivers: Q4 grounding, the owner's review of release 1 (2026-10-24), Q3 cost

## Context

The owner tried "Responder com IA" on the real collection. The single call over the top-8 passages (ADR 0004) answered "quais são os princípios herméticos" well. It then failed the follow-up, "quais são os 5 princípios ocultos": the answer is in the collection, but not in the 8 passages the search picked. The model could not look further, so it told the reader to search again. Each question was also answered without the previous ones.

The owner's goal is a tool that can find anything in the collection, connect it with what a model like Claude already knows, and work like a conversation with Claude.

## Decision

Answers come from a **research agent**: a tool-calling loop over the collection, with the conversation so far as context.

**Tools** (module `research`, read-only, the same functions for every provider):

| Tool | Does |
|---|---|
| `search_collection(query, mode, subjects?)` | Keyword, meaning or hybrid search over the index. Returns per hit: id, title, kb summary, snippet, subjects and genre. |
| `find_text(phrase, limit ≤ 20)` | Literal, accent- and case-insensitive phrase search over the body and kb summary of **every** cataloged document of the topic, like `grep`. Alternatives are joined with ` \| `. Returns per document: [n], title, occurrences per alternative and the passage around the first one (± 200 characters), ranked by occurrences. |
| `list_subjects(query?)` | The collection's subjects with document counts. |
| `read_document(id, around?, offset?)` | The kb summary and frontmatter, plus a window of the body (≤ 12,000 characters). The window centers on the occurrences of `around` when it is given. |
| `read_documents(ids[], around?)` | *Added by [ADR 0009](0009-faster-research-profiles-and-streaming.md):* up to 4 documents in one step, a 6,000-character window each. |
| `related_documents(id)` | The kb relations ("veja também"): examples, extensions and related documents. |

**Loop.** A provider with native tool calling (OpenRouter, OpenAI, Anthropic) runs the loop in the API:
- at most 15 tool steps per answer (*amended by [ADR 0009](0009-faster-research-profiles-and-streaming.md):* 15 in the deep profile, 6 in the fast one);
- **2,000 output tokens requested per model call**. An adapter may raise it where reasoning counts as output: Anthropic sends at least 8,000 (thinking is always on, ADR 0007) and OpenAI reasoning models (GPT-5.x) at least 4,000 at `reasoning_effort: low`. The spend guard prices each call at the budget the adapter really sends (`AgentLlmPort.maxOutputTokens`), not at 2,000;
- **reasoning is off by default on OpenRouter** (`KB_CHAT_REASONING=off`; `on` turns it back on). With 2,000 tokens per call a reasoning model may spend the whole budget thinking and return no text (seen with deepseek-v4-flash at 800 tokens), and DeepSeek's thinking mode expects its reasoning sent back on every tool turn, which the OpenAI wire format used here does not carry. The real eval with reasoning off (`work/KBC-008/eval-reasoning-off.md`) cited the expected document in 10/10; the search-read loop gives the model room to think between steps instead;
- the conversation is sent as prior user/assistant turns (text only, not tool results);
- *Superseded by [ADR 0009](0009-faster-research-profiles-and-streaming.md): text streams once its first sentence ends, and a call that then asks for tools has its text retracted (`retract`) and shown as "Pensando: …" in the steps.* **narration is never shown**: each model call's text is buffered. A call that ends with tool calls has its text dropped for the reader (the model keeps it in its context). A call that does not is the answer and is shown. To keep the answer streaming, once the buffer passes 800 characters with no tool call yet, the call is taken as the answer: its text streams from then on and any tool call it asks for afterwards is ignored. Narration in the real eval stayed under ~450 characters, so the hold costs the answer a few seconds before its first token and never leaks a preamble. The forced last call (no tools) streams at once, and its text is the answer even when the provider ignores `tool_choice: "none"` and also asks for a tool.

**Claude subscription.** Claude Code (`claude -p`) runs the loop itself:
- the same tools are served to it over MCP. *Amended by [ADR 0007](0007-ai-providers-and-local-settings.md):* not a stdio `kb-chat mcp` process per turn (it would rebuild the catalog and QMD every answer) but a per-turn Streamable HTTP endpoint of the API itself;
- built-in tools are disabled, and only `mcp__kb__*` is allowed.

**Prompt.**
- Search, re-phrase and read before answering. Never ask the reader to search again.
- Use `find_text` for exact phrases, names, lists and numbers ("cinco princípios", "doze princípios"), with synonyms and variants in one call (ocultos, secretos, velados, universais, adicionais). Never conclude that the collection lacks something without `find_text`.
- Cite collection facts with `[n]`; `n` numbers the documents the agent read.
- Knowledge from outside the collection is allowed when it helps. It is marked "(fora do acervo)" and never presented as coming from the documents.

**Stream to the client.** SSE events:
- `step`: a short, human description ("Buscando 'cinco princípios ocultos'", "Lendo 'Os Princípios Herméticos Ocultos'");
- `start` (the turn's model and billing, so a stopped turn is saved with them), `sources` (grows as documents are read), `token`, `done` (cost) and `error`.

**Spend.**
- Per-token providers keep ADR 0004's controls: the ledger, the daily cap and the credit check.
- The cap is checked before every model call, not only once, at the output budget the adapter really sends. The estimate shown is the typical cost of the configured model, not a precise number.

**`find_text` cache.** Ranked search only surfaces documents about the question's theme; the answer to "quais são os 5 princípios ocultos" sits in a document about space-time (`a-setuplicidade-do-espa-o-tempo`). `find_text` scans a per-topic, in-memory folded copy of the text (summary + body, one line, no markdown emphasis, accents and case folded, Latin-1 so V8 keeps it one byte per character). It is built lazily on first use and warmed at the start of every research turn, while the model thinks. It is keyed by the catalog object, so a catalog reload rebuilds it. Passages come from re-reading only the hit files. On the real vault (4,235 documents, 178 MB of markdown): about 4 s to build, about 200 MB of heap, and 70–500 ms per search with up to four alternatives.

## Options considered

1. **Agent with tools (chosen).** It answers what one retrieval misses, re-phrases by itself and uses relations and summaries. It costs a few cents with a cheap model and is free with a subscription. Latency grows with the number of steps; the steps are shown while it works.
2. **Bigger single retrieval** (more passages, `kb find` first). Cheaper, but still blind to what the first query misses, and still not conversational.
3. **Hand the vault folder to Claude Code** with file tools. It needs no code, but it loses the index, the facets and the relations, and works only with the subscription.

## Consequences

- Good: follow-ups keep context, and missing passages are searched for instead of reported. The same tool layer serves the in-API loop, Claude Code and, later, other MCP clients.
- Bad: cost and time vary per answer. Mitigations: the step cap, the per-step cap check, the visible steps and "Parar".
- Bad: the `find_text` cache holds the folded text of a topic in memory (about 200 MB for 4,235 documents). Acceptable for a single-owner local app; a larger vault would need an on-disk index instead.
- The model default moves to `deepseek/deepseek-v4-pro`, which supports tools and costs about US$ 0.23 per million input tokens. It stays overridable by `KB_CHAT_MODEL` and, after KBC-007, by Settings.
- The search-only mode stays for readers without a provider.
