import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DocumentStorePort } from '../../ports/document-store.js';

/** web-search-seen.json: what each person was given in each collection, as short hashes. */
const seenSchema = z.object({
  version: z.literal(1).default(1),
  seen: z
    .record(z.string(), z.record(z.string(), z.array(z.string())))
    .default({}),
});

/** Whose search it is, and for which collection. */
export interface Searcher {
  readonly principal: string;
  readonly topic: string;
}

const hashOf = (key: string): string =>
  createHash('sha256').update(key).digest('base64url').slice(0, 16);

/**
 * The pages a person was already given when searching for a collection (KBC-185): the next
 * search leaves them out, whatever the day. Hashes only: the list tells no one what was
 * searched.
 */
export class SeenLinks {
  private readonly seen = new Map<string, Map<string, Set<string>>>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: DocumentStorePort) {}

  async load(): Promise<void> {
    const parsed = seenSchema.safeParse((await this.store.read()) ?? {});
    if (!parsed.success) return;
    for (const [principal, topics] of Object.entries(parsed.data.seen))
      this.seen.set(
        principal,
        new Map(
          Object.entries(topics).map(([topic, keys]) => [topic, new Set(keys)]),
        ),
      );
  }

  has({ principal, topic }: Searcher, key: string): boolean {
    return this.seen.get(principal)?.get(topic)?.has(hashOf(key)) === true;
  }

  /** Kept on disk first: a write that fails leaves them not given. */
  async add(who: Searcher, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const run = this.writing.then(async () => {
      const hashes = keys.map(hashOf);
      await this.store.write(this.snapshotWith(who, hashes));
      for (const hash of hashes) this.keysOf(who).add(hash);
    });
    this.writing = run.catch(() => undefined);
    await run;
  }

  private keysOf({ principal, topic }: Searcher): Set<string> {
    const topics = this.seen.get(principal) ?? new Map<string, Set<string>>();
    const keys = topics.get(topic) ?? new Set<string>();
    topics.set(topic, keys);
    this.seen.set(principal, topics);
    return keys;
  }

  private snapshotWith(who: Searcher, hashes: readonly string[]) {
    const seen: Record<string, Record<string, string[]>> = {};
    for (const [principal, topics] of this.seen)
      seen[principal] = Object.fromEntries(
        [...topics].map(([topic, keys]) => [topic, [...keys]]),
      );
    const own = (seen[who.principal] ??= {});
    own[who.topic] = [...new Set([...(own[who.topic] ?? []), ...hashes])];
    return { version: 1, seen };
  }
}
