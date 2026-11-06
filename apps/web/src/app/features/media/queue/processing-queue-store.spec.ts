import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionAs } from '../../../testing/media-fixtures.js';
import { aQueue, aQueueItem } from '../../../testing/preparation-fixtures.js';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { ProcessingQueueStore } from './processing-queue-store.js';

const URL = '/api/v1/media/processing';
const wait = (ms = 12) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(
  features: ('media' | 'media-upload')[] = ['media', 'media-upload'],
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_POLL_MS, useValue: 4 },
      sessionAs({ features }),
    ],
  });
  const store = TestBed.inject(ProcessingQueueStore);
  TestBed.tick();
  return { store, http: TestBed.inject(HttpTestingController) };
}

const hide = (state: DocumentVisibilityState) =>
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);

async function answer(http: HttpTestingController, body: object) {
  await wait();
  const reads = http.match(URL);
  reads.forEach((one) => one.flush(body));
  return reads.length;
}

describe('ProcessingQueueStore (KBC-090)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads once and stops when nothing is at work', async () => {
    const { store, http } = setup();
    expect(await answer(http, aQueue())).toBe(1);
    expect(store.active()).toBe(0);
    expect(await answer(http, aQueue())).toBe(0);
  });

  it('keeps reading while anything is at work, until it ends', async () => {
    const { store, http } = setup();
    await answer(http, aQueue({ items: [aQueueItem()], active: 1 }));
    expect(store.active()).toBe(1);
    expect(store.items()).toHaveLength(1);
    expect(await answer(http, aQueue())).toBe(1);
    expect(store.active()).toBe(0);
    expect(await answer(http, aQueue())).toBe(0);
  });

  it('stops with the tab hidden, and reads on coming back', async () => {
    const { http } = setup();
    const visibility = hide('hidden');
    await answer(http, aQueue({ items: [aQueueItem()], active: 1 }));
    expect(await answer(http, aQueue())).toBe(0);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await answer(http, aQueue())).toBe(1);
  });

  it('asks nothing of who cannot send media', async () => {
    const { store, http } = setup(['media']);
    expect(await answer(http, aQueue())).toBe(0);
    store.refresh();
    expect(await answer(http, aQueue())).toBe(0);
  });

  it('keeps what it had when a read fails, and keeps trying', async () => {
    const { store, http } = setup();
    await answer(http, aQueue({ items: [aQueueItem()], active: 1 }));
    await wait();
    http
      .match(URL)
      .forEach((one) => one.flush('', { status: 500, statusText: 'x' }));
    expect(store.failed()).toBe(true);
    expect(store.items()).toHaveLength(1);
    expect(await answer(http, aQueue())).toBe(1);
    expect(store.failed()).toBe(false);
  });

  it('tries again after a failed read with nothing at work', async () => {
    const { store, http } = setup();
    await answer(http, aQueue());
    store.refresh();
    await wait();
    http
      .match(URL)
      .forEach((one) => one.flush('', { status: 500, statusText: 'x' }));
    expect(store.failed()).toBe(true);
    expect(await answer(http, aQueue())).toBe(1);
    expect(store.failed()).toBe(false);
    expect(await answer(http, aQueue())).toBe(0);
  });

  it('says what moved, and nothing on the first read', async () => {
    const { store, http } = setup();
    await answer(http, aQueue({ items: [aQueueItem()], active: 1 }));
    expect(store.said()).toBe('');
    await answer(http, aQueue());
    expect(store.said()).toBe('Palestra de 1998 saiu da fila.');
  });

  it('forgets everything when the API refuses', async () => {
    const { store, http } = setup();
    await answer(http, aQueue({ items: [aQueueItem()], active: 1 }));
    await wait();
    http
      .match(URL)
      .forEach((one) => one.flush('', { status: 403, statusText: 'x' }));
    expect(store.items()).toEqual([]);
    expect(await answer(http, aQueue())).toBe(0);
  });

  it('ignores an older answer once a newer read was asked', async () => {
    const { store, http } = setup();
    await wait();
    const [older] = http.match(URL);
    store.refresh();
    await wait();
    const [newer] = http.match(URL);
    expect(older?.cancelled).toBe(true);
    newer?.flush(aQueue({ items: [aQueueItem()], active: 1 }));
    expect(store.items()).toHaveLength(1);
  });
});
