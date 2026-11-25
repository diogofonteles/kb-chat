import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  CreateDocumentUploadRequest,
  CreateDocumentUploadResponse,
  DocumentUpload,
} from '@kb-chat/contracts';
import { BusyWork } from '@core/app-version/busy-work.js';
import { MediaApi } from '@core/media/media-api.js';
import { unreadableFile } from '@features/media/upload-rules.js';
import {
  DocumentUploadsApi,
  type SendEvent,
} from '@core/documents/document-uploads-api.js';
import { Subject, defer, of, throwError, type Observable } from 'rxjs';
import { ContentSender, type ContentTarget } from './content-sender.js';

const TARGET: ContentTarget = {
  topic: 'hermetismo',
  level: null,
  batch: { id: '99999999-9999-4999-8999-999999999999', capUsd: 0.5 },
};

const anUpload = (fields: Partial<DocumentUpload> = {}): DocumentUpload => ({
  id: crypto.randomUUID(),
  topic: 'hermetismo',
  kind: 'url',
  name: 'https://example.org/a',
  state: 'received',
  failure: null,
  detail: null,
  document: null,
  mediaId: null,
  bytes: null,
  received: null,
  uploadUrl: null,
  review: false,
  batch: null,
  heldBy: null,
  retriable: false,
  progress: {
    startedAt: null,
    position: null,
    startsInSeconds: null,
    takesSeconds: null,
    media: null,
  },
  entryCount: 0,
  mine: true,
  refused: null,
  createdAt: '2026-11-25T10:00:00.000Z',
  updatedAt: '2026-11-25T10:00:00.000Z',
  ...fields,
});

const created = (
  fields: Partial<DocumentUpload> = {},
): CreateDocumentUploadResponse => ({
  outcome: 'created',
  upload: anUpload(fields),
});

const apiError = (status: number, code: string) =>
  new HttpErrorResponse({
    status,
    error: { error: { code, message: code, requestId: 'r' } },
  });

class FakeApi {
  readonly asked: { topic: string; request: CreateDocumentUploadRequest }[] =
    [];
  answer: (n: number) => Observable<CreateDocumentUploadResponse> = () =>
    of(created());
  readonly bytes = new Subject<SendEvent>();

  create(topic: string, request: CreateDocumentUploadRequest) {
    this.asked.push({ topic, request });
    return this.answer(this.asked.length);
  }

  send(): Observable<SendEvent> {
    return this.bytes;
  }
}

class FakeMedia {
  verdict: object = { verdict: 'new', elsewhere: [] };
  readonly created: object[] = [];
  readonly uploaded: string[] = [];
  readonly bytes = new Subject<object>();

  check() {
    return of(this.verdict);
  }

  readonly updated: object[] = [];

  update(id: string, request: object) {
    this.updated.push({ id, ...request });
    return of({ id });
  }

  create(_topic: string, request: object) {
    this.created.push(request);
    return of({ id: 'media-1' });
  }

  upload(id: string) {
    this.uploaded.push(id);
    return this.bytes;
  }
}

function setup() {
  const api = new FakeApi();
  const media = new FakeMedia();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      ContentSender,
      { provide: DocumentUploadsApi, useValue: api },
      { provide: MediaApi, useValue: media },
    ],
  });
  return { api, media, sender: TestBed.inject(ContentSender) };
}

const link = (url: string) => ({ kind: 'url' as const, url });
const phases = (sender: ContentSender) =>
  sender.sends().map((one) => one.phase.kind);

