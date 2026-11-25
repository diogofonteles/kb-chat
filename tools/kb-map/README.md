# kb-map

The collection map over a kb vault ([ADR 0039](../../docs/adr/0039-collection-map.md); KBC-139,
KBC-140 and KBC-141). It compiles the wiki the LLM Wiki pattern describes on top of kb's raw
sources, on the owner's Mac. The API never writes it (Q7). `deploy/scripts/sync-vault.sh`
sends it to production, and only after `kb-map check` passes.

| Step                | Command                                                                       | Writes                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Sections (KBC-139)  | `kb-map sections <topic> [--doc <path>]`                                      | `map/sections/<doc>.json`                                                                                                                  |
| Tree (KBC-140)      | `kb-map tree build <topic>`                                                   | `map/tree.json`, `map/tree-review.md`, `index.md`                                                                                          |
| Owner review        | `kb-map tree review <topic>` / `kb-map tree apply <topic> <corrections.yaml>` | `map/owner-edits.json`                                                                                                                     |
| Dossiers (KBC-141)  | `kb-map dossier <topic> [--node <id>]`                                        | `map/dossiers/*.json`, `wiki/concepts` (stubs only), `wiki/subjects`, `wiki/entities`, `map/entities.json`, `map/affects.json`, `index.md` |
| Convert (KBC-148)   | `kb-map convert <topic> <file\|url>... [--json]`                              | `raw/_originals/<sha256>.<ext>`, the document through `kb ingest file`, provenance keys                                                    |
| Reconvert (KBC-148) | `kb-map reconvert <topic> [--from <dir>] [--dry-run] [--limit n] [--retry]`   | the body and provenance keys of plain-text sources                                                                                         |
| Check               | `kb-map check <topic>`                                                        | nothing (exit 1 lists each problem)                                                                                                        |
| Owned paths         | `kb-map paths <topic>`                                                        | nothing (what the sync holds back on a failed check)                                                                                       |

Every step that changes the map appends an entry to `<topic>/log.md` in kb's format.

```bash
uv sync --project tools/kb-map
uv run --project tools/kb-map kb-map --vault ~/dev/personal/hermetismo sections hermetismo --doc raw/articles/x.md --max-usd 0.50
```

## Conversion (KBC-148, ADR 0040)

The converters are local and free, and heavy (Docling brings torch), so only the owner's Mac
installs them: `uv sync --project tools/kb-map --extra convert`. PDF and images go through
Docling (OCR, tables, one `<!-- página n -->` marker per page), Office, EPUB and saved HTML
through MarkItDown, links through Firecrawl (`FIRECRAWL_API_KEY`) and then Jina Reader
(`JINA_API_KEY` optional), both from the environment or the Keychain like the OpenRouter key.
CSV and JSON stay as they are with a page that describes them. An image also gets a short
description by a cheap vision model (`kb.toml` `[vision] model`, else
`google/gemini-2.5-flash-lite`) under the heading `Descrição gerada`, which the map keeps out
of every section (BR-4). YouTube links are refused: they go through the transcriber.

- The original is kept once, read-only, in `<topic>/raw/_originals/<sha256>.<ext>` (never
  `.md`). The frontmatter gets `original_sha256`, `original_name`, `converter`,
  `converter_version`, `converted_at`, `source_path` and, for images, `generated_description`.
- `convert` hands a body-only Markdown that opens with `# <autor ou origem> - <título> - <ano>`
  to `kb ingest file`, so kb names, judges and links the document; the same original (or link)
  twice answers with the existing document.
- `reconvert` finds each plain-text source's original by its `source_path`
  (`_convert/ready/<origin>/<path>.pdf.txt`) and then by name, in `--from` (default
  `<vault>/_extract`). A result below 80 % of the current useful characters changes nothing
  and goes to `map/review-queue.json` (`--retry` tries again). It changes only the body and
  the provenance keys, keeps `source_path`, and is resumable: what the current converter
  version made is skipped. `--dry-run` lists what would change.

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
