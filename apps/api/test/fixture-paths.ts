import { fileURLToPath } from 'node:url';

export const FIXTURE_VAULT = fileURLToPath(
  new URL('./fixtures/vault', import.meta.url),
);
export const FAKES_DIR = fileURLToPath(new URL('./fakes', import.meta.url));
