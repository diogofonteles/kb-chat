# kb-chat

Chat-style search over `kb` knowledge vaults: ask in plain language, choose how to search (exact words, meaning, or both), read the source document and, on request, get an AI answer grounded in the collection with cited sources.

```bash
pnpm install
pnpm dev:api   # terminal 1 — needs kb and qmd on the PATH and an indexed vault (KB_VAULT)
pnpm dev:web   # terminal 2 — open http://localhost:4200
```

- Product: [`docs/product/`](docs/product/) · Design: [`docs/design/screens.md`](docs/design/screens.md)
- Architecture: [`docs/architecture/overview.md`](docs/architecture/overview.md) · ADRs: [`docs/adr/`](docs/adr/)
- Backlog: [`docs/backlog/`](docs/backlog/) · Operations: [`CLAUDE.md`](CLAUDE.md)
