# 0039 — The collection map: a compiled wiki over kb's raw sources, written by `tools/kb-map` on the owner's Mac and proved complete by code before every sync

- Status: proposed (2026-11-16, KBC-139, KBC-140, KBC-141; the decisions are the recommended defaults of the analysis, and the owner can change them)
- Amends: [0010](0010-deploy-oracle-cloud-always-free.md) (`sync-vault.sh` checks the map before it sends it), [0003](0003-facets-from-frontmatter-catalog.md) (the wiki gets pages the catalog does not serve yet: `wiki/subjects`, `wiki/entities`)
- Keeps: Q7 (the API never writes to the vault), [0015](0015-authorship-in-catalog-and-tool-contracts.md) (`author_group` stays the owner's key; the map keeps Mestre Laércio's teaching apart from other authors'), [0035](0035-tracks-as-kb-documents.md) (a track is a document like a text; its `[m:ss]` anchors are its cut points), [0004](0004-grounded-answers-single-llm-call.md) (every compiled sentence cites its sections)
- Drivers: the owner's requests of 2026-11-16 (complete and correct answers from the Deep profile; follow the LLM Wiki pattern; keep the map current on every insert); [`docs/research/2026-11-16-complete-answers-deep.md`](../research/2026-11-16-complete-answers-deep.md) §2a, §3 and §4; [`docs/research/2026-11-16-source-to-raw.md`](../research/2026-11-16-source-to-raw.md)

## Context

The Deep profile decides at question time what to search and read, with a 15-step budget. In the Hermetismo collection (2,957 sources, 128 MB) completeness therefore depends on luck. kb classifies whole documents only, so a chapter inside a 255 KB book has no label of its own. Its 39 concepts are stubs, and one of them tags 66 % of the collection. The vault's `AGENTS.md` says it follows Karpathy's LLM Wiki pattern (immutable raw sources, a wiki the model compiles and keeps current, a schema, `index.md` and `log.md`, and the ingest/query/lint cycle). In practice it has only the structure: kb leaves the writing of articles to an agent ("Articles are still written by the agent"), and none has been written. kb's code is not on this machine, and kb owns the frontmatter keys it writes (`summary`, `concepts`, `related`, `affects`, `criterion`, `aliases`, ...).

## Decision

1. **A tool of this repository, run on the Mac.** `tools/kb-map` is Python run with uv, like `tools/transcriber`. It reads what kb writes and compiles the wiki. Only the Mac writes the map (KBC-139 BR-4). The API reads it later (KBC-144) and never writes it.

2. **Two layers, each with its owner.**
   - The **machine layer** is `<topic>/map/` and belongs to kb-map alone; kb only reads it:
     - `sections/<doc id>.json`, the sections of one source;
     - `tree.json`, the nodes and every section's placement;
     - `owner-edits.json`, the owner's fixed corrections;
     - `tree-review.md`, the owner's review file;
     - `review-queue.json`, what waits for a person;
     - `dossiers/<node>.json`, the exact section set and the aspects of each node;
     - `entities.json`, the exact section set of each entity page;
     - `affects.json`, the wiki pages each source supports.
   - The **readable layer** is the wiki, with these pages:
     - `<topic>/wiki/concepts/*.md`, kb's stubs, which become the roots' articles;
     - `<topic>/wiki/subjects/*.md`, one article per non-root node;
     - `<topic>/wiki/entities/*.md`, one page per author, figure, work or place;
     - `<topic>/index.md`, the generated catalog by category, one line per page with its section and source counts, which the agent reads first.

   Sections, propositions and the tree stay in JSON: they are data for code and checks, not pages for kb or QMD.

3. **What kb-map may write in the vault, and nothing else:**
   - Anything under `<topic>/map/`.
   - New pages in `wiki/subjects/`, `wiki/entities/` and `index.md`, created with kb's article keys (`title`, `type`, `stage`, `domain`, `tags`, `created`, `updated`, `sources`) and the marker key `kb_map`.
   - An existing page only when it is kb's untouched stub (`stage: stub`) or carries `kb_map`, and never one with `locked: true`. In that page kb-map replaces only the keys it owns (`stage: compiled`, `updated`, `sources`, `kb_map`, `kb_map_node`, `kb_map_entity`), line by line. Every other frontmatter line (kb's `criterion`, `aliases` and relations, the owner's keys) stays byte for byte, and the body is rewritten. Any other page is refused and reported.
   - New entries at the end of `<topic>/log.md`, kb's append-only log, in kb's format (`## [date] map | ...` for sections, tree and corrections; `## [date] compile | ...` for dossiers).
   - Never the sources (`raw/` is immutable, as the pattern requires), never `topic.yaml`, `AGENTS.md`, kb's index pages or kb's state.

4. **Sections (KBC-139).**
   - **Cut points.** The splitter cuts each body into blocks with no gap and no overlap. A Markdown heading is a block of its own and opens a unit, so a section never crosses a heading; KBC-148's structured Markdown makes these the chapters. A paragraph opening with `[m:ss]`/`[h:mm:ss]` is a block, with its time and its `**Speaker:**` label: a transcribed track is treated exactly like a text, cut at its anchors instead of its headings. Any other paragraph is a block, which is the fallback for plain text.
   - **The model's part.** Units are grouped into windows of at most 16,000 characters. For each window the model chooses which block edges to use and annotates each section with `context`, `propositions[]` (each with its `speaker`), `entities[]`, `speaker` and `status` (`ok` or `fora-do-mapa` with a `reason`).
   - **Validation.** The code checks that positions sit on block edges inside the window, that coverage runs contiguously from the window's first to its last character, and that every heading starts a section. It retries once; after a second failure the document goes to the review queue and nothing is written for it.
   - **Positions.** They are counted the way `read_document` counts them: UTF-16 units in the NFC body after the frontmatter.
   - **Authorship.** A speaker's group is the document's `author_group` when the speaker is its author, `mestre-laercio` for his names, and `outros-autores` for anyone else.
   - **Incremental.** A source whose body hash and extractor version did not change is never sent again.

5. **Providers and budget.**
   - **OpenRouter is the default.** It uses kb's own model from `kb.toml` `[generation]` (`model`, with `fallback_model` in OpenRouter's `models` list). The key comes from the environment or from the Keychain item `transcriber keys set` stores (service `nova-alexandria-transcriber-kb`, KBC-117). It is read with fixed arguments, used only in the request header, and never printed, logged, written or put in any argv.
   - **The subscriptions are alternatives.** The Claude Code CLI (`claude -p`) and Codex (`codex exec`) get the prompt on stdin and run in an empty temporary folder.
   - **The hard budget.** `--max-usd` refuses a call whose projected cost (the cost per character seen so far, plus 50 %) would pass the ceiling. A run therefore passes it by at most its first call. The run stops with exit 3 and keeps what it saved, and running again resumes. Codex reports no cost, so the budget cannot limit it.
   - **Tests** use a scripted fake provider and never reach a model, the network or the Keychain.

