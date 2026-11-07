import { describe, expect, it } from 'vitest';
import { openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaDocumentStore } from './sqlite-media-document-store.js';

const AT = new Date('2026-11-07T14:02:00.000Z');
const LATER = new Date('2026-11-07T14:30:00.000Z');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const PATH = 'raw/media/r/m1.md';

function aStore() {
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  return { db, store: new SqliteMediaDocumentStore(db) };
}

const want = (
  store: SqliteMediaDocumentStore,
  input: { topic?: string; path?: string; fingerprint?: string } = {},
) =>
  store.desire({
    mediaId: 'm1',
    topic: input.topic ?? 'hermetismo',
    path: input.path ?? PATH,
    fingerprint: input.fingerprint ?? A,
    now: AT,
  });

let jobs = 0;

/** A lease of the collection's job, delivering what is given, and its result. */
function publish(
  store: SqliteMediaDocumentStore,
  input: {
    topic?: string;
    items: Parameters<SqliteMediaDocumentStore['deliver']>[1]['items'];
    ok?: boolean;
  },
) {
  const topic = input.topic ?? 'hermetismo';
  jobs += 1;
  store.enqueue({ topic, id: `job-${jobs}`, now: AT });
  const job = store.lease({
    worker: 'mac',
    leaseId: 'lease',
    now: AT,
    leaseMs: 60_000,
    maxAttempts: 4,
    topic,
  });
  if (!job) throw new Error('no job');
  const owner = { jobId: job.id, leaseId: 'lease', worker: 'mac' };
  store.deliver(owner, { items: input.items, budgetUsd: 0.5 });
  return store.complete(owner, {
    outcomes: input.items.map((item) => ({
      path: item.path,
      ok: input.ok ?? true,
      ...(input.ok === false ? { error: 'kb index: exit 1' } : {}),
      spendUsd: 0,
    })),
    now: AT,
  });
}

