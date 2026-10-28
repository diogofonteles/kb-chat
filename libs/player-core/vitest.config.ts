import { defineConfig } from 'vitest/config';

// The player's pure logic (ADR 0025): the phase-2 quality bar asks 90% coverage and a
// mutation score of 80% (Stryker, `pnpm --filter @kb-chat/player-core mutation`).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.test.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90 },
    },
  },
});
