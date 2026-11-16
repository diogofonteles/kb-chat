import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { screen } from '@testing-library/angular';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import {
  aMediaItem,
  aTranscription,
  mediaId,
} from '../../../testing/media-fixtures.js';
import { NowPlayingPanel, linesAt } from './now-playing-panel.js';

const ITEM = aMediaItem({
  transcription: aTranscription({ status: 'done', version: 1 }),
});
const SEGMENTS = [
  { startMs: 0, endMs: 5_000, text: ' Mestre, o senhor está lembrado?' },
  { startMs: 5_000, endMs: 15_000, text: ' Eu lembro sim.' },
  { startMs: 15_000, endMs: 22_000, text: ' E como foi que chegou lá?' },
];

/** The resources answer after a macrotask; then their dependants ask. */
async function settle(): Promise<void> {
  await new Promise((done) => setTimeout(done));
  TestBed.tick();
}

async function setup(atSeconds = 7) {
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  engine.load({ id: ITEM.id, title: ITEM.title, src: '/s' });
  media.setDuration(60);
  media.emit('loadedmetadata');
  engine.play();
  media.emit('playing');
  media.setCurrentTime(atSeconds);
  media.emit('timeupdate');
  const fixture = TestBed.createComponent(NowPlayingPanel);
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  http.expectOne(`/api/v1/media/${ITEM.id}`).flush(ITEM);
  await settle();
  http
    .expectOne((request) =>
      request.url.startsWith(`/api/v1/media/${ITEM.id}/transcript`),
    )
    .flush({
      mediaId: ITEM.id,
      version: 1,
      revision: 0,
      confidence: 'normal',
      segments: SEGMENTS,
    });
  http.expectOne('/api/v1/topics/hermetismo/media').flush({
    items: [
      ITEM,
      aMediaItem({ id: mediaId(2) }),
      aMediaItem({ id: mediaId(3), author: null }),
    ],
  });
  await fixture.whenStable();
  return { fixture, http, media };
}

describe('NowPlayingPanel (KBC-129 FR-2, BR-4)', () => {
  it('shows what plays, the line heard now after the one before, and the author', async () => {
    const { http } = await setup();
    expect(screen.getByRole('heading', { name: 'Tocando agora' })).toBeTruthy();
    expect(
      screen
        .getAllByRole('link', { name: 'Palestra de 1998' })[0]
        ?.getAttribute('href'),
    ).toBe(`/midia/${ITEM.id}`);
    expect(screen.getByText('Eu lembro sim.')).toBeTruthy();
    expect(screen.getByText('Mestre, o senhor está lembrado?')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Sobre a autora' }),
    ).toBeTruthy();
    expect(screen.getByText('2 áudios neste acervo')).toBeTruthy();
    http.verify();
  });

  it('AC-4: offers no "Seguir" and no share, which do not exist yet', async () => {
    await setup();
    expect(screen.queryByRole('button', { name: /Seguir/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Compartilhar/ })).toBeNull();
  });
});

describe('linesAt', () => {
  it('reads the segment heard at a time and the one before it', () => {
    expect(linesAt(SEGMENTS, 16_000)).toEqual({
      before: 'Eu lembro sim.',
      now: 'E como foi que chegou lá?',
    });
  });

  it('is empty before the first segment and skips a restricted one', () => {
    expect(linesAt([], 1_000)).toEqual({ before: '', now: '' });
    expect(
      linesAt(
        [
          {
            startMs: 0,
            endMs: 5_000,
            text: ' Mestre, o senhor está lembrado?',
          },
          { startMs: 5_000, endMs: 15_000, text: '', restricted: true },
        ],
        6_000,
      ),
    ).toEqual({ before: '', now: 'Mestre, o senhor está lembrado?' });
  });
});
