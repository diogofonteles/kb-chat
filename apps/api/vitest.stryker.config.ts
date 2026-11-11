import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** The repository root, found from here: Stryker runs this file from a sandbox copy. */
function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error('pnpm-workspace.yaml not found above this config');
    dir = parent;
  }
  return dir;
}

// Mutation testing of the media queue and Range (phase-2 quality bar, ≥ 80%): only the
// tests that exercise them run for each mutant.
export default defineConfig({
  resolve: {
    alias: {
      '@kb-chat/contracts': join(
        repositoryRoot(),
        'libs/contracts/src/index.ts',
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
