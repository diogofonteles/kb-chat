import { describe, expect, it } from 'vitest';
import { kbPublishJobSchema, transcriberStatusReportSchema } from './media.js';

const RECORDING = '7d2f4a10-5c3e-4b8a-9f01-3a6e2b9c0d01';
const TRACK = '7d2f4a10-5c3e-4b8a-9f01-3a6e2b9c0d11';

const job = (collection: unknown) => ({
  id: '11111111-1111-4111-8111-111111111111',
  leaseId: '22222222-2222-4222-8222-222222222222',
  kind: 'kb-publish',
  topic: 'udv/palavra-do-mestre',
  attempt: 1,
  leaseMs: 60_000,
  budgetUsd: 0.5,
  items: [{ op: 'remove', path: `raw/media/${RECORDING}/${TRACK}.md` }],
  ...(collection !== undefined && { collection }),
});

describe('kb-publish job collection (KBC-114 FR-2)', () => {
  it('carries the title, domain and parent the Mac needs to create the vault topic', () => {
    const parsed = kbPublishJobSchema.parse(
      job({
        title: 'Palavra do Mestre',
        domain: 'espiritualidade',
        parent: { slug: 'udv', title: 'UDV', domain: 'espiritualidade' },
      }),
    );
    expect(parsed.collection?.parent?.slug).toBe('udv');
  });

  it('stays optional for an API older than it', () => {
    expect(kbPublishJobSchema.safeParse(job(undefined)).success).toBe(true);
  });

  it.each([
    { title: '', domain: 'geral', parent: null },
    { title: 'linha 1\nlinha 2', domain: 'geral', parent: null },
    { title: 'tab\there', domain: 'geral', parent: null },
    { title: 'X', domain: 'Esoterismo Geral', parent: null },
    { title: 'X', domain: '../geral', parent: null },
    {
      title: 'X',
      domain: 'geral',
      parent: { slug: 'a/b', title: 'A', domain: 'geral' },
    },
  ])('refuses an unsafe collection %#', (collection) => {
    expect(kbPublishJobSchema.safeParse(job(collection)).success).toBe(false);
  });
});

const report = {
  state: 'working',
  detail: null,
  version: '0.1.0 (2026-10-28.1)',
  kinds: ['transcribe', 'kb-publish'],
  startedAt: '2026-11-09T12:00:00.000Z',
  currentJob: {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'transcribe',
    label: 'Aula 3',
    startedAt: '2026-11-09T12:01:00.000Z',
    progress: 40,
  },
  recentJobs: [],
  lastError: null,
  counts: { done: 2, failed: 0 },
  vaultPath: '/Users/owner/vault',
  kbVersion: '0.0.12',
};

describe('transcriber status report (KBC-114 FR-8)', () => {
  it('takes "stopped", what a worker says as it exits (KBC-114 AC-18)', () => {
    expect(
      transcriberStatusReportSchema.parse({ ...report, state: 'stopped' })
        .state,
    ).toBe('stopped');
  });

  it('takes what the worker sends', () => {
    expect(transcriberStatusReportSchema.parse(report).state).toBe('working');
  });

  it.each([
    { ...report, state: 'sleeping' },
    { ...report, token: 'nat_x' },
    { ...report, recentJobs: Array.from({ length: 11 }, () => ({})) },
    { ...report, currentJob: { ...report.currentJob, progress: 101 } },
  ])('refuses a body outside the contract %#', (body) => {
    expect(transcriberStatusReportSchema.safeParse(body).success).toBe(false);
  });
});
