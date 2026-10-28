import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
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
