import { describe, expect, it } from 'vitest';
import type { CreateDocumentUploadRequest } from '@kb-chat/contracts';
import { MemoryDocumentUploadStore } from '../../adapters/json-document-upload-store.js';
import type {
  DocumentUploadFilesPort,
  DocumentUploadRecord,
} from '../../ports/document-uploads.js';
import { DocIngestQueue } from './doc-ingest-queue.js';
import {
  DOCUMENT_UPLOAD_ABANDON_MS,
  DOCUMENT_UPLOAD_KEEP_MS,
  DocumentUploadService,
  type DocumentUploadServiceDeps,
  type UploadActor,
} from './document-upload-service.js';
import { UploadRecords } from './upload-records.js';

const SHA = 'a'.repeat(64);
const GB = 1024 ** 3;

const actor = (
  name: string,
  fields: Partial<UploadActor> = {},
): UploadActor => ({
  principal: name,
  email: `${name}@example.com`,
  isMaster: false,
  canUpload: true,
  quotaBytes: null,
  displayName: name,
  canSee: () => true,
  levelsIn: () => ['qs', 'ci'],
  seesDocument: () => true,
  ...fields,
});

const file = (
  fields: Partial<Extract<CreateDocumentUploadRequest, { kind: 'file' }>> = {},
): CreateDocumentUploadRequest => ({
  kind: 'file',
  name: 'a.pdf',
  bytes: 10,
  sha256: SHA,
  ...fields,
});

async function world(
  options: {
    records?: DocumentUploadRecord[];
    deps?: Partial<DocumentUploadServiceDeps>;
    free?: number;
  } = {},
) {
  const clock = { now: new Date('2026-11-25T12:00:00.000Z') };
  const gone: string[] = [];
  const files: DocumentUploadFilesPort = {
    offset: () => Promise.resolve(0),
    append: () => Promise.resolve(0),
    sha256: () => Promise.resolve(SHA),
    freeBytes: () => Promise.resolve(options.free ?? 100 * GB),
    find: () => Promise.resolve({ path: '/x', size: 1 }),
    remove: (id) => {
      gone.push(id);
      return Promise.resolve();
    },
  };
  const store = new MemoryDocumentUploadStore();
  store.records = options.records ?? [];
  const records = await UploadRecords.open(store);
  const now = () => clock.now;
  const service = new DocumentUploadService({
    records,
    files,
    hasTopic: () => true,
    scopeOf: (topic) => [topic, `${topic}/sub`],
    scaleOf: () => [],
    findExisting: () => null,
    inCatalog: () => false,
    now,
    ...options.deps,
  });
  const queue = new DocIngestQueue({
    records,
    files,
    budgetUsd: () => 0.5,
    now,
  });
  return { service, records, queue, clock, gone };
}

const ana = actor('ana');
const beto = actor('beto');
const master = actor('dono', { isMaster: true });

async function send(
  service: DocumentUploadService,
  who: UploadActor,
  request: CreateDocumentUploadRequest & { readonly topic?: string },
) {
  const { topic = 'hermetismo', ...body } = request;
  const answer = await service.create(who, topic, body);
  if (answer.outcome !== 'created') throw new Error('expected a new upload');
  return answer.upload;
}

const itemsOf = async (service: DocumentUploadService, who: UploadActor) =>
  (await service.list(who)).items;

const link = (
  url: string,
  fields: object = {},
): CreateDocumentUploadRequest => ({
  kind: 'url',
  url,
  ...fields,
});

const BATCH = { id: '99999999-9999-4999-8999-999999999999', capUsd: 0.5 };

describe('a file announced and not sent (review A, B7 and B8)', () => {
  it("another person's abandoned announcement blocks nobody", async () => {
    const { service } = await world();
    const first = await send(service, ana, file());
    const second = await send(service, beto, file());
    expect(second.id).not.toBe(first.id);
    expect(second.uploadUrl).not.toBeNull();
  });

  it('only its sender is told where to send the bytes', async () => {
    const { service } = await world();
    await send(service, ana, file());
    expect((await itemsOf(service, master))[0]?.uploadUrl).toBeNull();
    expect((await itemsOf(service, ana))[0]?.uploadUrl).not.toBeNull();
  });

  it('sent again by its owner it goes on, at the level and the inclusion chosen now', async () => {
    const { service, records } = await world({
      deps: {
        scaleOf: () => [
          { id: 'qs', code: 'QS' },
          { id: 'ci', code: 'CI' },
        ],
      },
    });
    const first = await send(service, ana, file({ level: 'qs' }));
    const again = await send(service, ana, file({ level: 'ci', batch: BATCH }));
    expect(again.id).toBe(first.id);
    expect(records.get(first.id)).toMatchObject({ level: 'ci', batch: BATCH });
  });

  it('to another collection it is another upload', async () => {
    const { service } = await world();
    const first = await send(service, ana, file());
    const other = await send(service, ana, {
      ...file(),
      topic: 'hermetismo/sub',
    });
    expect(other.id).not.toBe(first.id);
  });
});

