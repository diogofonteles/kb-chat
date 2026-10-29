import { TestBed } from '@angular/core/testing';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';
import {
  MEDIA_SESSION,
  MediaSessionAdapter,
  type SessionLike,
} from './media-session.js';

type Handler = (details: MediaSessionActionDetails) => void;

/** navigator.mediaSession as the test sees it. */
function fakeSession() {
  const handlers = new Map<MediaSessionAction, Handler | null>();
  const session: SessionLike & {
    handlers: typeof handlers;
    positions: MediaPositionState[];
  } = {
    metadata: null,
    playbackState: 'none',
    handlers,
    positions: [],
    setActionHandler: (action, handler) => handlers.set(action, handler),
    setPositionState: (state) => {
      if (state) session.positions.push(state);
    },
  };
  return session;
}

const SOURCE = {
  id: 'm1',
  title: 'Palestra de 1998',
  src: '/m1',
  artist: 'Mestre Laércio',
  durationMs: 600_000,
};

function setup() {
  const media: FakeMedia = fakeMediaElement();
  const session = fakeSession();
  TestBed.configureTestingModule({
    providers: [
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: MEDIA_SESSION, useValue: session },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  TestBed.inject(MediaSessionAdapter);
  const ready = () => {
    engine.load(SOURCE);
    media.setDuration(600);
    media.emit('loadedmetadata');
    TestBed.tick();
  };
  const act = (action: MediaSessionAction, details = {}) =>
    session.handlers.get(action)?.({ action, ...details });
  return { engine, media, session, ready, act };
}

describe('MediaSessionAdapter (KBC-041 FR-7)', () => {
  it('shows the title, the authorship and the app icons on the system', () => {
    const { session, ready } = setup();
    ready();
    expect(session.metadata?.title).toBe('Palestra de 1998');
    expect(session.metadata?.artist).toBe('Mestre Laércio — Nova Alexandria');
    expect(session.metadata?.artwork?.map((art) => art.sizes)).toEqual([
      '96x96',
      '128x128',
      '192x192',
      '256x256',
      '384x384',
      '512x512',
    ]);
  });

  it('plays, pauses and skips from the lock screen and the headphones', () => {
    const { session, media, ready, act } = setup();
    ready();
    act('play');
    expect(media.calls.at(-1)).toBe('play');
    act('pause');
    expect(media.calls.at(-1)).toBe('pause');
    act('seekforward');
    expect(media.calls.at(-1)).toBe('seek:30');
    act('seekbackward');
    expect(media.calls.at(-1)).toBe('seek:15');
    act('seekforward', { seekOffset: 10 });
    expect(media.calls.at(-1)).toBe('seek:25');
    act('seekto', { seekTime: 600 });
    expect(media.calls.at(-1)).toBe('seek:600');
    act('stop');
    expect(media.calls.at(-1)).toBe('pause');
    expect(session.handlers.get('nexttrack')).toBeUndefined();
  });

  it('lets the system ask for a fast seek where the browser has one', () => {
    const { media, ready, act } = setup();
    ready();
    const fastSeek = vi.fn();
    media.element.fastSeek = fastSeek;
    act('seekto', { seekTime: 120, fastSeek: true });
    expect(fastSeek).toHaveBeenCalledWith(120);
  });

  it('tells the system the position, the speed and the length (AC-9)', () => {
    const { session, engine, media, ready, act } = setup();
    ready();
    expect(session.positions.at(-1)).toEqual({
      duration: 600,
      playbackRate: 1,
      position: 0,
    });
    act('seekto', { seekTime: 600 });
    media.emit('seeked');
    engine.setSpeed(1.5);
    TestBed.tick();
    expect(session.positions.at(-1)).toEqual({
      duration: 600,
      playbackRate: 1.5,
      position: 600,
    });
  });

  it('tells the new position after a seek alone, with no other change', () => {
    const { session, media, ready, act } = setup();
    ready();
    act('seekforward');
    media.emit('seeked');
    TestBed.tick();
    expect(session.positions.at(-1)?.position).toBe(30);
  });

  it('follows playing and paused, and clears everything when the player closes', () => {
    const { session, engine, media, ready } = setup();
    ready();
    engine.play();
    media.emit('playing');
    TestBed.tick();
    expect(session.playbackState).toBe('playing');
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    expect(session.playbackState).toBe('paused');
    engine.unload();
    TestBed.tick();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
    expect(session.handlers.get('play')).toBeNull();
  });

  it('does nothing in a browser without Media Session', () => {
    const media = fakeMediaElement();
    TestBed.configureTestingModule({
      providers: [
        { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
        { provide: MEDIA_SESSION, useValue: null },
      ],
    });
    TestBed.inject(MediaSessionAdapter);
    TestBed.inject(MediaEngine).load(SOURCE);
    expect(() => TestBed.tick()).not.toThrow();
  });
});
