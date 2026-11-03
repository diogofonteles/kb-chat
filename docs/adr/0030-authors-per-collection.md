# 0030 — Authors per collection in the app's state, with one main author

- Status: accepted (2026-11-03), implemented by KBC-049
- Amends: [0015](0015-authorship-in-catalog-and-tool-contracts.md) (media authorship and the research rule's subject), [0028](0028-app-owned-collections-and-sub-collections.md) (one more app-owned file)
- Drivers: KBC-049 (each tradition has its own masters and authors: "Mestre Gabriel" in the UDV, "Mestre Laércio" in the Hermetismo); Q7 (the API never writes the vault); the deploy's automatic rollback (ADR 0010)

## Context

Media had two fixed authorships (`mestre-laercio`, `outros-autores`) and the research prompt named the Mestre Laércio for every collection. Collections created on the screen (ADR 0028) need their own authors, typed by whoever uploads. Vault documents keep the `author_group` the owner's `kb classify` marks.

## Decision

1. **`authors.json` in the state directory** (atomic writes, like `collections.json`): per top-level collection, its authors (name, id from the name, who registered it and when) and at most one main author. Read from memory, loaded at start and kept in step with each write. The vault is never written.
2. **A sub-collection uses its parent's list and main author**, found through the catalog's tree, never by the slug's text (ADR 0028 §5).
3. **Same id, same author.** The id is the name without accents, lowercase, hyphenated; registering a name that already is an author returns that author (merging differently spelled names is out of scope).
4. **Media names an author id or none** ("Outros autores"). The SQLite migration is expand-only: a new `media.author` column, filled from `authorship = 'mestre-laercio'`; the old `authorship` column stays and is still written (`mestre-laercio` when the author is the main one), so the previous image keeps reading the same rows after a rollback. A later item may drop it.
5. **Vault documents map through the main author**: the `mestre-laercio` group is shown and told to the AI as the collection's main author's name ("Mestre Laércio" when the collection has none); the research rule of ADR 0015 is written for each collection's main author, and a collection without one keeps only the rule against mixing authors.
6. **One-time legacy seed at start**: a top-level collection absent from `authors.json` that has `mestre-laercio` documents or media gets "Mestre Laércio" as its main author. A collection already in the file is never touched, so a later choice sticks.
7. **Permissions**: reading the list needs the collection; registering an author needs `media-upload` there (BR-3); choosing the main author follows the rename rule (`collection-create`, creator or master).

## Options considered

1. **A JSON file in the state dir (chosen).** Same pattern and backups as the registry; independent of the optional media database; 500 authors per collection are a few kilobytes.
2. **Tables in the media SQLite database.** Transactional with the media rows, but the media database exists only with `KB_CHAT_MEDIA=on`, while documents and the prompt need the main author anyway.
3. **Authors in the vault (`topic.yaml`).** Impossible on the read-only mount (Q7) and erased by the sync.

## Consequences

- Good: any collection gets its own authors from the screen; the AI rule follows each tradition's master.
- Bad: two files to back up together (`collections.json`, `authors.json`); the legacy column stays until a later cleanup.
- Compliance: unit tests of the directory and the seed, the migration test over a database of today, integration tests of the routes, permissions, sub-collections and the prompt with a stub model, E2E of the upload field.
