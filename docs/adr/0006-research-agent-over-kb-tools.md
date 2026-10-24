# 0006 — Conversational research agent over kb tools

- Status: accepted (2026-10-24)
- Supersedes: [0004](0004-grounded-answers-single-llm-call.md) for answers (its spend controls stay)
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
| `list_subjects(query?)` | The collection's subjects with document counts. |
| `read_document(id, around?, offset?)` | The kb summary and frontmatter, plus a window of the body (≤ 12,000 characters). The window centers on the occurrences of `around` when it is given. |
| `related_documents(id)` | The kb relations ("veja também"): examples, extensions and related documents. |

**Loop.** A provider with native tool calling (OpenRouter, OpenAI, Anthropic) runs the loop in the API:
- at most 10 tool steps and 2,000 output tokens per answer;
- the model's reasoning stays on;
- the conversation is sent as prior user/assistant turns (text only, not tool results).

**Claude subscription.** Claude Code (`claude -p`) runs the loop itself:
- the same tools are served to it as an **MCP server** (`kb-chat mcp`, stdio);
- built-in tools are disabled, and only `mcp__kb__*` is allowed.

**Prompt.**
- Search, re-phrase and read before answering. Never ask the reader to search again.
- Cite collection facts with `[n]`; `n` numbers the documents the agent read.
- Knowledge from outside the collection is allowed when it helps. It is marked "(fora do acervo)" and never presented as coming from the documents.

**Stream to the client.** SSE events:
- `step`: a short, human description ("Buscando 'cinco princípios ocultos'", "Lendo 'Os Princípios Herméticos Ocultos'");
- `sources` (grows as documents are read), `token`, `done` (cost) and `error`.

**Spend.**
- Per-token providers keep ADR 0004's controls: the ledger, the daily cap and the credit check.
- The cap is checked before every step, not only once. The estimate shown is the typical cost of the configured model, not a precise number.

## Options considered

1. **Agent with tools (chosen).** It answers what one retrieval misses, re-phrases by itself and uses relations and summaries. It costs a few cents with a cheap model and is free with a subscription. Latency grows with the number of steps; the steps are shown while it works.
2. **Bigger single retrieval** (more passages, `kb find` first). Cheaper, but still blind to what the first query misses, and still not conversational.
3. **Hand the vault folder to Claude Code** with file tools. It needs no code, but it loses the index, the facets and the relations, and works only with the subscription.

## Consequences

- Good: follow-ups keep context, and missing passages are searched for instead of reported. The same tool layer serves the in-API loop, Claude Code and, later, other MCP clients.
- Bad: cost and time vary per answer. Mitigations: the step cap, the per-step cap check, the visible steps and "Parar".
- The model default moves to `deepseek/deepseek-v4-pro`, which supports tools and costs about US$ 0.23 per million input tokens. It stays overridable by `KB_CHAT_MODEL` and, after KBC-007, by Settings.
- The search-only mode stays for readers without a provider.
