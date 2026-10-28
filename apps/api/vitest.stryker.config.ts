import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mutation testing of the media queue and Range (phase-2 quality bar, ≥ 80%): only the
// tests that exercise them run for each mutant.
export default defineConfig({
  resolve: {
    alias: {
      '@kb-chat/contracts': fileURLToPath(
        new URL('../../libs/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'src/adapters/sqlite/**/*.test.ts',
      'src/modules/media/**/*.test.ts',
      'src/media.integration.test.ts',
      'src/media-janitor.integration.test.ts',
    ],
    restoreMocks: true,
  },
});
