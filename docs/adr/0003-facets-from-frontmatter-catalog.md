# 0003 — Facet filters from an in-memory frontmatter catalog

- Status: accepted (2026-10-24)
- Drivers: Q1 and Q2 latency, Q3 cost, Q7 vault safety

## Context

The UI filters by subject (concepts), text type (genre), depth and relevance. `kb search` and QMD do not filter by these facets. `kb find` does filter, but it asks the paid decision model about each candidate, which breaks Q3 for a free search. The facets live in each document's YAML frontmatter, written by `kb classify` and `kb link`. The `hermetismo` topic has 4,235 documents.

## Decision

At startup, the API builds an in-memory **catalog** per topic by parsing the frontmatter of every markdown file under the topic. It refreshes on file changes (chokidar, debounced). The catalog holds the facets, title, summary, relations and duplicate groups.

When a search has filters, the API **over-fetches** from QMD (up to 200 hits), keeps the hits whose document matches the filters, groups duplicates and computes facet counts over the filtered result set. It returns a page of 10.

## Options considered

1. **In-memory catalog plus post-filter (chosen).** Free and fast. 4,235 documents is a few MB.
2. **`kb find` with `--concept`, `--kind` and similar flags.** Exact, but it costs money and seconds per query.
3. **A separate SQLite or Postgres catalog.** Not justified at this size (CS-14).

## Consequences

- Good: zero cost, millisecond filtering, and counts that match the results.
- Bad: a narrow filter on a broad query can miss documents ranked below 200. The UI then says "showing the best matches" and offers "Palavras exatas" or a more specific query.
- Startup parses about 4k files (target under 3 s).
- Compliance: unit tests on the catalog with fixture frontmatter. Revisit when a topic exceeds 50k documents.
