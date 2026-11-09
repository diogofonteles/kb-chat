import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { privateTemp } from '../../tools/test-temp.mjs';

privateTemp();

export default defineConfig({
  resolve: {
    alias: {
      // Tests run the contracts lib from source; the package main points at dist.
      '@kb-chat/contracts': fileURLToPath(
        new URL('../../libs/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          // Each test builds the whole app (SQLite, the vault, often a listening server): a few
          // hundred ms alone, many times that beside the web suite and other work on the same
          // machine. 5 s was the runner's default, no product budget (the NFR tests keep theirs).
          testTimeout: 15_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // The 80% floor applies to business modules and adapters; entrypoints,
      // the e2e server and scripts are exercised by E2E and manual runs.
      include: [
        'src/modules/**/*.ts',
        'src/adapters/**/*.ts',
        'src/plugins/**/*.ts',
        'src/providers/**/*.ts',
        'src/mcp/**/*.ts',
        'src/media-worker/**/*.ts',
        'src/media-factory.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        // The phase-2 quality bar (docs/backlog/README.md): 90% on the media code.
        'src/modules/media/**/*.ts': { lines: 90, functions: 90, branches: 90 },
        'src/adapters/{media,sqlite}/**/*.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
        },
        'src/media-worker/**/*.ts': { lines: 90, functions: 90, branches: 90 },
      },
    },
  },
});