6. **The tree (KBC-140).**
   - **Building it.** The roots are kb's concepts. Subjects below them come from the model grouping the sections' propositions, and each subject gets a name, a description, a criterion and synonyms. A node holds 3 to 300 sections: a larger node is split, a smaller one is merged into its largest sibling unless the owner pinned it.
   - **Placement.** Each section is placed in one or more nodes. A section that fits none goes to review (`a-revisar`) on the nearest node, and a new-node proposal enters the queue.
   - **Stable ids.** Ids never change: a group proposed again is matched to the node it became, by every name that node ever had.
   - **Synonyms** are kept only when they occur in the node's own sections, so kb's English aliases are dropped.
   - **The owner's review** works through `map/tree-review.md` and a YAML file of `rename`, `merge`, `move`, `delete` and `pin` corrections. They are kept in `owner-edits.json` and re-applied on every rebuild. A deleted name is never re-created, and a merged name goes to its survivor.

7. **Dossiers as wiki articles (KBC-141).**
   - **The exact set.** Each node's dossier is compiled from all of its confirmed sections, which form its exact set; sections still to review stay out of the article until a person places them.
   - **Enforcing it.** Citations outside the set are dropped, and a statement without a citation is dropped. Sections the model forgot are sent back once to be placed in an aspect; forgotten twice, nothing is written and the node goes to the review queue.
   - **Authorship.** A statement is filed under the group of the sections it cites, and one that mixes Mestre Laércio with other authors is dropped. Comparisons belong in agreements and divergences.
   - **Entity pages** are built from the sections with no model call: what the collection says about the entity, each proposition cited, the two groups apart.
   - **Sources.** Each article lists them in `sources` and links each section as `[[raw/...|Title]] §n (m:ss)`. That is what `kb link` reads to write its `affects` relations. kb-map never writes `affects` itself (a kb-owned key on immutable sources); its own `map/affects.json` is the source of truth for recompiling (KBC-142).

