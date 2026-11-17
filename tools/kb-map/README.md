# kb-map

The collection map over a kb vault ([ADR 0039](../../docs/adr/0039-collection-map.md); KBC-139,
KBC-140 and KBC-141). It compiles the wiki the LLM Wiki pattern describes on top of kb's raw
sources, on the owner's Mac. The API never writes it (Q7). `deploy/scripts/sync-vault.sh`
sends it to production, and only after `kb-map check` passes.

| Step | Command | Writes |
|---|---|---|
| Sections (KBC-139) | `kb-map sections <topic> [--doc <path>]` | `map/sections/<doc>.json` |
| Tree (KBC-140) | `kb-map tree build <topic>` | `map/tree.json`, `map/tree-review.md`, `index.md` |
| Owner review | `kb-map tree review <topic>` / `kb-map tree apply <topic> <corrections.yaml>` | `map/owner-edits.json` |
| Dossiers (KBC-141) | `kb-map dossier <topic> [--node <id>]` | `map/dossiers/*.json`, `wiki/concepts` (stubs only), `wiki/subjects`, `wiki/entities`, `map/entities.json`, `map/affects.json`, `index.md` |
| Check | `kb-map check <topic>` | nothing (exit 1 lists each problem) |
| Owned paths | `kb-map paths <topic>` | nothing (what the sync holds back on a failed check) |

Every step that changes the map appends an entry to `<topic>/log.md` in kb's format.

```bash
uv sync --project tools/kb-map
uv run --project tools/kb-map kb-map --vault ~/dev/personal/hermetismo sections hermetismo --doc raw/articles/x.md --max-usd 0.50
```

## Providers and budget

- `--provider openrouter` (default) uses kb's own model from `kb.toml` `[generation]`
  (`model`, with `fallback_model` as OpenRouter's fallback). The key is `OPENROUTER_API_KEY`
  from the environment, or else from the macOS Keychain item that
  `uv run --project tools/transcriber transcriber keys set` stores (service
  `nova-alexandria-transcriber-kb`). It is never printed, logged or put in argv.
- `--provider claude` or `--provider codex` use the owner's subscription through the CLI. The
  prompt goes on stdin, and the CLI runs in an empty temporary folder.
- `--max-usd <n>` is a hard budget. The run stops before a call that would pass it, keeps what
  it saved, and exits 3. Run the command again to resume, since every step is incremental.
  Codex reports no cost, so `--max-usd` cannot limit it.

## Adding a subcommand

Add one module per subcommand in `src/kb_map/commands/`, with `NAME`, `HELP`, `register(sub)`
and `run(args)`. Modules are discovered by name, so no shared file changes. See
`src/kb_map/commands/__init__.py`. Shared helpers (topic, `--provider`, `--max-usd`) live in
`commands/_common.py`. Tests use `kb_map.providers.fake.FakeProvider` through
`commands._common.provider_factory`, so no test ever calls a model.

## Checks

```bash
(cd tools/kb-map && uv run ruff check && uv run ruff format --check && uv run pytest)
```
