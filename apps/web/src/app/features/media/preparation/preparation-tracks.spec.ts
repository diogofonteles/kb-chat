import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  computed,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { PreparationTrack } from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditionRange } from '../tracks/track-audition.js';
import { TrackAudition } from '../tracks/track-audition.js';
import { TrackTextSource } from '../tracks/track-text-source.js';
import { PreparationTracks } from './preparation-tracks.js';
import { PreparationWatch } from './preparation-watch.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const BASE = `/api/v1/media/${MEDIA}/transcript`;

const track = (n: number, startMs: number, endMs: number): PreparationTrack =>
  ({
    id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`,
    title: `Pergunta ${n}`,
    startMs,
    endMs,
    asker: null,
    answerer: null,
    status: 'proposed',
  }) as PreparationTrack;

const TRACKS = [
  track(1, 0, 30_000),
  track(2, 30_000, 70_000),
  track(3, 70_000, 90_000),
];

const TRANSCRIPT = {
  mediaId: MEDIA,
  version: 1,
  confidence: 'normal',
  segments: [
    { startMs: 10_000, endMs: 11_000, text: 'a primeira faixa' },
    { startMs: 40_000, endMs: 41_500, text: 'o que está em cima' },
    { startMs: 75_000, endMs: 76_000, text: 'a terceira faixa' },
  ],
};

let http: HttpTestingController | null = null;

function fakeAudition() {
  const position = signal<number | null>(null);
  return {
    positionMs: position.asReadonly(),
    playing: computed(() => position() !== null),
    playingKey: signal(null),
    failed: signal(false),
    play: vi.fn((range: AuditionRange) => position.set(range.fromMs)),
    stop: vi.fn(() => position.set(null)),
  };
}

async function setup() {
  const audition = fakeAudition();
  const view = await render(PreparationTracks, {
    inputs: { tracks: TRACKS },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      TrackTextSource,
      { provide: TrackAudition, useValue: audition },
      {
        provide: PreparationWatch,
        useValue: {
          fresh: signal(new Set()),
          unseen: signal(0),
          markSeen: () => undefined,
        },
      },
    ],
  });
  TestBed.inject(TrackTextSource).follow(
    signal({ mediaId: MEDIA, status: 'done', key: '1' }),
  );
  http = TestBed.inject(HttpTestingController);
  return { view, audition, http };
}

/** Lets a click render, and answers the transcript when it is asked for. */
async function settle(view: Awaited<ReturnType<typeof setup>>['view']) {
  TestBed.tick();
  http
    ?.match((one) => one.url === BASE)
    .forEach((one) => one.flush(TRANSCRIPT));
  await view.fixture.whenStable();
  http
    ?.match((one) => one.url === `${BASE}/words`)
    .forEach((one) => one.flush({ mediaId: MEDIA, version: 1, words: [] }));
  await view.fixture.whenStable();
}

const textButton = (ordinal: number) =>
  screen.getByRole('button', {
    name: new RegExp(`texto da faixa ${ordinal}$`),
  });

const regions = () =>
  screen.queryAllByRole('region', { name: /^Texto da faixa/ });

afterEach(() => {
  http?.verify();
  http = null;
});

describe('PreparationTracks: the track text (KBC-092)', () => {
  it('reads nothing until a text opens', async () => {
    await setup();
    TestBed.tick();
    expect(http?.match(() => true)).toHaveLength(0);
  });

  it('opens a track text with "Ver texto", pointing to it (AC-1, AC-15)', async () => {
    const { view } = await setup();
    const button = textButton(2);
    expect(button.textContent).toContain('Ver texto');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    await settle(view);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain('Esconder texto');
    const [region] = regions();
    expect(region?.getAttribute('aria-label')).toBe('Texto da faixa 2');
    expect(button.getAttribute('aria-controls')).toBe(region?.id);
    expect(region?.textContent).toContain('o que está em cima');
    expect(region?.textContent).not.toContain('a primeira faixa');
  });

  it('"Ouvir" plays the track and opens its text (AC-2)', async () => {
    const { view, audition } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ouvir a faixa 2' }));
    await settle(view);
    expect(audition.play).toHaveBeenCalledWith({
      fromMs: 30_000,
      toMs: 70_000,
    });
    expect(regions().map((one) => one.getAttribute('aria-label'))).toEqual([
      'Texto da faixa 2',
    ]);
  });

  it('keeps one text open at a time; closing it keeps playing (AC-3, BR-5)', async () => {
    const { view, audition } = await setup();
    fireEvent.click(textButton(1));
    await settle(view);
    fireEvent.click(textButton(3));
    await settle(view);
    expect(regions().map((one) => one.getAttribute('aria-label'))).toEqual([
      'Texto da faixa 3',
    ]);
    expect(textButton(1).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Ouvir a faixa 3' }));
    await settle(view);
    fireEvent.click(textButton(3));
    await settle(view);
    expect(regions()).toHaveLength(0);
    expect(audition.stop).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Parar a faixa 3' }),
    ).toBeTruthy();
  });

  it('reads the transcript once for every text of the page (FR-3)', async () => {
    const { view } = await setup();
    fireEvent.click(textButton(1));
    await settle(view);
    fireEvent.click(textButton(2));
    TestBed.tick();
    expect(http?.match((one) => one.url === BASE)).toHaveLength(0);
    await settle(view);
  });
});
