# 0007 — AI providers, subscriptions through the official CLIs, and local settings

- Status: accepted (2026-10-24)
- Amends: [0004](0004-grounded-answers-single-llm-call.md) (the key is no longer env-only) and [0006](0006-research-agent-over-kb-tools.md) (how Claude Code reaches the tools)
- Drivers: KBC-007 (preferences and provider without editing files), Q3 cost, the owner's benchmark (Claude at full capability, the default for local use), Q6 evolvability (ADR 0005 seam; logins and permissions in ADR 0008, KBC-010)

## Context

Release 1 reads the AI provider from env variables (`OPENROUTER_API_KEY`, `KB_CHAT_MODEL`). The owner wants to choose, on first run and later in Settings, between their own API key (OpenRouter, Anthropic, OpenAI) and their Claude or ChatGPT subscription, with no per-token charge. Anthropic and OpenAI give no third-party OAuth for personal plans; the supported way to use a plan programmatically is the official CLI the person already logged into (`claude`, `codex`). Google login with per-user permissions comes next (KBC-010, ADR 0008).

## Decision

**Settings per principal.** Each principal has `<KB_CHAT_STATE_DIR>/settings/<principal>.json`. The owner's is `owner.json` in R1. ADR 0008 (Google login and permissions, KBC-010) will supply the signed-in principal; the owner stays the only master user who grants collections and features. Keys and the provider choice belong to the principal.
- `preferences` (default collection, search mode, theme, default view) and `ai` (provider, model, keys, daily cap);
- folder 0700, file 0600, written atomically (temporary file + rename);
- an id that is not a plain file name is hashed into one;
- the first-run wizard shows while the principal has no file (BR-5).

The API reads a principal's file once and keeps it in memory. Routes take the principal as a dependency, like `answers` and `usage` (ADR 0005), so logins change no module.

**Secrets.** A key is write-only:
- `PUT /api/v1/settings` accepts it; `null` removes it;
- `GET` returns only `{ set: true, last4 }`; the web draws "••••abcd";
- keys are never logged (the invalid-file warning carries no content), never in a response, and only in the `x-api-key`/`authorization` header of the provider call. Integration tests assert all three (NFR-2).

