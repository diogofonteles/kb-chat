import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
  SearchIndexStatus,
} from '../ports/search-index.js';
import { toTopicRelativeId } from './search-mode-queries.js';

const run = promisify(execFile);

const hitsSchema = z.array(
  z.object({
    path: z.string(),
    score: z.number(),
    preview: z.string().default(''),
  }),
);

const MODE_FLAGS: Record<IndexQuery['mode'], readonly string[]> = {
  all: [],
  exact: ['--lex'],
  semantic: ['--vec'],
};

export interface KbCliOptions {
  readonly command: string;
  readonly vault: string;
  readonly timeoutMs?: number;
}

/** Fallback search: one `kb search` process per call, no shell (ADR 0002). */
export class KbCliSearchAdapter implements SearchIndexPort {
  constructor(private readonly options: KbCliOptions) {}

  status(): SearchIndexStatus {
    return 'degraded';
  }

  async search(query: IndexQuery): Promise<readonly IndexHit[]> {
    const args = [
      'search',
      query.q,
      '--collection',
      query.collection,
      '--format',
      'json',
      '--limit',
      String(query.limit),
      '--vault',
      this.options.vault,
      ...MODE_FLAGS[query.mode],
    ];
    const { stdout } = await run(this.options.command, args, {
      timeout: this.options.timeoutMs ?? 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return hitsSchema.parse(JSON.parse(stdout || '[]')).map((hit) => ({
      id: toTopicRelativeId(hit.path, query.collection),
      score: hit.score,
      snippet: hit.preview,
    }));
  }

  async close(): Promise<void> {
    // Nothing is kept open between calls.
  }
}
