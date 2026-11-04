import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ApprovedTrack } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { aMediaItem, sessionAs } from '../../testing/media-fixtures.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';
import { TracksStore } from './tracks-store.js';

const ID = aMediaItem().id;
const track = (ordinal: number, startMs: number): ApprovedTrack => ({
  id: `00000000-0000-4000-8000-00000000000${ordinal}`,
  ordinal,
  startMs,
  endMs: startMs + 10_000,
  kind: 'qa',
  title: `Faixa ${ordinal}`,
});
const TRACKS = [track(1, 0), track(2, 20_000)];

function setup(features: Parameters<typeof sessionAs>[0]) {
  const media: FakeMedia = fakeMediaElement('audio');
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      sessionAs(features),
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  engine.load({ id: ID, title: 'P', src: 'x', durationMs: 60_000, artist: 'A' });
  media.setDuration(60);
  media.emit('loadedmetadata');
  return {
    media,
    engine,
    store: TestBed.inject(TracksStore),
    http: TestBed.inject(HttpTestingController),
  };
}

describe('TracksStore (KBC-066 FR-9)', () => {
  it('asks nothing without `media-tracks` (AC-13)', () => {
    const { store, http } = setup({ features: ['media'] });
    store.load(ID).subscribe();
    http.expectNone(`/api/v1/media/${ID}/tracks`);
    expect(store.tracks()).toEqual([]);
  });

  it('knows the track playing and steps to the next and the previous', () => {
    const { store, http, media } = setup({
      features: ['media', 'media-tracks'],
    });
    store.load(ID).subscribe();
    http.expectOne(`/api/v1/media/${ID}/tracks`).flush({ tracks: TRACKS });
    expect(store.current()?.ordinal).toBe(1);
    expect(store.hasPrevious()).toBe(false);
    expect(store.hasNext()).toBe(true);
    expect(store.step(1)).toBe(true);
    media.setCurrentTime(20);
    media.emit('timeupdate');
    expect(store.current()?.ordinal).toBe(2);
    expect(store.step(1)).toBe(false);
  });

  it('leaves the player without tracks when they cannot be read', () => {
    const { store, http } = setup({ features: ['media', 'media-tracks'] });
    store.load(ID).subscribe();
    http
      .expectOne(`/api/v1/media/${ID}/tracks`)
      .flush({}, { status: 500, statusText: 'Server Error' });
    expect(store.tracks()).toEqual([]);
  });
});
