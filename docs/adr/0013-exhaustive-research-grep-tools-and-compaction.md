# 0013 — Exhaustive research: grep-like tools with paging and filters, and the exhaustive profile

- Status: accepted (2026-10-25)
- Amends: [0006](0006-research-agent-over-kb-tools.md) (the tool contract: `find_text`, `search_collection`, `read_document`, a new `list_sources`) and [0009](0009-faster-research-profiles-and-streaming.md) (a third research profile)
- Drivers: KBC-017 (the owner: research "sem limitações", "temos que nos espelhar no funcionamento do Claude"), Q4 grounding, Q3 cost
- Amended by: [0014](0014-research-subagents.md) (the exhaustive profile delegates to parallel sub-researchers)

## Context

The owner asked the deep profile for every work cited by the author José Laércio do Egito across the collection (4,235 documents, topic hermetismo). The agent said it could not be complete, and it was right about why:

- `find_text` returned at most 20 documents, ranked by occurrences; big books by other authors (Blavatsky, Eliphas Levi, Ramatís) took the 20 slots;
- nothing restricted a search to one author's texts, although every document's frontmatter lists its `entities` (the author among them) and its `source_path` (the "Temas-docs" folders hold that author's lectures);
- reads are 6,000–12,000-character windows, and the author's compilations run to 490,000 characters (`miasmas.md`, "Homeopatia – Teoria Miasmática");
- 15 tool steps and 2,000 output tokens per answer.

On the real vault, 528 served documents list "José Laércio do Egito" among their entities and 717 mention him in the frontmatter or the text.

Claude Code answers this kind of question with Grep (`output_mode` `files_with_matches` / `count` / `content`, `head_limit` and `offset` for paging, path filters), Read (`offset`/`limit` on any file, with the total size), automatic context compaction and a model that decides how much effort a question needs; claude.ai Research adds an orchestrator with sub-agents.

## Decision

**`find_text` becomes a grep** (name kept: prompts, evals and transcripts know it):

| Argument | Meaning |
|---|---|
| `phrase` | literal text, accent- and case-insensitive, variants joined with ` \| `; optional when `entity` or `source` is given (then the tool lists every document of the filter) |
| `output_mode` | `files` (default: one compact line per document, a passage only on the first 10 lines of a page), `count` (occurrences per document, no passage), `content` (every occurrence with its context and its position) |
| `head_limit`, `offset` | the page. Defaults: 20 lines in `files` (the deep profile's old 10–20 hits with passages, so fast and deep turns read the same amount, ADR 0009 latency), 200 in `count`, 30 occurrences in `content`; at most 200 lines or 100 occurrences per page. `limit` is still accepted as `head_limit` |
| `entity` | a fragment of one of the document's kb `entities` (author, person, work), folded |
| `source` | a fragment of the document's `source_path` (origin folder), folded |
| `exclude` | documents to leave out: `[n]`/n, an id, a fragment of the origin, or the exact name of an entity (a document that merely lists a name among its entities stays unless the name is given whole); at least 2 characters |
| `subjects` | as in `search_collection` |
| `document` | grep one document's whole body (the "scan_document" of the request); refused together with the filters |
| `context_chars` | characters around each occurrence in `content` (default 160, at most 600) |

There is **no cap on matching documents**: every output starts with the totals (documents, occurrences, documents scanned, the filters, the page range) and ends with `Próxima página: offset=N` or `Fim da lista.` A page has a budget of 50,000 characters, below Claude Code's MCP output limit: in `content` the page size shrinks with `context_chars` so the occurrences take at most 40,000; in `files` and `count` the lines past the budget move to the next page, sized before they are numbered, and the footer's offset is exact. At most 3 alternatives' counts show per line. Body occurrences never show kb-summary text in their context.

In `content` mode a position is an offset in the document body as `read_document` counts it (NFC body, frontmatter out), so the agent can read around any occurrence. The folded text keeps one character per character of a flattened text; a position map from the flat text back to the body is built per scanned document (O(n), about 15 ms for 490,000 characters). Occurrences in the kb summary come first, marked `(resumo)`, without a position.

**`list_sources(query?, kind, head_limit, offset)`** (new): the origin folders (`dirname(source_path)`) and the most frequent entities, with document counts, filtered by a folded fragment. It is how the agent discovers "Temas-docs" and "José Laércio do Egito". The catalog keeps `entities` and `sourcePath` per entry for it and the filters.

**`read_document`** takes `limit` (1,000–30,000 characters, default 12,000) next to `offset` and `around`, and always shows "caracteres a a b de total" and the next offset.

**`search_collection`** takes up to 30 documents, `offset`, and the same `entity`/`source`/`exclude` filters, applied to the candidates of the meaning search (at most 50), and says how many candidates there were. Meaning search is ranked and capped by nature; enumerating everything is `find_text`'s job, and its description says so.

**A third research profile, `exhaustive`** ("Exaustivo" in the composer, after "Rápido" and "Profundo"), with the provider's deep model:

| | Fast | Deep | Exhaustive |
|---|---|---|---|
| Tool steps | 6 | 15 | 80 (`KB_CHAT_EXHAUSTIVE_STEPS`, 10–300) |
| Output tokens per call | 2,000 | 2,000 | 16,000 (`KB_CHAT_EXHAUSTIVE_OUTPUT_TOKENS`, 2,000–64,000) |
| Output priced by the spend guard | the call's budget | the call's budget | 4,000 per research call; the forced last call at its whole budget (the long output comes then) |
| Wall-clock ceiling | — | — | 30 minutes, then the "answer now" note |
| Context compaction (in-API loop) | — | — | past ~60,000 estimated tokens |
| Claude Code effort | `low` | CLI default | CLI default |

The ceilings are safety nets, not the plan: the exhaustive prompt tells the model to decide the effort, enumerate with filters and pages until the lists end, grep big documents with `find_text` + `document` instead of reading them whole, keep a running list in its notes between tool calls, and end the answer with a **coverage line** ("Cobertura: varri X de Y documentos que …; examinei Z documentos grandes com find_text").

**Compaction** (in-API loop, exhaustive profile): before every model call (the forced last one included) whose prompt is estimated past the threshold, every tool result older than the last 6 becomes a short ledger entry: the tool's first line (its totals) and the `[n]` it listed, marked as compacted; if the prompt is still past it, only the last 2 stay whole. The newest compacted result carries the one ledger of every document numbered so far (older ledgers are dropped). The model's own notes stay. Deterministic, no extra model call, so it costs nothing and is tested with fakes. The subscription CLIs compact their own context (Claude Code's auto-compact).

**Subscriptions.** The CLIs reach the same tools over the turn's MCP endpoint, which now accepts the profile's step budget (80) and lives 90 minutes (was 15). The exhaustive prompt goes to the CLI as for the other profiles. The 30-minute ceiling is the in-API loop's: a CLI runs its own loop, so a subscription turn is bounded by the 80 steps, the reader's "Parar" and the endpoint's 90 minutes (deliberate; nothing is spent per token there).

**Spend.** A per-token exhaustive turn is still checked against the daily cap before every model call; when the cap is reached mid-turn it ends with `DAILY_CAP_REACHED` (the existing message) and what it spent is recorded.

**History and citations.** The saved turn keeps its `profile` (optional, older turns stay valid). Citations up to `[9999]` link to sources (was `[99]`): an exhaustive answer can number hundreds of documents.

## Options considered

1. **Grep-like `find_text` with paging, filters and a third profile (chosen).** The agent can always reach the end of a list and knows how far it is; the cost is paid only when the reader picks "Exaustivo".
2. **Raise the caps (`limit` 200, 40,000-character windows).** One call would still cut silently past the cap, and each output would eat the context.
3. **Answer exhaustive questions without a model (a fixed "list works by author" report).** Exact for one question shape only; the owner asks open questions.
4. **Summarize old tool results with the model.** Closer to Claude Code, but it spends money and time on every compaction and is hard to test; the ledger keeps what the agent needs to continue (totals and `[n]`).

## Consequences

- Good: a question about an author or a folder can be answered completely, with a coverage line the reader can check; a 490,000-character compilation is searched whole in one call.
- Good: the fast and deep profiles keep their steps, budgets and latency (ADR 0009); their tools get the same paging and filters.
- Bad (cost): an exhaustive per-token turn can spend many times a deep one; the daily cap bounds it and the composer's help says it may take minutes. On a subscription it counts on the plan.
- Bad: tool outputs are longer to describe; the tool descriptions grew. Mitigated by defaults that need no arguments beyond `phrase`.
- The contract changes are additive: the request's `profile` accepts `exhaustive`; the tool arguments are new and optional; `limit` keeps working.
- Sub-agents with their own contexts (claude.ai Research) come in KBC-018 on top of these tools.
