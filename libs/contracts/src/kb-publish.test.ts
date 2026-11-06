import { describe, expect, it } from 'vitest';
import {
  completeKbPublishRequestSchema,
  failJobRequestSchema,
  kbPublishItemSchema,
} from './media.js';

const RECORDING = '7d2f4a10-5c3e-4b8a-9f01-3a6e2b9c0d01';
const TRACK = '7d2f4a10-5c3e-4b8a-9f01-3a6e2b9c0d11';
const OWNER = {
  worker: 'mac',
  leaseId: '11111111-1111-4111-8111-111111111111',
};

const item = (path: string) => ({
  op: 'write' as const,
  path,
  markdown: '---\n---\n',
  fingerprint: 'a'.repeat(64),
});

describe('kb-publish item path (KBC-099, review BLOCKING)', () => {
  it('takes only the path the API renders: raw/media/<recording>/<track>.md', () => {
    expect(
      kbPublishItemSchema.safeParse(item(`raw/media/${RECORDING}/${TRACK}.md`))
        .success,
    ).toBe(true);
  });

  it.each([
    'raw/media/../articles/x.md',
    `raw/media/${RECORDING}/../../articles/x.md`,
    `raw/media/${RECORDING}/./${TRACK}.md`,
    `raw/media/${RECORDING}/${TRACK}/x.md`,
    `raw/media/${RECORDING}.md`,
    `raw/media/${RECORDING}/${TRACK}.md.partial`,
    `/raw/media/${RECORDING}/${TRACK}.md`,
    `raw/media/${RECORDING.toUpperCase()}/${TRACK}.md`,
  ])('refuses %s', (path) => {
    expect(kbPublishItemSchema.safeParse(item(path)).success).toBe(false);
  });
});

describe('kb-result facets (KBC-099, the shapes kb 0.0.12 writes)', () => {
  const result = (facets: unknown) => ({
    ...OWNER,
    documents: [
      {
        path: `raw/media/${RECORDING}/${TRACK}.md`,
        ok: true,
        facets,
        spendUsd: 0.0005,
      },
    ],
  });

  it('keeps what kb really wrote (depth 1.4, relevance core, wikilinked concepts)', () => {
    const parsed = completeKbPublishRequestSchema.parse(
      result({
        genre: 'talk_or_interview',
        depth: 1.4,
        relevance: 'core',
        concepts: ['Hermetismo e Filosofia Hermética'],
        summary: 'Explica o quinto princípio hermético.',
        entities: ['Lei do Ritmo'],
      }),
    );
    expect(parsed.documents[0]?.facets).toMatchObject({
      depth: 1.4,
      relevance: 'core',
    });
  });

  it('never refuses the result over a facet of another shape: the spend is already made', () => {
    const parsed = completeKbPublishRequestSchema.safeParse(
      result({
        depth: 'intermediate',
        relevance: 3,
        genre: ['a', 'b'],
        concepts: 'not a list',
        summary: 'x'.repeat(10_000),
      }),
    );
    expect(parsed.success).toBe(true);
    const facets = parsed.data?.documents[0]?.facets;
    expect(facets?.depth).toBe('intermediate');
    expect(facets?.relevance).toBe(3);
    expect(facets?.genre).toBeUndefined();
    expect(facets?.concepts).toBeUndefined();
    expect(facets?.summary).toBeUndefined();
  });

  it('drops facets that are not an object at all', () => {
    const parsed = completeKbPublishRequestSchema.safeParse(result('oops'));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.documents[0]?.facets).toBeUndefined();
  });
});

describe('a failed kb-publish reports what kb spent before failing (review IMPORTANT)', () => {
  const fail = { ...OWNER, failure: 'conversion-failed', detail: 'kb link: x' };

  it('takes an optional spendUsd', () => {
    expect(failJobRequestSchema.parse(fail)).toEqual(fail);
    expect(
      failJobRequestSchema.parse({ ...fail, spendUsd: 0.0014 }).spendUsd,
    ).toBe(0.0014);
  });

  it('refuses a negative spend or one past the per-job budget', () => {
    expect(
      failJobRequestSchema.safeParse({ ...fail, spendUsd: -1 }).success,
    ).toBe(false);
    expect(
      failJobRequestSchema.safeParse({ ...fail, spendUsd: 0.51 }).success,
    ).toBe(false);
  });
});