describe('SqliteMediaDocumentStore (KBC-100)', () => {
  it('a document never published leaves no removal when it goes', () => {
    const { store } = aStore();
    want(store);
    expect(store.retire('m1', AT)).toBe('hermetismo');
    expect(store.removalsOf('hermetismo', 50)).toEqual([]);
    expect(store.retire('m1', AT)).toBeNull();
  });

  it('a published document that moves leaves a removal at its old place; wanted back there, it is dropped', () => {
    const { store } = aStore();
    want(store);
    publish(store, {
      items: [{ op: 'write', mediaId: 'm1', path: PATH, fingerprint: A }],
    });
    want(store, { topic: 'udv', fingerprint: B });
    expect(store.removalsOf('hermetismo', 50)).toEqual([
      { mediaId: 'm1', path: PATH },
    ]);
    expect(store.hasPending('hermetismo')).toBe(true);
    want(store, { topic: 'hermetismo', fingerprint: B });
    expect(store.removalsOf('hermetismo', 50)).toEqual([]);
  });

  it('a removal done is forgotten; one that failed spends an attempt and keeps the error', () => {
    const { store } = aStore();
    want(store);
    publish(store, {
      items: [{ op: 'write', mediaId: 'm1', path: PATH, fingerprint: A }],
    });
    store.retire('m1', AT);
    publish(store, {
      items: [{ op: 'remove', mediaId: 'm1', path: PATH }],
      ok: false,
    });
    expect(store.removalsOf('hermetismo', 50)).toHaveLength(1);
    publish(store, { items: [{ op: 'remove', mediaId: 'm1', path: PATH }] });
    expect(store.removalsOf('hermetismo', 50)).toEqual([]);
    expect(store.hasPending('hermetismo')).toBe(false);
  });

  it('a file written for a document retired meanwhile is removed again', () => {
    const { store } = aStore();
    want(store);
    store.enqueue({ topic: 'hermetismo', id: 'j', now: AT });
    const job = store.lease({
      worker: 'mac',
      leaseId: 'lease',
      now: AT,
      leaseMs: 60_000,
      maxAttempts: 4,
    });
    if (!job) throw new Error('no job');
    const owner = { jobId: job.id, leaseId: 'lease', worker: 'mac' };
    store.deliver(owner, {
      items: [{ op: 'write', mediaId: 'm1', path: PATH, fingerprint: A }],
      budgetUsd: 0.5,
    });
    store.retire('m1', AT);
    store.complete(owner, {
      outcomes: [{ path: PATH, ok: true, spendUsd: 0 }],
      now: AT,
    });
    expect(store.removalsOf('hermetismo', 50)).toEqual([
      { mediaId: 'm1', path: PATH },
    ]);
  });

  it('a job leased before KBC-100 delivered writes with no op: its result still publishes', () => {
    const { db, store } = aStore();
    want(store);
    store.enqueue({ topic: 'hermetismo', id: 'j', now: AT });
    store.lease({
      worker: 'mac',
      leaseId: 'lease',
      now: AT,
      leaseMs: 60_000,
      maxAttempts: 4,
    });
    db.prepare('UPDATE kb_publish_jobs SET items = ?').run(
      JSON.stringify([{ mediaId: 'm1', path: PATH, fingerprint: A }]),
    );
    store.complete(
      { jobId: 'j', leaseId: 'lease', worker: 'mac' },
      { outcomes: [{ path: PATH, ok: true, spendUsd: 0 }], now: AT },
    );
    expect(store.publishedFingerprint('m1')).toBe(A);
  });

  it('FR-6: live only when the catalog sees the fingerprint wanted now', () => {
    const { store } = aStore();
    want(store);
    expect(store.statusOf('m1')).toMatchObject({
      liveFingerprint: null,
      liveAt: null,
      lastError: null,
    });
    expect(store.markLive([{ mediaId: 'm1', fingerprint: B }], AT)).toBe(0);
    expect(store.markLive([{ mediaId: 'm1', fingerprint: A }], AT)).toBe(1);
    expect(store.markLive([{ mediaId: 'm1', fingerprint: A }], LATER)).toBe(0);
    expect(store.statusOf('m1')).toMatchObject({
      liveFingerprint: A,
      liveAt: AT.toISOString(),
    });
    expect(store.statusOf('nada')).toBeNull();
  });

  it('retry starts the attempts over; without a row there is nothing to retry', () => {
    const { db, store } = aStore();
    want(store);
    db.prepare(
      "UPDATE media_documents SET attempts = 4, state = 'failed', last_error = 'x'",
    ).run();
    expect(store.queueSummary().failed).toEqual([
      {
        mediaId: 'm1',
        topic: 'hermetismo',
        title: '',
        error: 'x',
        since: AT.toISOString(),
      },
    ]);
    expect(store.retry('m1', LATER)).toEqual(['hermetismo']);
    expect(store.statusOf('m1')).toMatchObject({
      attempts: 0,
      lastError: null,
    });
    expect(store.retry('nada', LATER)).toEqual([]);
  });

  it('review 5: a removal given up on is listed as failed, not waiting, and retry reopens it', () => {
    const { store } = aStore();
    want(store);
    publish(store, {
      items: [{ op: 'write', mediaId: 'm1', path: PATH, fingerprint: A }],
    });
    store.retire('m1', AT);
    for (let attempt = 1; attempt <= 4; attempt += 1)
      publish(store, {
        items: [{ op: 'remove', mediaId: 'm1', path: PATH }],
        ok: false,
      });
    expect(store.removalsOf('hermetismo', 50)).toEqual([]);
    expect(store.hasPending('hermetismo')).toBe(false);
    expect(store.queueSummary()).toMatchObject({
      waiting: 0,
      failed: [
        {
          mediaId: 'm1',
          topic: 'hermetismo',
          title: PATH,
          error: 'kb index: exit 1',
        },
      ],
    });

    expect(store.retry('m1', LATER)).toEqual(['hermetismo']);

    expect(store.removalsOf('hermetismo', 50)).toEqual([
      { mediaId: 'm1', path: PATH },
    ]);
    expect(store.queueSummary()).toMatchObject({ waiting: 1, failed: [] });
  });

  it('review 5: retry leaves a removal still being tried as it is', () => {
    const { db, store } = aStore();
    want(store);
    publish(store, {
      items: [{ op: 'write', mediaId: 'm1', path: PATH, fingerprint: A }],
    });
    store.retire('m1', AT);
    publish(store, {
      items: [{ op: 'remove', mediaId: 'm1', path: PATH }],
      ok: false,
    });
    expect(store.retry('m1', LATER)).toEqual([]);
    expect(
      db.prepare('SELECT attempts FROM media_document_removals').get()?.[
        'attempts'
      ],
    ).toBe(1);
  });

  it('keeps the newest sync report, and none before the first', () => {
    const { store } = aStore();
    expect(store.lastSync()).toBeNull();
    for (const [id, ok, at] of [
      ['s1', true, AT],
      ['s2', false, LATER],
    ] as const)
      store.recordSync({
        id,
        worker: 'mac',
        ok,
        detail: 'x'.repeat(3_000),
        startedAt: at.toISOString(),
        finishedAt: at.toISOString(),
      });
    const last = store.lastSync();
    expect(last).toMatchObject({ id: 's2', ok: false });
    expect(last?.detail).toHaveLength(2_000);
    expect(store.queueSummary()).toMatchObject({
      waiting: 0,
      lastPublishedAt: null,
    });
  });

  it('finds the documents under a recording, and only those', () => {
    const { store } = aStore();
    want(store);
    store.desire({
      mediaId: 'm2',
      topic: 'hermetismo',
      path: 'raw/media/rr/m2.md',
      fingerprint: A,
      now: AT,
    });
    expect(store.documentedUnder('r')).toEqual(['m1']);
    expect([...store.documented()].sort()).toEqual(['m1', 'm2']);
    expect(store.hasTracks('r')).toBe(false);
  });
});
