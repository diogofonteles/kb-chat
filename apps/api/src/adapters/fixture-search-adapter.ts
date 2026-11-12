import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
  SearchIndexStatus,
} from '../ports/search-index.js';
import type { VaultReaderPort } from '../ports/vault-reader.js';

const normalize = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const tokenize = (text: string): string[] =>
  normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2);

function matchingLine(text: string, tokens: readonly string[]): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) =>
    tokens.some((token) => normalize(line).includes(token)),
  );
  return index < 0 ? '' : lines.slice(index, index + 3).join('\n');
}

interface ScoreInput {
  readonly id: string;
  readonly text: string;
  readonly tokens: readonly string[];
  readonly mode: IndexQuery['mode'];
}

function scoreDocument({
  id,
  text,
  tokens,
  mode,
}: ScoreInput): IndexHit | null {
  const haystack = normalize(text);
  const found = tokens.filter((token) => haystack.includes(token));
  const required = mode === 'exact' ? tokens.length : 1;
  if (tokens.length === 0 || found.length < required) return null;
  return {
    id,
    score: found.length / tokens.length,
    snippet: matchingLine(text, found),
  };
}

/**
 * Deterministic in-process index over the vault files, used by E2E and
 * integration tests when QMD and its models are not available (KB_CHAT_SEARCH=fixture).
 * "exact" requires every token; "all" and "semantic" accept any token.
 */
export class FixtureSearchAdapter implements SearchIndexPort {
  constructor(
    private readonly vault: VaultReaderPort,
    private readonly topicByCollection: (collection: string) => string,
  ) {}

  status(): SearchIndexStatus {
    return 'ok';
  }

  async search(query: IndexQuery): Promise<readonly IndexHit[]> {
    const topic = this.topicByCollection(query.collection);
    const tokens = tokenize(query.q);
    const ids = await this.vault.listDocuments(topic);
    const hits: IndexHit[] = [];
    for (const id of ids) {
      const text = (await this.vault.readDocument(topic, id)) ?? '';
      const hit = scoreDocument({ id, text, tokens, mode: query.mode });
      if (hit) hits.push(hit);
    }
    // Like QMD's bm25 or RRF, a score that also depends on the rest of the collection (here
    // how many documents match): the same order, a value that moves with every document,
    // those above a person's level included (KBC-111 review R2-2).
    const spread = 1 / (1 + hits.length / 100);
    return hits
      .map((hit) => ({ ...hit, score: hit.score * spread }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, query.limit);
  }

  async close(): Promise<void> {
    // In-process; nothing to release.
  }
}
