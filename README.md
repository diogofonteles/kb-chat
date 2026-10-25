# Nova Alexandria

**Nova Alexandria** is the product built in this repository (`kb-chat`), served at `nova-alexandria.duckdns.org`. The name comes from the Library of Alexandria, which held the knowledge of the ancient world, and from Alexandria as the birthplace of the Corpus Hermeticum: a library of universal knowledge with an esoteric core (Hermeticism) that will also hold other sciences.

Chat-style search over `kb` knowledge vaults: ask in plain language, choose how to search (exact words, meaning, or both), read the source document and, on request, get an AI answer grounded in the collection with cited sources.

```bash
pnpm install
pnpm dev:api   # terminal 1 — needs kb and qmd on the PATH and an indexed vault (KB_VAULT)
pnpm dev:web   # terminal 2 — open http://localhost:4200
```

- Product: [`docs/product/`](docs/product/) · Design: [`docs/design/screens.md`](docs/design/screens.md)
- Architecture: [`docs/architecture/overview.md`](docs/architecture/overview.md) · ADRs: [`docs/adr/`](docs/adr/)
- Backlog: [`docs/backlog/`](docs/backlog/) · Operations: [`CLAUDE.md`](CLAUDE.md)
