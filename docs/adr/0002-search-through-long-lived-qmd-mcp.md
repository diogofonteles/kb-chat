# 0002 — Search through a long-lived QMD MCP process

- Status: accepted (2026-10-24, after the MCP spike)
- Drivers: Q2 semantic and hybrid latency (H/H), Q1, Q5

## Context

`kb search` is a thin wrapper over QMD. Every call starts a new process. In hybrid mode, the process loads local embedding, query-expansion and reranking models. The spike on 2026-10-23 measured 0.68 s cold for lexical search and 118 s cold for hybrid, while `qmd embed` was running at the same time. QMD offers `qmd mcp`, an MCP server over stdio that keeps the models loaded between calls, and typed queries (`lex:`, `vec:`, `hyde:`) that skip the query-expansion step.

## Decision

The API starts one `qmd mcp` child process at boot (through the `QMD_BIN` wrapper, which brings Node 24) and keeps it alive. `QmdMcpAdapter` implements `SearchIndexPort` with MCP tool calls. The UI modes map to the following:

- **Palavras exatas** → lexical only.
- **Por significado** → vector only.
- **Tudo** → a typed query document `lex: <q>` + `vec: <q>`. It fuses both rankings without the slow LLM query expansion. Full expansion and reranking (`qmd query <q>`) stay behind a feature flag until the latency check shows they fit Q2.

`KbCliSearchAdapter` (`kb search --format json`, through `execFile`) is the fallback when MCP fails to start. In that case, health reports "degraded".

## Spike (QA-18), 2026-10-24

A probe client held one `qmd mcp` process and called its `query` tool. `qmd embed` was still running at the same time, so these numbers are pessimistic.

| Call | Time |
|---|---|
| `lex`, `rerank: false` | 0.01–0.03 s (the first call took 3.6 s for warm-up) |
| `vec`, `rerank: false` | 0.7 s (the first vector call took 4.0 s to load the embedding model) |
| `lex` + `vec`, `rerank: false`, limit 50 | 1.1 s |
| Any mode with `rerank: true` (the default) | 9.5–12.8 s |

Every result carries `file` (vault-relative, prefixed by the collection, e.g. `hermetismo/raw/articles/x.md`), `docid`, `score`, `line` and a line-numbered `snippet` that can fall inside the frontmatter.

Consequence: the adapter always sends `rerank: false`, and the API warms the process at boot with one `lex` and one `vec` query. Q2 is met when warm.

## Options considered

1. **Long-lived `qmd mcp` (chosen).** The models stay warm, and MCP is QMD's documented integration.
2. **Spawn `kb search` per request.** It is the simplest option and the CLI is the contract, but cold hybrid search fails Q2 by two orders of magnitude.
3. **Read QMD's SQLite index directly** (FTS5 plus sqlite-vec). It is the fastest, but it couples us to an internal schema. better-sqlite3 also segfaults under the system Node, so this option was rejected for Q5.

## Consequences

- Good: warm latency, and one process to supervise.
- Bad: a second runtime (Node 24) as a child process, and an MCP client dependency in the API.
- Compliance: the latency fitness function (20 real queries per mode, p95 against Q1 and Q2) runs in the walking skeleton. If vector p95 > 2 s, a new ADR revisits option 3.