describe('what an item waits for (review A, B3 and I2)', () => {
  it("what the Mac holds for one item is not told as the inclusion's ceiling reached", async () => {
    const { service, queue } = await world();
    for (const n of [1, 2, 3])
      await send(
        service,
        ana,
        link(`https://a.example/${n}`, { batch: BATCH }),
      );
    expect(queue.lease('mac')?.budgetUsd).toBe(0.5);
    const held = (await itemsOf(service, ana)).map((one) => one.heldBy);
    expect(held).toEqual([null, null, null]);
  });

  it('a month with next to nothing left is said', async () => {
    const { service } = await world({ deps: { monthLeftUsd: () => 0.0001 } });
    await send(service, ana, link('https://a.example/1'));
    expect((await itemsOf(service, ana))[0]?.heldBy).toBe('month-cap');
  });

  it('an item taken off the list still counts in its inclusion, and is not offered again', async () => {
    const { service, records } = await world();
    const sent = await send(
      service,
      ana,
      link('https://a.example/1', { batch: BATCH }),
    );
    const other = await send(
      service,
      ana,
      link('https://a.example/2', { batch: BATCH }),
    );
    await records.update(sent.id, (one) => ({
      ...one,
      state: 'mapped',
      spentUsd: 0.4,
    }));
    await service.remove(ana, sent.id);
    const listed = await itemsOf(service, ana);
    expect(listed.map((one) => one.id)).toEqual([other.id]);
    expect(listed[0]?.batch?.spentUsd).toBeCloseTo(0.4);
    // What it became is in the collection: the same link is not judged twice.
    const again = await service.create(
      ana,
      'hermetismo',
      link('https://a.example/1'),
    );
    expect(again.outcome).toBe('duplicate');
  });
});

describe('the same thing under another name', () => {
  it('the same page with a campaign mark or a fragment is one link', async () => {
    const { service } = await world();
    await send(service, ana, link('https://a.example/x?id=1'));
    const again = await service.create(
      ana,
      'hermetismo',
      link('https://a.example/x?utm_source=z&id=1#parte'),
    );
    expect(again.outcome).toBe('duplicate');
    await send(service, ana, link('https://a.example/x?id=2'));
  });

  it.each(['failed', null] as const)(
    'a recording that %s does not block its link',
    async (progress) => {
      const { service, records } = await world({
        deps: {
          mediaProgressOf: () => progress && { state: progress, step: null },
        },
      });
      const sent = await send(service, ana, link('https://youtu.be/abc'));
      await records.update(sent.id, (one) => ({
        ...one,
        state: 'transcribing',
        mediaId: '11111111-1111-4111-8111-111111111111',
      }));
      const again = await send(service, ana, link('https://youtu.be/abc'));
      expect(again.id).not.toBe(sent.id);
    },
  );
});

describe('room for files (review A, I7)', () => {
  it("a person's waiting files are bounded; a master's, by the disk", async () => {
    const { service } = await world();
    const big = (n: number) =>
      file({ bytes: 300 * 1024 ** 2, sha256: String(n).padStart(64, '0') });
    for (let n = 0; n < 17; n += 1) await send(service, ana, big(n));
    await expect(service.create(ana, 'hermetismo', big(17))).rejects.toThrow(
      expect.objectContaining({ code: 'MEDIA_QUOTA_EXCEEDED' }),
    );
    await send(service, master, big(18));
  });

  it('the disk keeps its reserve, for anyone', async () => {
    const { service } = await world({ free: 5 * GB });
    await expect(service.create(master, 'hermetismo', file())).rejects.toThrow(
      expect.objectContaining({ code: 'STORAGE_FULL' }),
    );
  });
});

describe('what is old leaves (review A, I12)', () => {
  it('a week without bytes is given up; three months after it ended a record goes', async () => {
    const { service, records, clock, gone } = await world();
    const stopped = await send(service, ana, file());
    const done = await send(service, ana, link('https://a.example/1'));
    await records.update(done.id, (one) => ({ ...one, state: 'mapped' }));

    clock.now = new Date(clock.now.getTime() + DOCUMENT_UPLOAD_ABANDON_MS + 1);
    await service.sweep();
    expect(records.get(stopped.id)).toMatchObject({
      state: 'failed',
      failure: 'upload-abandoned',
    });
    expect(gone).toContain(stopped.id);
    expect(records.get(done.id)).toBeDefined();

    clock.now = new Date(clock.now.getTime() + DOCUMENT_UPLOAD_KEEP_MS + 1);
    await service.sweep();
    expect(records.all()).toEqual([]);
  });

  it('an item whose lease expired can be taken out; one the Mac has cannot', async () => {
    const { service, queue, clock } = await world();
    const sent = await send(service, ana, link('https://a.example/1'));
    queue.lease('mac');
    await expect(service.remove(ana, sent.id)).rejects.toThrow(
      expect.objectContaining({ code: 'MEDIA_CONFLICT' }),
    );
    clock.now = new Date(clock.now.getTime() + 60 * 60 * 1000);
    await service.remove(ana, sent.id);
    expect(await itemsOf(service, ana)).toEqual([]);
  });
});

