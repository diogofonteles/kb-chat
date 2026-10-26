# 0015 — Authorship in the catalog, the search contract and the research tools

- Status: accepted (2026-10-26)
- Amends: [0003](0003-facets-from-frontmatter-catalog.md) (a new catalog field and filter), [0006](0006-research-agent-over-kb-tools.md) (tool outputs and the research prompt), [0013](0013-exhaustive-research-grep-tools-and-compaction.md) (a new tool filter)
- Drivers: KBC-020 (the owner: the work of José Laércio do Egito, "Mestre Laércio", must never be mixed with other authors' books), Q4 grounding

## Context

The `hermetismo` collection has a core, the work of Mestre Laércio (the Temas-doc folders, his courses, his recorded lectures), and books and texts by other authors that sometimes quote him. Until now nothing in the app said whose a document is: a result card, a cited source or a tool output looked the same for both, and the agent could present another author's idea as the Mestre's. The owner now marks every raw source with two frontmatter keys he manages himself (`_tools/mark-authorship.py` in the vault): `author_group: mestre-laercio` (with `author: José Laércio do Egito`) or `author_group: outros-autores`. Wiki concept articles have no key: they are syntheses of many documents.

## Decision

**One catalog field, read only from the frontmatter.** `CatalogEntry` gains `authorship` (`mestre-laercio | outros-autores | sintese | nao-classificado`) and `author` (string or null). A known `author_group` value wins; without one (or with an unknown value) a `wiki/` document is `sintese` and any other document is `nao-classificado`. The app never infers authorship from folders, titles or entities: a future ingest that the owner has not marked yet shows as "Não classificado".

**Contracts (`@kb-chat/contracts`).** `authorshipSchema` and `AUTHORSHIPS`; `documentFacetsSchema` gains `authorship` and `author`, so search hits and documents carry them; `searchFiltersSchema` gains `authorships` (default `[]`) and `resultFacetsSchema` gains `authorships` counts (disjunctive, like the other facets). `answerSourceSchema` gains optional `authorship` and `author`: sources numbered by the `SourceBook` carry the document's authorship, and saved turns keep it; turns saved before this change still validate and render without a badge. Display labels live with each consumer (pt-BR via `$localize` in the web, plain pt-BR in tool outputs): "Mestre Laércio", "Outros autores", "Síntese do acervo", "Não classificado".

**Research tools.** Every document line (`search_collection`, `find_text` in its three modes, `read_document(s)` headers, `related_documents`) carries `autoria: <label>`. `search_collection`, `find_text` and `list_sources` accept `authorship`; `find_text` with only `authorship` lists every document of that group; `list_sources` always opens with the document count per group (whatever its `kind`) and, with the filter, counts origins and entities inside that group only. The `read_document(s)` header states the authorship, the `author` key when present, what to keep in mind when citing that group, and the document's kb entities (the first 12), so the agent can name the author or the book of an "Outros autores" text. `search_collection` passes the filter to the search service as `authorships`, so the 200-candidate over-fetch of ADR 0003 applies.

**Prompt.** One authorship block is shared by the research prompt (fast, deep, exhaustive), the sub-researcher prompt and therefore by every path (in-API loop, Claude Code with its "pesquisador" agent, Codex): attribute to the Mestre only what documents labelled "Mestre Laércio" say; label quotes from other authors with the author or the book; never present another author's idea as the Mestre's; for questions about the Mestre, search his documents first (`authorship: "mestre-laercio"`); keep the two apart in the answer.

## Options considered

1. **Owner-managed frontmatter keys read by the catalog (chosen).** The rule lives in one place the owner controls; the app only reads it.
2. **Derive authorship in the app from `source_path` folders and entities.** No vault change, but it duplicates the owner's rules and guesses on new ingests.
3. **An `entity` filter only (KBC-017).** Already there, but entities list everyone a text names, so a book that quotes the Mestre matches; it cannot separate authorship.

## Consequences

- Good: every surface states authorship; the agent can restrict a search to the Mestre's documents; the reader filters with one click.
- Bad: correctness depends on the owner re-running the marking script after each ingest; until then new documents are "Não classificado" (visible, never mislabelled).
- The search and document contracts grow additively; the request schema keeps working for clients that do not send `authorships`. The UI selects at most one group; a request with several (API or a hand-edited saved search) is honored and shown as removable "Autoria: …" chips instead of the control's single choice.
