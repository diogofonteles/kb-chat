import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  Router,
  convertToParamMap,
  provideRouter,
  type ParamMap,
} from '@angular/router';
import type { MediaItem, TrackEditView } from '@kb-chat/contracts';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aMediaItem, sessionAs } from '../../../testing/media-fixtures.js';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { TrackActions } from './track-actions.js';

const ITEM = aMediaItem();
const VIEW_URL = `/api/v1/media/${ITEM.id}/track-edit`;
const POLL_MS = 10;

const view = (over: Partial<TrackEditView> = {}): TrackEditView => ({
  mediaId: ITEM.id,
  recordingId: '22222222-2222-4222-8222-222222222222',
  recordingTitle: 'Gravação',
  topic: 'hermetismo',
  version: 3,
  title: 'A faixa',
  summary: null,
  ordinal: 1,
  startMs: 0,
  endMs: 60_000,
  recordingDurationMs: 600_000,
  asker: { voice: null, speakerId: null, name: null },
  answerer: { voice: null, speakerId: null, name: null },
  cut: 'none',
  locked: false,
  tracks: [],
  ...over,
});

describe('TrackActions (KBC-073)', () => {
  let http: HttpTestingController;
  let query: BehaviorSubject<ParamMap>;

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function close() {
      this.removeAttribute('open');
    };
    query = new BehaviorSubject(convertToParamMap({}));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: MEDIA_POLL_MS, useValue: POLL_MS },
        { provide: ActivatedRoute, useValue: { queryParamMap: query } },
        sessionAs({ features: ['media', 'media-edit'] }),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  async function open(track = view()) {
    const fixture = TestBed.createComponent(TrackActions);
    const changes: (MediaItem | null)[] = [];
    fixture.componentInstance.changed.subscribe((one) => changes.push(one));
    fixture.componentRef.setInput('media', ITEM);
    TestBed.tick();
    http.expectOne(VIEW_URL).flush(track);
    TestBed.tick();
    await flushDialogReads();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return { fixture, root, changes };
  }

  /** The speakers of a dialog that opened: the form works without them. */
  async function flushDialogReads() {
    await Promise.resolve();
    TestBed.tick();
    http
      .match(({ url }) => url.endsWith('/speakers'))
      .forEach((read) => read.flush({ items: [] }));
  }

  const dialogOf = (root: HTMLElement, name: string) =>
    [...root.querySelectorAll('dialog')].find((one) =>
      one.querySelector('h2')?.textContent?.includes(name),
    );

  it('`?acao=editar` opens the dialog once and leaves the address', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    query.next(convertToParamMap({ acao: 'editar' }));

    const { fixture, root } = await open();

    expect(dialogOf(root, 'Editar faixa')).toBeDefined();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]?.[1]?.queryParams).toEqual({ acao: null });

    query.next(convertToParamMap({}));
    TestBed.tick();
    await fixture.whenStable();
    expect(dialogOf(root, 'Editar faixa')).toBeDefined();
  });

  it('a closed dialog does not come back with the next reading', async () => {
    query.next(convertToParamMap({ acao: 'editar' }));
    const { fixture, root } = await open();
    query.next(convertToParamMap({}));
    TestBed.tick();
    const cancel = [...root.querySelectorAll('button')].find(
      (one) => one.textContent?.trim() === 'Cancelar',
    );
    cancel?.click();
    dialogOf(root, 'Editar faixa')?.dispatchEvent(new Event('close'));
    await fixture.whenStable();
    expect(dialogOf(root, 'Editar faixa')).toBeUndefined();
  });

  it('`?acao=apagar` waits for the track, and a locked one opens nothing', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    query.next(convertToParamMap({ acao: 'apagar' }));

    const { root } = await open(view({ locked: true }));

    expect(root.querySelector('dialog')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says "Pronto" and asks to read the item again, once, when a cut lands', async () => {
    const { root, changes } = await open(view({ cut: 'running' }));
    expect(root.textContent).toContain('Recortando…');

    await vi.waitFor(() => {
      TestBed.tick();
      http.expectOne(VIEW_URL).flush(view({ cut: 'none', version: 4 }));
    });

    await vi.waitFor(() => {
      TestBed.tick();
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        'Pronto',
      );
    });
    expect(changes).toEqual([null]);
  });

  it('a track read with no cut says nothing', async () => {
    const { root, changes } = await open();

    expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
    expect(changes).toEqual([]);
  });
});
