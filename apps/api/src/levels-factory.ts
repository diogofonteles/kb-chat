import { join } from 'node:path';
import { FsLevelAudit } from './adapters/fs-level-audit.js';
import { JsonDocumentStore } from './adapters/json-document-store.js';
import type { LevelDeps } from './app.js';
import { LevelDirectory } from './modules/access-levels/index.js';

/**
 * Access levels on disk (KBC-103, ADR 0036 §1, §3, §11): `access-levels.json`,
 * `document-levels.json`, `document-presence.json` (KBC-107) and `audit/levels-YYYY-MM.jsonl` in the state folder, backed up
 * with `collections.json` and `authors.json`.
 */
export const levelsOnDisk = (stateDir: string): LevelDeps => ({
  directory: new LevelDirectory({
    scales: new JsonDocumentStore(join(stateDir, 'access-levels.json')),
    documents: new JsonDocumentStore(join(stateDir, 'document-levels.json')),
    presence: new JsonDocumentStore(join(stateDir, 'document-presence.json')),
  }),
  audit: new FsLevelAudit(join(stateDir, 'audit')),
});
