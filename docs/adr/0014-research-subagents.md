# 0014 — Research sub-agents: an orchestrator that delegates to parallel workers

- Status: accepted (2026-10-25)
- Amends: [0013](0013-exhaustive-research-grep-tools-and-compaction.md) (the exhaustive profile gains delegation), [0007](0007-ai-providers-and-local-settings.md) (Claude Code gets its Agent tool in the exhaustive profile)
- Drivers: KBC-018 (the owner: "temos que nos espelhar no funcionamento do Claude"; exhaustive questions answered completely), Q4 grounding, Q3 cost

## Context

ADR 0013 made every list reachable (paged grep, filters, compaction), but one agent still walks it alone. An exhaustive question over the owner's collection ("every work cited by José Laércio do Egito": 408 documents of the author, compilations of 490,000 characters) means dozens of pages and greps whose results pile up in one context; compaction keeps it alive at the cost of detail. claude.ai Research and Claude Code's Agent tool solve this with an orchestrator that hands focused tasks to sub-agents, each with a fresh context and the same tools, which return only a condensed result.

## Decision

**A `delegate` tool, exhaustive profile only, in the in-API loop.** `delegate({ tasks: [{ title, task }] })`, 1–5 tasks per call. The runner, not `ResearchTools`, handles it:

- each task runs a **sub-agent loop**: a sub-researcher prompt (the research rules, "do only this task, return a concise report citing [n], end with Cobertura:", never address the reader) and the task as the user turn; the same research tools without `delegate` (one level only); its own budget: 25 tool steps, 4,000 output tokens per call, compaction past 60,000 estimated tokens, then a last call without tools;
- **bounded parallelism**: at most 3 sub-agents run at once, the rest wait their turn; the call returns when all finish, one block per task (`Pesquisador N — título`);
- a turn may spend at most **300 sub-agent tool steps**; past that, running sub-agents answer with what they have;
- **one numbering**: sub-agents share the turn's `SourceBook`, so the [n] in their reports are valid in the final answer and their documents reach the `sources` events;
- **progress**: every sub-agent step is streamed as a `step` event with `agent: N` (new optional field) and the delegation itself as a `delegate` step; the web shows "Pesquisador N: …" in the steps list and "· N pesquisadores" in the summary. A sub-agent's text never reaches the reader;
- **stop**: the reader's abort signal is the sub-agents' signal; no model call starts after it;
- **spend**: every sub-agent call is guarded against the daily cap with what the whole turn spent, and accounted to the turn (one ledger entry per model, as before); `DAILY_CAP_REACHED` in a sub-agent ends the turn;
- `done.steps` counts the orchestrator's and the sub-agents' tool steps.

The exhaustive prompt adds: when the sweep is large (many pages, several big documents), split it into focused tasks and delegate them in one call, then merge the reports and remove repeats. The model decides; the budgets are safety nets.

**Claude subscription: Claude Code's own Agent tool.** In the exhaustive profile the CLI starts with `--tools Agent`, `--allowedTools mcp__kb,Agent` and `--agents '{"pesquisador": {description, prompt: <sub-researcher prompt>, tools: ["mcp__kb__*"]}}'`; the fast and deep profiles keep `--tools ""`. Sub-agents reach the same turn MCP endpoint, so their tool calls become steps (without an agent number: MCP does not say which sub-agent called) and share the numbering. Lines with a non-null `parent_tool_use_id` (sub-agent messages) never become answer text; an `Agent` tool use of the main conversation becomes a `delegate` step ("Delegando: …"). The turn's MCP step cap becomes the exhaustive steps plus the 300 sub-agent steps. Claude Code runs sub-agents in parallel itself.

**Codex** (off by default) has no sub-agent mechanism kb-chat can restrict: its exhaustive turns run without delegation.

## Options considered

1. **Orchestrator with a `delegate` tool and native Agent on Claude Code (chosen).** Each worker's context starts clean; the orchestrator keeps only reports.
2. **Fixed fan-out by the runner** (split every list into N slices without the model). Predictable, but blind to the question; the owner asked that the model decide.
3. **A `delegate` MCP tool that runs sub-agents in the API for the CLI path.** Works for Codex too, but the API would need a per-token model inside a subscription turn (cost the owner did not ask for) or a nested CLI per task.

## Consequences

- Good: a large sweep is split into parallel workers with their own context; the final answer cites their documents; the reader sees who is doing what and can stop everything.
- Bad (cost): a delegated per-token turn spends more model calls; the daily cap bounds the whole turn, sub-agents included.
- Bad: on the Claude Code path the steps are not grouped by sub-agent; the delegation step names each task.
- The event contract grows additively (`step.kind: delegate`, `step.agent`); saved turns are unchanged.
