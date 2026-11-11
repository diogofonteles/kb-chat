# 0028 — Collections created in the app live in the app's state; one level of sub-collections

- Status: accepted (2026-11-03), to be implemented by KBC-048
- Amends: [0010](0010-deploy-oracle-cloud-always-free.md) only in that the list of collections is no longer the vault's alone; Q7 is unchanged
- Drivers: the owner's request (2026-10-29): whoever may upload content creates a collection ("UDV") and sub-collections ("Palavra do Mestre") from the screen, without a terminal or a restart; Q7 (the API never writes to the vault or the QMD index); the vault is a one-way `rsync --delete` copy from the owner's Mac (ADR 0010)

## Context

KBC-048 first said "create the topic in the vault, like `kb topic new`". In production that cannot hold: the vault is mounted read-only for the API (Q7), and `sync-vault.sh` mirrors the Mac with `--delete`, so a folder written on the server would be erased by the next sync. Media (ADR 0022, 0024) already lives outside the vault, and media is what new collections are first used for (the UDV talks).

## Decision

1. **A collection registry in the app's state** (`collections.json` in the state directory, atomic writes): slug, title, description, parent, who created it and when. A collection exists when the vault has a topic folder with that slug, or the registry has it, or both.
2. **Merge, vault first for content, registry first for names.** Documents come only from the vault; a registry collection with no vault folder has no documents until the owner creates the folder on the Mac (`kb topic new <slug> …`) and syncs; media can be uploaded to it at once. A title or description in the registry overrides the vault's `topic.yaml`, so renaming never touches the vault.
3. **One level of sub-collections.** A sub-collection's slug is `<parent>/<name>`; the parent must be a top-level collection. The vault reader now also finds a topic folder inside a topic folder (`udv/palavra-do-mestre`), one level down.
4. **Slug from the name, fixed forever.** Lowercase, no accents, hyphens; unique; renaming changes only the title, so links, permissions and media keep working.
5. **Access follows the tree.** Access to a collection includes its sub-collections, by the catalog's tree and never by the slug's text (a vault folder that only groups topics grants nothing, and no new collection may take its name); access to a sub-collection alone shows the parent only as a group title and never opens it.
6. **The parent's content includes its sub-collections** in the search, the facets, the suggestions and the media list, each result keeping (and opening in) its own collection; a "Sub-acervo" filter restricts it to some of them. AI research stays on the chosen collection's own documents (a later item may widen it).
7. **A new feature, "Criar acervos" (`collection-create`),** granted per person; masters hold it. Whoever creates a collection gets access to it and may rename it; masters rename any.

## Options considered

1. **Registry in the app's state (chosen).** Works in production at once, keeps Q7, survives every sync.
2. **Write `kb topic new` into the vault.** Faithful to `kb`, but impossible on the read-only mount and erased by `rsync --delete`.
3. **Make the sync two-way.** Would let the server write the vault, but breaks the Mac as the single source and Q7, for a feature that does not need it.

## Consequences

- Good: a collection appears for its creator within a second; media can go into it right away.
- Bad: a collection created on the screen has no documents until the owner mirrors it on the Mac; the screen says so when it is empty.
- Bad: the search of a parent queries one index collection per sub-collection; a parent has few of them, and empty ones are skipped.
- Compliance: integration tests of create, rename, duplicate, depth limit, permission tree and search over a parent; E2E of the dialog and the tree.
