import { describe, expect, it } from 'vitest';
import type { DocumentUploadRecord } from '../../ports/document-uploads.js';
import { FIRST_COSTS, MAX_SAMPLES, contentCostsOf } from './content-costs.js';

const done = (
  n: number,
  fields: Partial<DocumentUploadRecord> = {},
): DocumentUploadRecord => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  topic: 'hermetismo',
  kind: 'file',
  name: 'a.pdf',
  url: null,
  sha256: null,
  bytes: 1,
  level: null,
  owner: {
    principal: 'ana',
    email: 'ana@example.com',
    isMaster: false,
    quotaBytes: null,
    displayName: null,
  },
  state: 'mapped',
  failure: null,
  detail: null,
  document: { id: 'raw/a.md', title: 'A' },
  mediaId: null,
  lease: null,
  batch: null,
  attempts: 0,
  spentUsd: 0.001,
  workMs: 10_000,
  entries: [],
  createdAt: '2026-11-25T10:00:00.000Z',
  updatedAt: new Date(Date.UTC(2026, 10, 25, 10, 0, n)).toISOString(),
  ...fields,
});

const many = (count: number, fields: Partial<DocumentUploadRecord> = {}) =>
  Array.from({ length: count }, (_, n) => done(n, fields));

describe('contentCostsOf (KBC-186)', () => {
  it('uses the first measurements until a few of the kind were added', () => {
    expect(contentCostsOf([])).toEqual(FIRST_COSTS);
    expect(contentCostsOf(many(4)).document).toEqual(FIRST_COSTS.document);
  });

  it('says "até": most of what was added here cost and took no more than it', () => {
    const records = [...many(9), done(9, { spentUsd: 0.01, workMs: 90_000 })];
    expect(contentCostsOf(records).document).toEqual({
      usd: 0.01,
      seconds: 90,
      samples: 10,
    });
  });

  it('tells documents, images, pages and recordings apart', () => {
    const costs = contentCostsOf([
      ...many(5, { name: 'Foto.JPG', spentUsd: 0.02 }),
      ...many(5, { kind: 'url', name: 'https://a.example/x', spentUsd: 0.03 }),
      ...many(5, { kind: 'recording', spentUsd: 0.04 }),
    ]);
    expect(costs.image.usd).toBe(0.02);
    expect(costs.page.usd).toBe(0.03);
    expect(costs.recording.usd).toBe(0.04);
    expect(costs.document.samples).toBe(0);
  });

  it('leaves out what failed, what waits and what was already there', () => {
    const records = [
      ...many(5, { state: 'failed' }),
      ...many(5, { state: 'received' }),
      ...many(5, { detail: 'already in the collection' }),
      ...many(5, { kind: 'list' }),
    ];
    expect(contentCostsOf(records)).toEqual(FIRST_COSTS);
  });

  it('goes by the latest, and keeps the first time when none was measured', () => {
    const old = many(MAX_SAMPLES, {
      spentUsd: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const latest = many(MAX_SAMPLES, { workMs: null });
    expect(contentCostsOf([...old, ...latest]).document).toEqual({
      usd: 0.001,
      seconds: FIRST_COSTS.document.seconds,
      samples: MAX_SAMPLES,
    });
  });
});