describe('ContentSender (KBC-184)', () => {
  it('sends the links one after the other, with the inclusion they belong to', () => {
    const { api, sender } = setup();
    sender.add([link('https://example.org/1'), link('https://example.org/2')], {
      ...TARGET,
      level: 'qs',
    });
    expect(phases(sender)).toEqual(['sent', 'sent']);
    expect(sender.summary()).toEqual({
      total: 2,
      active: 0,
      sent: 2,
      already: 0,
      failed: 0,
      givenUp: 0,
    });
    expect(sender.busy()).toBe(false);
    expect(api.asked[0]).toEqual({
      topic: 'hermetismo',
      request: {
        kind: 'url',
        url: 'https://example.org/1',
        level: 'qs',
        batch: TARGET.batch,
      },
    });
  });

  it('a link says what the search found it to be; without it the address decides', () => {
    const { api, sender } = setup();
    const url = 'https://example.org/podcast';
    sender.add([{ kind: 'url', url, as: 'recording' }, link(url)], TARGET);
    expect(api.asked.map(({ request }) => 'as' in request)).toEqual([
      true,
      false,
    ]);
    expect(api.asked[0]?.request).toMatchObject({ as: 'recording' });
  });

  it('one that fails says why, never stops the next ones, and goes again when asked', () => {
    const { api, sender } = setup();
    api.answer = (n) =>
      n === 1
        ? throwError(() => apiError(404, 'TOPIC_NOT_FOUND'))
        : of(created());
    sender.add(
      [link('https://example.org/1'), link('https://example.org/2')],
      TARGET,
    );
    expect(phases(sender)).toEqual(['error', 'sent']);
    const [failed] = sender.sends();
    sender.retry(failed?.key ?? 0);
    expect(phases(sender)).toEqual(['sent', 'sent']);
  });

  it.each([
    ['the limit per minute', apiError(429, 'RATE_LIMITED')],
    ['no network', new HttpErrorResponse({ status: 0 })],
  ])('waits %s out instead of failing', (_what, passing) => {
    vi.useFakeTimers();
    try {
      const { api, sender } = setup();
      let tries = 0;
      api.answer = () =>
        defer(() => {
          tries += 1;
          return tries === 1 ? throwError(() => passing) : of(created());
        });
      sender.add([link('https://example.org/1')], TARGET);
      expect(phases(sender)).toEqual(['paused']);
      expect(sender.busy()).toBe(true);
      expect(sender.busy()).toBe(true);
      vi.advanceTimersByTime(15_000);
      expect(phases(sender)).toEqual(['sent']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a file whose send stopped half-way goes on, instead of "a caminho"', async () => {
    const { api, sender } = setup();
    // The API resumes the person's own announcement: the same item, with bytes already there.
    api.answer = () =>
      of(
        created({
          state: 'receiving',
          received: 2,
          uploadUrl: '/api/v1/document-uploads/x/upload',
        }),
      );
    const file = new File(['%PDF'], 'a.pdf');
    sender.add([{ kind: 'file', file, path: 'a.pdf' }], TARGET);
    await vi.waitFor(() => expect(phases(sender)).toEqual(['sending']));
    api.bytes.next({ kind: 'done' });
    expect(phases(sender)).toEqual(['sent']);
  });

  it('an audio goes to the library, with its level; one stopped goes on; one there is said', async () => {
    const { media, sender } = setup();
    const audio = (path: string) => ({
      kind: 'audio' as const,
      file: new File(['ID3'], 'aula_01.mp3'),
      path,
    });
    sender.add([audio('Pasta/aula_01.mp3')], { ...TARGET, level: 'qs' });
    await vi.waitFor(() => expect(media.uploaded).toEqual(['media-1']));
    expect(media.created[0]).toMatchObject({
      title: 'aula 01',
      author: null,
      fileName: 'aula_01.mp3',
      bytes: 3,
      level: 'qs',
    });
    media.bytes.next({ kind: 'progress', loaded: 1, total: 4 });
    expect(sender.sends()[0]?.phase).toEqual({ kind: 'sending', percent: 25 });
    media.bytes.next({ kind: 'done', item: {} });
    media.bytes.complete();
    expect(phases(sender)).toEqual(['sent']);
    expect(sender.sends()[0]?.name).toBe('Pasta/aula_01.mp3');
  });

  it.each([
    [{ verdict: 'resume', media: { id: 'media-9' }, offset: 2 }, ['media-9']],
    [{ verdict: 'duplicate', media: { id: 'm', title: 't' } }, []],
    [{ verdict: 'duplicate-hidden' }, []],
  ])(
    'an audio already known (%o) is not created again',
    async (verdict, sent) => {
      const { media, sender } = setup();
      media.verdict = verdict;
      const file = new File(['ID3'], 'a.mp3');
      sender.add([{ kind: 'audio', file, path: 'a.mp3' }], TARGET);
      await vi.waitFor(() =>
        expect(phases(sender)).toEqual([
          sent.length > 0 ? 'sending' : 'duplicate',
        ]),
      );
      expect(media.uploaded).toEqual(sent);
      expect(media.created).toEqual([]);
    },
  );

  it('an audio that stopped half-way goes on at the level chosen now', async () => {
    const { media, sender } = setup();
    media.verdict = { verdict: 'resume', media: { id: 'media-9' }, offset: 2 };
    const file = new File(['ID3'], 'a.mp3');
    sender.add([{ kind: 'audio', file, path: 'a.mp3' }], {
      ...TARGET,
      level: 'ci',
    });
    await vi.waitFor(() => expect(media.uploaded).toEqual(['media-9']));
    expect(media.updated).toEqual([{ id: 'media-9', level: 'ci' }]);
  });

  it('the account always closes, the failed go again together, and what ended well is cleared', () => {
    const { api, sender } = setup();
    api.answer = (n) =>
      n === 1
        ? throwError(() => apiError(404, 'TOPIC_NOT_FOUND'))
        : n === 2
          ? of({
              outcome: 'duplicate' as const,
              document: null,
              upload: null,
            })
          : of(created());
    sender.add(
      [1, 2, 3].map((n) => link(`https://example.org/${n}`)),
      TARGET,
    );
    const { total, active, sent, already, failed } = sender.summary();
    expect({ sent, already, failed }).toEqual({
      sent: 1,
      already: 1,
      failed: 1,
    });
    expect(active + sent + already + failed).toBe(total);
    sender.clearDone();
    expect(phases(sender)).toEqual(['error']);
    sender.retryFailed();
    expect(phases(sender)).toEqual(['sent']);
  });

  it('a paused item taken off the list never goes, and the next does', () => {
    vi.useFakeTimers();
    try {
      const { api, sender } = setup();
      api.answer = (n) =>
        n === 1
          ? throwError(() => new HttpErrorResponse({ status: 0 }))
          : of(created());
      sender.add(
        [link('https://example.org/1'), link('https://example.org/2')],
        TARGET,
      );
      expect(phases(sender)).toEqual(['paused', 'waiting']);
      sender.remove(sender.sends()[0]?.key ?? 0);
      vi.advanceTimersByTime(60_000);
      expect(
        api.asked.map(({ request }) => 'url' in request && request.url),
      ).toEqual(['https://example.org/1', 'https://example.org/2']);
      expect(phases(sender)).toEqual(['sent']);
      expect(sender.busy()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed item taken off the list still counts as not arrived', () => {
    const { api, sender } = setup();
    api.answer = (n) =>
      n === 1
        ? throwError(() => apiError(404, 'TOPIC_NOT_FOUND'))
        : of(created());
    sender.add(
      [link('https://example.org/1'), link('https://example.org/2')],
      TARGET,
    );
    sender.remove(sender.sends()[0]?.key ?? 0);
    expect(sender.summary()).toMatchObject({ total: 1, sent: 1, givenUp: 1 });
    // Another inclusion, once the list is empty, starts the account over.
    sender.clearDone();
    sender.add([link('https://example.org/3')], TARGET);
    expect(sender.summary().givenUp).toBe(0);
  });

  it('a file changed or deleted after it was chosen says so, and the next goes', async () => {
    const { sender } = setup();
    const gone = new File(['x'], 'sumiu.pdf');
    vi.spyOn(gone, 'slice').mockReturnValue({
      arrayBuffer: () =>
        Promise.reject(new DOMException('gone', 'NotReadableError')),
    } as unknown as Blob);
    sender.add(
      [
        { kind: 'file', file: gone, path: 'sumiu.pdf' },
        link('https://example.org/1'),
      ],
      TARGET,
    );
    await vi.waitFor(() => expect(phases(sender)).toEqual(['error', 'sent']));
    const [first] = sender.sends();
    expect(first?.phase).toMatchObject({ message: unreadableFile() });
  });

  it('holds a reload of the app while something is on its way', () => {
    const { api, sender } = setup();
    const waiting = new Subject<CreateDocumentUploadResponse>();
    api.answer = () => waiting;
    const busy = TestBed.inject(BusyWork);
    expect(busy.inProgress()).toBe(false);
    sender.add([link('https://example.org/1')], TARGET);
    expect(busy.inProgress()).toBe(true);
    waiting.next(created());
    waiting.complete();
    expect(busy.inProgress()).toBe(false);
  });

  it('says what is already in the collection, or on its way', () => {
    const { api, sender } = setup();
    const document = { id: 'raw/a.md', title: 'A' };
    api.answer = (n) =>
      of({
        outcome: 'duplicate' as const,
        document: n === 1 ? document : null,
        upload: n === 1 ? null : anUpload(),
      });
    sender.add(
      [link('https://example.org/1'), link('https://example.org/2')],
      TARGET,
    );
    expect(sender.sends().map((one) => one.phase)).toEqual([
      { kind: 'duplicate', document, onItsWay: false },
      { kind: 'duplicate', document: null, onItsWay: true },
    ]);
  });

  it('a file is hashed, announced and sent, with its progress; it cannot leave the list meanwhile', async () => {
    const { api, sender } = setup();
    api.answer = () =>
      of(
        created({
          state: 'receiving',
          uploadUrl: '/api/v1/document-uploads/x/upload',
        }),
      );
    const file = new File(['%PDF'], 'a.pdf');
    sender.add([{ kind: 'file', file, path: 'Pasta/a.pdf' }], TARGET);
    await vi.waitFor(() => expect(phases(sender)).toEqual(['sending']));
    expect(api.asked[0]?.request).toMatchObject({
      kind: 'file',
      name: 'a.pdf',
      bytes: 4,
    });
    api.bytes.next({ kind: 'progress', loaded: 2, total: 4 });
    expect(sender.sends()[0]?.phase).toEqual({ kind: 'sending', percent: 50 });
    const key = sender.sends()[0]?.key ?? 0;
    sender.remove(key);
    expect(sender.sends()).toHaveLength(1);
    api.bytes.next({ kind: 'done' });
    expect(phases(sender)).toEqual(['sent']);
    sender.remove(key);
    expect(sender.sends()).toEqual([]);
  });
});
