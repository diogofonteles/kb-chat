import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { DraftTrack, MediaEdit } from '@kb-chat/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_DELAY_MS, TrackDraft } from './track-draft.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const URL = `/api/v1/media/${MEDIA}/edit`;

const track = (n: number, startMs: number, endMs: number): DraftTrack => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  runId: null,
  source: 'manual',
  edited: false,
  firstSegment: null,
  lastSegment: null,
  startMs,
  endMs,
  kind: 'qa',
  title: `Faixa ${n}`,
  askerVoice: null,
  answererVoice: null,
  askerSpeakerId: null,
  answererSpeakerId: null,
});

const edit = (tracks: DraftTrack[], version = 4): MediaEdit => ({
  mediaId: MEDIA,
  version,
  started: true,
  status: 'draft',
  step: 3,
  tracks,
  run: null,
  voices: [],
  approvedTracks: 0,
  transcriptChanged: false,
});

describe('TrackDraft (KBC-066)', () => {
  let draft: TrackDraft;
  let http: HttpTestingController;
  const one = track(1, 0, 10_000);
  const two = track(2, 10_000, 20_000);

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        TrackDraft,
      ],
    });
    draft = TestBed.inject(TrackDraft);
    http = TestBed.inject(HttpTestingController);
    draft.load(edit([one, two]), 60_000);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('saves within a second of the last change, with the version it read (BR-6)', () => {
    draft.apply([one]);
    draft.apply([two]);
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1);
    http.expectNone(URL);
    vi.advanceTimersByTime(1);
    const save = http.expectOne(URL);
    expect(save.request.headers.get('If-Match')).toBe('"4"');
    expect(save.request.body.tracks.map((t: DraftTrack) => t.id)).toEqual([
      two.id,
    ]);
    save.flush({ version: 5 });
    expect(draft.save()).toBe('saved');
    expect(draft.announcement()).toBe('Rascunho salvo');
  });

  it('undoes and redoes, saving each state (AC-9)', () => {
    draft.apply([two]);
    draft.undo();
    expect(draft.tracks()).toEqual([one, two]);
    expect(draft.canRedo()).toBe(true);
    draft.redo();
    expect(draft.tracks()).toEqual([two]);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    http.expectOne(URL).flush({ version: 5 });
  });

  it('never has two saves at once; the newest state goes next', () => {
    draft.apply([one]);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    const first = http.expectOne(URL);
    draft.apply([two]);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    http.expectNone(URL);
    first.flush({ version: 5 });
    const second = http.expectOne(URL);
    expect(second.request.headers.get('If-Match')).toBe('"5"');
    expect(second.request.body.tracks).toHaveLength(1);
    second.flush({ version: 6 });
  });

  it('stops on a conflict and keeps the person`s tracks (FR-10)', () => {
    draft.apply([one]);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    http
      .expectOne(URL)
      .flush({}, { status: 412, statusText: 'Precondition Failed' });
    expect(draft.save()).toBe('conflict');
    expect(draft.tracks()).toEqual([one]);
    draft.apply([two]);
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    http.expectNone(URL);
  });

  it('waits without a network and sends when it comes back', () => {
    draft.apply([one]);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    http.expectOne(URL).error(new ProgressEvent('error'));
    expect(draft.save()).toBe('offline');
    window.dispatchEvent(new Event('online'));
    http.expectOne(URL).flush({ version: 5 });
    expect(draft.save()).toBe('saved');
  });

  it('runs what waited for the save once it is done', () => {
    const done = vi.fn();
    draft.apply([one]);
    draft.flush(done);
    expect(done).not.toHaveBeenCalled();
    http.expectOne(URL).flush({ version: 5 });
    expect(done).toHaveBeenCalledOnce();
  });

  it('lists the problems an approval would refuse', () => {
    draft.apply([{ ...one, title: null }, two]);
    expect(draft.problems()).toEqual([
      { trackId: one.id, ordinal: 1, problem: 'title' },
    ]);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    http.expectOne(URL).flush({ version: 5 });
  });
});
