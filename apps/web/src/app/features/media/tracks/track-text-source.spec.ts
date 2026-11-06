import type {
  MediaPreparation,
  MediaTranscription,
  PreparationStage,
  StageState,
} from '@kb-chat/contracts';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { aMediaItem, aTranscription } from '../../../testing/media-fixtures.js';
import {
  TrackTextSource,
  finishedRounds,
  itemTarget,
  preparationTarget,
  type TextTarget,
} from './track-text-source.js';

const transcribed = (
  version: number | null,
  status: MediaTranscription['status'] = 'done',
) => aMediaItem({ transcription: aTranscription({ status, version }) });

const withStage = (state: StageState | null): MediaPreparation =>
  ({
    stages:
      state === null
        ? []
        : [{ stage: 'transcribe', state } as unknown as PreparationStage],
  }) as unknown as MediaPreparation;

describe('itemTarget (step 3)', () => {
  it('reads the current version, even with a newer attempt going on', () => {
    expect(itemTarget(transcribed(2))).toMatchObject({
      status: 'done',
      key: '2',
    });
  });

  it.each([
    ['waiting', 'waiting'],
    ['transcribing', 'waiting'],
    ['failed', 'failed'],
    ['none', 'none'],
  ] as const)('says %s without a transcript as %s (AC-9)', (status, said) => {
    const item = aMediaItem({
      transcription: aTranscription({ status, version: null }),
    });
    expect(itemTarget(item).status).toBe(said);
  });
});

describe('preparationTarget (step 2)', () => {
  it('waits while the transcription runs, and reads once it ends (AC-9)', () => {
    const item = aMediaItem({
      transcription: aTranscription({ status: 'transcribing', version: null }),
    });
    expect(preparationTarget(item, withStage('running'), 0).status).toBe(
      'waiting',
    );
    expect(preparationTarget(item, withStage('queued'), 0).status).toBe(
      'waiting',
    );
    expect(preparationTarget(item, withStage('failed'), 0).status).toBe(
      'failed',
    );
    expect(preparationTarget(item, withStage('done'), 1).status).toBe('done');
  });

  it('keeps the same key through a newer transcription’s states, and changes it once it ends (AC-12)', () => {
    const item = transcribed(1);
    const keys = (['queued', 'running', 'failed'] as const).map(
      (state) => preparationTarget(item, withStage(state), 0).key,
    );
    const done = preparationTarget(item, withStage('done'), 1);
    expect(new Set(keys)).toEqual(new Set(['1']));
    expect(preparationTarget(item, withStage('done'), 0).key).toBe('1');
    expect(done.status).toBe('done');
    expect(done.key).not.toBe('1');
  });

  it('follows the item without a transcription stage (an audio not transcribed)', () => {
    expect(preparationTarget(transcribed(null, 'none'), null, 0)).toMatchObject(
      { status: 'none' },
    );
    expect(preparationTarget(transcribed(3), withStage(null), 0)).toMatchObject(
      { status: 'done', key: '3' },
    );
  });
});

describe('finishedRounds', () => {
  it('counts a transcription that ends while the page is open, not one already done', () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const state = signal<StageState | null>(null);
    const rounds = TestBed.runInInjectionContext(() => finishedRounds(state));
    const seen = (next: StageState | null) => {
      state.set(next);
      return rounds();
    };
    expect(rounds()).toBe(0);
    expect(seen('done')).toBe(0);
    expect(seen('queued')).toBe(0);
    expect(seen('running')).toBe(0);
    expect(seen('done')).toBe(1);
    expect(seen('done')).toBe(1);
    expect(seen('running')).toBe(1);
    expect(seen('done')).toBe(2);
  });
});

describe('TrackTextSource', () => {
  const MEDIA = '11111111-1111-4111-8111-111111111111';
  let http: HttpTestingController | null = null;

  afterEach(() => {
    http?.verify();
    http = null;
  });

  it('reads once for targets equal in value, as each read of the preparation brings (FR-3)', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        TrackTextSource,
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const source = TestBed.inject(TrackTextSource);
    const target = signal<TextTarget | null>({
      mediaId: MEDIA,
      status: 'done',
      key: '1',
    });
    source.follow(target);
    source.open();
    TestBed.tick();
    http.expectOne(`/api/v1/media/${MEDIA}/transcript?v=1`).flush({
      mediaId: MEDIA,
      version: 1,
      confidence: 'normal',
      segments: [],
    });
    await TestBed.inject(ApplicationRef).whenStable();
    expect(source.state()).toBe('ready');
    target.set({ mediaId: MEDIA, status: 'done', key: '1' });
    TestBed.tick();
    http.expectNone(() => true);
    expect(source.state()).toBe('ready');
  });
});
