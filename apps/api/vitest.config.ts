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
      ],
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});