**Providers.** A `ProviderRegistry` (composition root, `providers/`) resolves the provider **per request**, in this order (BR-4, the owner's decision of 2026-10-24):
1. the principal's Settings;
2. the stub, when `KB_CHAT_LLM=stub` (tests and E2E);
3. **the Claude subscription when `claude` is on PATH**, so `pnpm dev` answers with Claude with no setup; the lookup runs at boot and again on every provider list;
4. the env keys, as before KBC-007: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`;
5. none (search only).
 `DynamicLlm` and `DynamicResearchRunner` delegate to it, so a switch applies on the next answer without a restart (FR-5). Built adapters are reused while the choice is unchanged; a replaced key leaves memory.

| Provider | Adapter | Billing | Default model (price US$/M in, out) |
|---|---|---|---|
| OpenRouter | `OpenRouterAdapter` (KBC-008 adds tools) | per token, ledger and cap (ADR 0004) | vault's `kb.toml` model |
| Anthropic API | `AnthropicAdapter`, official SDK, Messages streaming with tools | per token | `claude-opus-5-5` (4, 20); Sonnet 5.5 (2, 10), Haiku 5.5 (0.10, 0.50), Fable 5.1 (10, 50) |
| OpenAI API | `OpenAiAdapter`, Chat Completions streaming with tools | per token | `gpt-5.4-mini` (0.75, 4.50); GPT-5.4 (2.50, 15), GPT-5.5 (5, 30) |
| Claude subscription | `ClaudeCliRunner` (`claude -p`) | subscription: no ledger entry, no cap (BR-2) | the CLI's own; aliases `opus`, `sonnet`, `fable`, `haiku` |
| ChatGPT subscription | `CodexCliRunner` (`codex exec --json`) | subscription | the CLI's own |
| None | — | — | search only |

Prices come from each vendor's list (2026-10) and live next to the adapter. A model missing from the table is priced as the dearest one, so the daily cap errs on the safe side.

The Anthropic adapter:
- leaves thinking on (Opus 5.5 cannot turn it off), at effort `medium`, with an output floor of 8,000 tokens because thinking counts toward `max_tokens`;
- turns on automatic prompt caching and the server-side refusal fallback (`fallbacks: "default"`);
- keeps each tool-calling turn's content so that its thinking blocks go back unchanged on the next step, as the API requires.

**Subscriptions through the official CLIs (BR-7).** kb-chat never receives a subscription credential. The person logs in once in the CLI (`claude` → `/login`, `codex login`), and the API only spawns it:
- **Process.** `execFile`-style spawn, no shell; its own process group, so "Parar" kills the CLI and its children.
- **Isolation.** A private working folder under the state folder. Claude Code also gets `--setting-sources ""`, `--strict-mcp-config` and `--no-session-persistence`, so no user settings, other MCP servers, CLAUDE.md or saved session are involved.
- **Tools.** Built-ins off (`--tools ""`); only `mcp__kb` is allowed; `--permission-prompts none`.
- **Credentials.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` are removed from the CLI's environment, so usage counts on the plan and not on an API account (AC-7).
- **Input.** The question and the previous turns go through stdin, never argv.

**The tools over MCP.** ADR 0006 named a stdio `kb-chat mcp` server, started per turn. A per-turn process would load the catalog and start QMD every time (seconds to minutes, ADR 0002). So the API serves the same tools itself:
- **Endpoint.** A per-turn **Streamable HTTP MCP endpoint**, `/mcp/turns/<token>`, stateless, bound to `127.0.0.1` behind the Host guard.
- **Token.** 24 random bytes, valid only while the turn runs, with a 15-minute safety TTL; an unknown token gets 404.
- **Shared code.** The endpoint calls the same `ResearchToolsPort` as the in-API loop, with that turn's source numbering. Each tool call becomes a `step` and a `sources` event in-process, and the CLI's text deltas become `token` events.
- **Step cap.** After 10 tool steps, tools answer with an instruction to finish (KBC-008 BR-3).
- **stdio.** `serveKbMcpStdio` remains for other MCP clients.

**Connection test.** `POST /api/v1/settings/ai/test` sends a minimal question with a typed or saved key, or runs the CLI with no tools (which proves the login and the MCP connection). It stops at 20 s (NFR-1). The outcome is data, `{ ok, code }`: `LLM_KEY_REJECTED`, `LLM_NOT_CONFIGURED`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `CLI_MISSING` or `CLI_LOGIN_REQUIRED`. `GET /api/v1/ai/providers` reports, per provider, the key source (Settings or env) and whether the CLI is on PATH; it looks the CLI up without a shell.

## Options considered

1. **Official CLIs with tools over a per-turn HTTP MCP endpoint (chosen).** No credential handling; Claude Code runs Claude at full capability with the collection's index, summaries and relations. Costs: the CLI's start-up time (first step after 2.4 s in the recorded run) and dependence on its flags and stream format, pinned by tests with fake CLIs and by one recorded real run.
2. **A stdio `kb-chat mcp` process per turn.** Matches ADR 0006 literally, but it rebuilds the catalog and the QMD process on every answer.
3. **Our own OAuth with the vendors, or reading the CLI's stored tokens.** Not offered for personal plans and against BR-7.
4. **Keys only in env (as in R1).** No onboarding; fails the story.

## Consequences

- Good: the provider changes from the UI without a restart; subscriptions cost nothing per token; the same tools serve three runners.
- Bad: plain-text keys on disk (owner-only), acceptable for a local single user and revisited for hosting in ADR 0008 (a secrets store per user). A CLI upgrade may change its flags or events: the dialect parsers ignore unknown lines, and the connection test exposes a break.
- `apiKeySource: "none"` in Claude Code's init event confirmed, in the real run, that the subscription (not an API key) answered.
- Codex support is best effort (written from the published `exec --json` events; Codex is not installed here).
- Threats added: another local process could call a turn's MCP endpoint only with its token, which is never logged and lives for the turn; a document's prompt injection is limited by the read-only tools and by no built-ins.
- Compliance: integration tests for masking, 0600, AC-3 (CLI absent), AC-5 (refused key), AC-6 (env default) and AC-7 (env without the key); runner tests with fake CLIs, including abort.
- ADR 0008 (Google login and permissions) supplies the principal and decides where keys live when hosted.
