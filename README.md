# Nova Alexandria

**Nova Alexandria** is the product built in this repository (`kb-chat`), served at `nova-alexandria.duckdns.org`. The name comes from the Library of Alexandria, which held the knowledge of the ancient world, and from Alexandria as the birthplace of the Corpus Hermeticum: a library of universal knowledge with an esoteric core (Hermeticism) that will also hold other sciences.

Chat-style search over `kb` knowledge vaults: ask in plain language, choose how to search (exact words, meaning, or both), read the source document and, on request, get an AI answer grounded in the collection with cited sources.

```bash
pnpm install
pnpm dev:api   # terminal 1 — needs kb and qmd on the PATH and an indexed vault (KB_VAULT)
pnpm dev:web   # terminal 2 — open http://localhost:4200
```

Public guide for people using the app: `/tutorial` (also linked from the sign-in screen, the app header and `/privacidade`).

### Tutorial screenshots

The tutorial's pictures are real screenshots of the app, taken by a Playwright script against the E2E server (fixture vault, fake AI providers, fictitious `@exemplo.test` people; never real data). After a UI change that the tutorial shows, regenerate them and commit the result:

```bash
pnpm tutorial:screenshots   # e2e/tutorial/capture.ts; own ports 3118/4318 (KBC_E2E_API_PORT/KBC_E2E_WEB_PORT)
```

It writes `apps/web/public/assets/tutorial/<name>-<HASH>.webp` (hashed names, cached for a year), deletes the old files and regenerates `apps/web/src/app/features/tutorial/tutorial-images.generated.ts` (sizes and bytes). A failing scene keeps the previous manifest. `tutorial-page.spec.ts` fails when a section anchor, a picture or its text alternative is missing, or when the pictures pass 3 MB; update the text in `tutorial-page.html` when a flow changes.

- Product: [`docs/product/`](docs/product/) · Design: [`docs/design/screens.md`](docs/design/screens.md)
- Architecture: [`docs/architecture/overview.md`](docs/architecture/overview.md) · ADRs: [`docs/adr/`](docs/adr/)
- Backlog: [`docs/backlog/`](docs/backlog/) · Operations: [`CLAUDE.md`](CLAUDE.md)