8. **Completeness proved by code, before every sync.** `kb-map check <topic>` makes no model call. It exits 1 and names each problem:
   - a source with no sections, with sections of another content (hash), or with sections that do not cover its body;
   - an `ok` section in no node, or the tree placing a section that does not exist;
   - a node with no dossier, a dossier that does not cite exactly its node's confirmed sections, or a section in no aspect;
   - a dossier compiled from another content.

   `deploy/scripts/sync-vault.sh` runs it for every topic that has a `map/`. When it fails, the paths kb-map owns in that topic (`kb-map paths`: `map/`, `index.md` and every page with `kb_map`) are excluded from the transfer and not deleted on the VM, so production keeps its previous map. The log says why, and the rest of the vault is sent. During a backfill (KBC-143) the check fails until every source is mapped, which is the intended order: the map reaches production only when it is complete.

9. **A layout for parallel work.** One module per subcommand in `tools/kb-map/src/kb_map/commands/`, discovered by name. `convert` (KBC-148), `update` (KBC-142) and `lint` (KBC-147) are new modules that change no shared file.

## Options considered

1. **A tool here that compiles the wiki kb already lays out (chosen).** It follows the pattern fully and keeps kb as the owner of its keys and sources. It can move into kb later. The cost is a second writer in the vault, bounded by §3.
2. **Map only, in a folder apart, with no wiki pages.** Simpler, but the concept pages would stay stubs, `kb link`/`kb lint` would never see the compiled pages, and the student would get no readable map. This is the version the analysis moved away from (§2a).
3. **Change kb itself.** Its code is not on this machine; revisit if the owner wants the tool inside kb.
4. **Let the model choose character offsets freely.** Models are unreliable with offsets. Deterministic cut points make the validation cheap and the coverage provable.
5. **Write `affects` on the sources.** That breaks the immutability of `raw/` and takes a kb-owned key away from kb.

## Consequences

- Good: completeness is a property of the map, proved by `kb-map check`. The concept stubs become articles. Every sentence cites its section, and the two authorship groups stay apart.
- Good: production only ever has a complete map, and a failed check never blocks the rest of the vault.
- Bad: QMD indexes the new Markdown pages (`wiki/subjects`, `wiki/entities`, `index.md`, `map/tree-review.md`) like any topic file. The API's catalog serves only `raw/` and `wiki/concepts`, so search hits outside it are dropped until KBC-137/KBC-144 decide how the pages are shown.
- Bad: a page that disappears from the tree (merged or deleted node) stays in the wiki until a lint (KBC-147) reports it.
- Bad: the first full run costs money or subscription quota (the analysis estimates US$ 5–15 on the cheap model). `--max-usd` bounds it, and the pilot (KBC-139 AC-5, KBC-143) measures it before the whole collection runs.
