# 0007 — AI providers, subscriptions through the official CLIs, and local settings

- Status: accepted (2026-10-24)
- Amended by: [0009](0009-faster-research-profiles-and-streaming.md) (a fast and a deep model per provider; Sonnet by default on the Claude subscription)
- Amends: [0004](0004-grounded-answers-single-llm-call.md) (the key is no longer env-only) and [0006](0006-research-agent-over-kb-tools.md) (how Claude Code reaches the tools)
- Drivers: KBC-007 (preferences and provider without editing files), Q3 cost, the owner's benchmark (Claude at full capability, the default for local use), Q6 evolvability (ADR 0005 seam; logins and permissions in ADR 0008, KBC-010)

## Context

Release 1 reads the AI provider from env variables (`OPENROUTER_API_KEY`, `KB_CHAT_MODEL`). The owner wants to choose, on first run and later in Settings, between their own API key (OpenRouter, Anthropic, OpenAI) and their Claude or ChatGPT subscription, with no per-token charge. Anthropic and OpenAI give no third-party OAuth for personal plans; the supported way to use a plan programmatically is the official CLI the person already logged into (`claude`, `codex`). Google login with per-user permissions comes next (KBC-010, ADR 0008).

## Decision

**Settings per principal.** Each principal has `<KB_CHAT_STATE_DIR>/settings/<principal>.json`. The owner's is `owner.json` in R1. ADR 0008 (Google login and permissions, KBC-010) will supply the signed-in principal; the owner stays the only master user who grants collections and features. Keys and the provider choice belong to the principal.
- `preferences` (default collection, search mode, theme, default view) and `ai` (provider, model, keys, daily cap); *amended by [ADR 0009](0009-faster-research-profiles-and-streaming.md):* `ai.models[provider] = { fast, deep }` replaces `model`, and `preferences.researchProfile` is the default profile;
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
 The research route asks it for the runner of every turn and `DynamicLlm` (the side panel's spend) delegates to it, so a switch applies on the next answer without a restart (FR-5). Built adapters are reused while the choice is unchanged (the cache id carries a SHA-256 fingerprint of the key, never the key); a replaced key leaves memory. A model id must match `^[A-Za-z0-9][A-Za-z0-9._:/@-]*$` (contract and stored file), so it can never be read as a CLI flag.

The research route asks the registry for the runner of each turn. A per-token runner is the in-API tool loop over that provider's model; it checks the principal's daily cap from Settings (`ProviderRegistry.dailyCapUsd`) before every model call and writes one ledger entry per turn. A subscription turn skips the cap and the ledger. The `done` event carries `billing` (`per-token` | `subscription`), so the web shows the cost or "Incluído na sua assinatura", and saved turns keep it (older ones read as `per-token`).

| Provider | Adapter | Billing | Default model (price US$/M in, out) |
|---|---|---|---|
| OpenRouter | `OpenRouterAdapter` (with tools, KBC-008) | per token, ledger and cap (ADR 0004) | `KB_CHAT_MODEL`, else `deepseek/deepseek-v4-pro` (ADR 0006: the research agent needs tool calling, so the vault's `kb.toml` model no longer applies) |
| Anthropic API | `AnthropicAdapter`, official SDK, Messages streaming with tools | per token | `claude-opus-5-5` (4, 20); Sonnet 5.5 (2, 10), Haiku 5.5 (0.10, 0.50), Fable 5.1 (10, 50) |
| OpenAI API | `OpenAiAdapter`, Chat Completions streaming with tools | per token | `gpt-5.4-mini` (0.75, 4.50); GPT-5.4 (2.50, 15), GPT-5.5 (5, 30) |
| Claude subscription | `ClaudeCliRunner` (`claude -p`) | subscription: no ledger entry, no cap (BR-2) | *ADR 0009:* `sonnet` (fast) and `opus` (deep); allowlist `opus`, `sonnet`, `fable`, `haiku` and their full ids |
| ChatGPT subscription | `CodexCliRunner` (`codex exec --json`), **off unless `KB_CHAT_CODEX=on`** (see below) | subscription | the CLI's own |
| None | — | — | search only |

Prices come from each vendor's list (2026-10) and live next to the adapter. A model missing from the table is priced as the dearest one, so the daily cap errs on the safe side.

The Anthropic adapter:
- leaves thinking on (Opus 5.5 cannot turn it off), at effort `medium`, with an output floor of 8,000 tokens because thinking counts toward `max_tokens`;
- turns on automatic prompt caching and the server-side refusal fallback (`fallbacks: "default"`);
- keeps each tool-calling turn's content so that its thinking blocks go back unchanged on the next step, as the API requires.

**Subscriptions through the official CLIs (BR-7).** kb-chat never receives a subscription credential. The person logs in once in the CLI (`claude` → `/login`, `codex login`), and the API only spawns it:
- **Process.** `execFile`-style spawn, no shell; its own process group. "Parar" closes the turn's MCP endpoint at once and sends SIGTERM to the group, then SIGKILL after 3 s if it is still running. A CLI that cannot start closes the endpoint too.
- **Isolation.** A private working folder under the state folder, plus a private folder (0700) per turn, removed when it ends. Claude Code also gets `--setting-sources ""`, `--strict-mcp-config` and `--no-session-persistence`, so no user settings, other MCP servers, CLAUDE.md or saved session are involved.
- **Tools.** Built-ins off (`--tools ""`); only `mcp__kb` is allowed; `--permission-prompts none`.
- **Environment.** An allowlist, not the server's environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, the locale (`LANG`, `LC_*`), `TERM`, `TMPDIR`, `TZ`, the XDG folders, `CLAUDE_CONFIG_DIR` and the proxy/CA variables. No API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or other server variable reaches the CLI, so usage counts on the plan and not on an API account (AC-7). One real `claude -p` call with this environment (2026-10-24) answered from the subscription login.
- **Input.** The question and the previous turns go through stdin, never argv; the model goes as `--model=<id>`.
- **The turn token never in argv.** Claude Code reads its MCP config from a 0600 file in the turn's folder (`--mcp-config <path>`); Codex gets the token in an environment variable named by `bearer_token_env_var`, sent as `Authorization: Bearer` to `/mcp/turn`. `ps` shows neither.

**Codex is off unless the owner enables it (`KB_CHAT_CODEX=on`).** Claude Code can be limited to the kb tools; Codex cannot, as of 0.164: it has no switch that turns off every built-in tool, its tool set (shell, unified exec, patch, image viewer, web search, browser and computer use, sub-agents, apps, plugins, memories) changes between versions, and `--sandbox read-only` still lets its shell read any file of the user (`~/.ssh`, the settings file with the API keys). A prompt injection in a document could make it read such a file and put it in an answer that is then saved in the history. kb-chat does what it can, best effort: a private `CODEX_HOME` under the state folder with only the owner's `auth.json` copied in (again whenever the owner's copy is newer), so the user's `config.toml`, other MCP servers and profiles are never loaded; `features.shell_tool`, `features.unified_exec`, `features.view_image` and `features.apply_patch_freeform` off; `web_search="disabled"`, `project_doc_max_bytes=0` and `history.persistence="none"`. Only the long-standing keys are set, because Codex rejects unknown feature keys. With `KB_CHAT_CODEX` off (the default) the provider list reports it as `not-enabled`, Settings shows it disabled with this reason, and its runner refuses research. A Codex login kept in the OS keyring instead of `auth.json` is not copied, so the private home reports "login required".

**The tools over MCP.** ADR 0006 named a stdio `kb-chat mcp` server, started per turn. A per-turn process would load the catalog and start QMD every time (seconds to minutes, ADR 0002). So the API serves the same tools itself:
- **Endpoint.** A per-turn **Streamable HTTP MCP endpoint**, `/mcp/turns/<token>` (or `/mcp/turn` with the token as a bearer header), stateless, bound to `127.0.0.1` behind the Host guard.
- **Token.** 24 random bytes, valid only while the turn runs, with a 15-minute safety TTL; an unknown token gets 404. The MCP routes log the request as `POST /mcp/turns/***` (a route-scoped serializer), so the token never reaches the log; a test reads the log at `info`.
- **Shared code.** The endpoint serves the research module's own `ResearchTools` (ADR 0006, `find_text` included) through `TurnResearchTools`, an adapter to `ResearchToolsPort` with that turn's source numbering; the in-API loop and the CLIs share one instance and one `find_text` cache, warmed when the turn starts. Each tool call becomes a `step` and, when new documents were numbered, a `sources` event in-process; the CLI's text deltas become `token` events.
- **Same rules.** The CLIs get the in-API loop's system prompt (`researchSystemPrompt`, with the topic's title): search first, `find_text` before concluding absence, cite `[n]`, mark "(fora do acervo)", no narration. Claude Code takes it with `--system-prompt`; Codex reads it at the head of its input.
- **Step cap.** After 15 tool steps, the in-API loop's cap (ADR 0006), tools answer with an instruction to finish (*ADR 0009:* 6 in the fast profile).
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
- Codex support is best effort (written from the published `exec --json` events and the 0.164 config schema; Codex is not installed here) and off by default, for the reason above.
- Threats added: another local process could call a turn's MCP endpoint only with its token, which is never logged, never in argv and lives for the turn. A document's prompt injection is limited by the read-only tools and by no built-ins **with Claude Code**; with Codex it is limited only by the best-effort lock-down, which is why it needs the owner's explicit opt-in.
- Compliance: integration tests for masking, 0600, AC-3 (CLI absent), AC-5 (refused key), AC-6 (env default) and AC-7 (env without the key); runner tests with fake CLIs, including abort.
- ADR 0008 (Google login and permissions) supplies the principal and decides where keys live when hosted.