describe('the Mac, its line and how far each item is', () => {
  const MAC = { state: 'on', lastSeenAt: '2026-11-25T12:00:00.000Z' } as const;

  it('says the place and the time of each, counting everyone’s without naming them', async () => {
    const { service, queue, clock } = await world({ deps: { mac: () => MAC } });
    const at = async (who: UploadActor, n: number) => {
      clock.now = new Date(clock.now.getTime() + 1_000);
      await send(service, who, link(`https://a.example/${n}`));
    };
    await at(ana, 1);
    await at(beto, 2);
    await at(ana, 3);
    expect(queue.lease('mac')?.source).toMatchObject({
      url: 'https://a.example/1',
    });
    clock.now = new Date(clock.now.getTime() + 10_000);

    const { items, work } = await service.list(ana);
    expect(work).toEqual({ mac: MAC, busy: true, waiting: 2 });
    expect(JSON.stringify(items)).not.toContain('example/2');
    const [third, first] = items;
    // A page takes about 40 s here: 30 s left of the first, then Beto's, then hers.
    expect(first?.progress).toMatchObject({
      startedAt: expect.any(String),
      position: null,
      takesSeconds: 30,
    });
    expect(third?.progress).toEqual({
      startedAt: null,
      position: 2,
      startsInSeconds: 70,
      takesSeconds: 40,
      media: null,
    });
  });

  it('with the Mac off the place is known and the time is not', async () => {
    const off = { state: 'off', lastSeenAt: null } as const;
    const { service } = await world({ deps: { mac: () => off } });
    await send(service, ana, link('https://a.example/1'));
    const { items, work } = await service.list(ana);
    expect(work?.mac.state).toBe('off');
    expect(items[0]?.progress).toMatchObject({
      position: 1,
      startsInSeconds: null,
      takesSeconds: 40,
    });
  });

  it('with none paired, that is what is said', async () => {
    const { service } = await world();
    const { work } = await service.list(ana);
    expect(work?.mac).toEqual({ state: 'none', lastSeenAt: null });
  });

  it('an item behind a ceiling has no place in the line', async () => {
    const { service } = await world({ deps: { monthLeftUsd: () => 0 } });
    await send(service, ana, link('https://a.example/1'));
    const { items, work } = await service.list(ana);
    expect(items[0]?.heldBy).toBe('month-cap');
    expect(items[0]?.progress.position).toBeNull();
    expect(work?.waiting).toBe(0);
  });

  it('one the Mac dropped waits again, instead of "convertendo" for ever', async () => {
    const { service, queue, clock } = await world();
    await send(service, ana, link('https://a.example/1'));
    queue.lease('mac');
    clock.now = new Date(clock.now.getTime() + 60 * 60 * 1000);
    const { items, work } = await service.list(ana);
    expect(items[0]?.state).toBe('received');
    expect(items[0]?.progress).toMatchObject({ startedAt: null, position: 1 });
    expect(work?.busy).toBe(false);
  });

  it('a recording in the library says its step and how far', async () => {
    const step = { step: 'transcribing', percent: 40 } as const;
    const { service, records } = await world({
      deps: { mediaProgressOf: () => ({ state: 'transcribing', step }) },
    });
    const sent = await send(service, ana, link('https://youtu.be/abc'));
    await records.update(sent.id, (one) => ({
      ...one,
      state: 'transcribing',
      mediaId: '11111111-1111-4111-8111-111111111111',
    }));
    const [item] = await itemsOf(service, ana);
    expect(item?.state).toBe('transcribing');
    expect(item?.progress.media).toEqual(step);
  });

  it('what is ready leaves the list together, of one collection, and nothing else', async () => {
    const { service, records } = await world({
      deps: { inCatalog: () => true },
    });
    const done = async (url: string, topic = 'hermetismo') => {
      const sent = await send(service, ana, { ...link(url), topic });
      await records.update(sent.id, (one) => ({
        ...one,
        state: 'mapped',
        document: { id: 'raw/a.md', title: 'A' },
      }));
      return sent.id;
    };
    const gone = await done('https://a.example/1');
    const elsewhere = await done('https://a.example/2', 'hermetismo/sub');
    const waiting = await send(service, ana, link('https://a.example/3'));
    expect(await service.clearReady(beto)).toBe(0);
    expect(await service.clearReady(ana, 'hermetismo')).toBe(1);
    const left = (await itemsOf(service, ana)).map((one) => one.id);
    expect(left.sort()).toEqual([elsewhere, waiting.id].sort());
    expect(records.get(gone)?.dismissed).toBe(true);
  });
});
