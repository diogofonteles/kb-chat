import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
} from '@core/media/media-engine.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { PlayerShortcuts, targetOf } from './player-shortcuts.js';

function setup() {
  localStorage.clear();
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const shortcuts = TestBed.inject(PlayerShortcuts);
  engine.load({ id: 'm1', title: 'Palestra', src: '/m1' });
  media.setDuration(600);
  media.emit('loadedmetadata');
  media.emit('canplay');
  return {
    engine,
    shortcuts,
    media,
    http: TestBed.inject(HttpTestingController),
  };
}

/** A key pressed with the focus on `target` (the page by default). */
function press(
  key: string,
  options: { target?: Element; shift?: boolean; repeat?: boolean } = {},
) {
  const target = options.target ?? document.body;
  const event = new KeyboardEvent('keydown', {
    key,
    repeat: options.repeat ?? false,
    shiftKey: options.shift ?? false,
    cancelable: true,
    bubbles: true,
  });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

function element(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host.querySelector('[data-target]') as Element;
}

describe('targetOf (BR-5)', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it.each([
    ['<input data-target>', 'field'],
    ['<textarea data-target></textarea>', 'field'],
    ['<select data-target></select>', 'field'],
    ['<div contenteditable="true"><p data-target>x</p></div>', 'field'],
    ['<input type="range" data-target>', 'slider'],
    ['<div role="slider" data-target></div>', 'slider'],
    [
      '<div role="menu"><button role="menuitem" data-target>x</button></div>',
      'menu',
    ],
    ['<dialog open><button data-target>x</button></dialog>', 'dialog'],
    ['<button data-target>x</button>', 'button'],
    ['<a href="/x" data-target>x</a>', 'button'],
    ['<p data-target>x</p>', 'page'],
  ])('reads %s as %s', (html, target) => {
    expect(targetOf(element(html))).toBe(target);
  });
});

describe('PlayerShortcuts (FR-6)', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('plays, skips, changes the speed, mutes and jumps to a tenth (AC-6)', () => {
    const { shortcuts, media, engine, http } = setup();
    shortcuts.handle(press('k'));
    expect(media.calls.at(-1)).toBe('play');
    shortcuts.handle(press('l'));
    expect(media.calls.at(-1)).toBe('seek:30');
    shortcuts.handle(press('j'));
    expect(media.calls.at(-1)).toBe('seek:15');
    shortcuts.handle(press('>', { shift: true }));
    expect(engine.speed()).toBe(1.25);
    shortcuts.handle(press('m'));
    expect(engine.muted()).toBe(true);
    shortcuts.handle(press('5'));
    expect(media.calls.at(-1)).toBe('seek:300');
    http.match(() => true).forEach((request) => request.flush({}));
  });

  it('takes over the key only when it acts', () => {
    const { shortcuts } = setup();
    const acted = press('k');
    shortcuts.handle(acted);
    expect(acted.defaultPrevented).toBe(true);
    const typed = press('k', { target: element('<input data-target>') });
    shortcuts.handle(typed);
    expect(typed.defaultPrevented).toBe(false);
    const other = press('x');
    shortcuts.handle(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('can be turned off, and remembers it (WCAG 2.1.4, AC-7)', () => {
    const { shortcuts, media } = setup();
    shortcuts.setEnabled(false);
    shortcuts.handle(press('k'));
    expect(media.calls).not.toContain('play');
    expect(localStorage.getItem('kb-chat.player.single-key')).toBe('off');
    expect(TestBed.inject(PlayerShortcuts).enabled()).toBe(false);
  });

  it('asks for the shortcuts list with "?"', () => {
    const { shortcuts } = setup();
    const before = shortcuts.helpAsked();
    shortcuts.handle(press('?', { shift: true }));
    expect(shortcuts.helpAsked()).toBe(before + 1);
  });

  it('does nothing without a media', () => {
    const media = fakeMediaElement();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      ],
    });
    const key = press('k');
    TestBed.inject(PlayerShortcuts).handle(key);
    expect(key.defaultPrevented).toBe(false);
  });

  it('leaves a key another handler already took', () => {
    const { shortcuts, media } = setup();
    const handled = press('k');
    handled.preventDefault();
    shortcuts.handle(handled);
    expect(media.calls).not.toContain('play');
  });

  it('acts once for a held key that switches something, and keeps skipping on a held L (FR-6)', () => {
    const { shortcuts, media, engine, http } = setup();
    shortcuts.handle(press('k'));
    const held = press('k', { repeat: true });
    shortcuts.handle(held);
    expect(held.defaultPrevented).toBe(true);
    expect(media.calls.filter((call) => call === 'play').length).toBe(1);
    shortcuts.handle(press('m'));
    shortcuts.handle(press('m', { repeat: true }));
    expect(engine.muted()).toBe(true);
    shortcuts.handle(press('>', { shift: true }));
    shortcuts.handle(press('>', { shift: true, repeat: true }));
    expect(engine.speed()).toBe(1.25);
    shortcuts.handle(press('l'));
    shortcuts.handle(press('l', { repeat: true }));
    expect(media.calls.filter((call) => call.startsWith('seek:')).length).toBe(
      2,
    );
    http.match(() => true).forEach((request) => request.flush({}));
  });

  it('leaves "?" alone in the mini-player, which has no shortcuts list', () => {
    const { shortcuts } = setup();
    const asked = press('?', { shift: true });
    shortcuts.handle(asked, 'mini-player');
    expect(asked.defaultPrevented).toBe(false);
    expect(shortcuts.helpAsked()).toBe(0);
  });

  it('marks a bookmark with B on the player page, once per press (KBC-042 FR-2)', () => {
    const { shortcuts, http } = setup();
    TestBed.tick();
    http
      .expectOne({ method: 'GET', url: '/api/v1/media/m1/bookmarks' })
      .flush({ items: [] });
    const store = TestBed.inject(BookmarksStore);
    const first = press('b');
    shortcuts.handle(first);
    expect(first.defaultPrevented).toBe(true);
    shortcuts.handle(press('b', { repeat: true }));
    expect(store.bookmarks()).toHaveLength(1);
    expect(http.match({ method: 'POST' })).toHaveLength(1);
  });

  it('leaves B alone in the mini-player, which has no bookmark note', () => {
    const { shortcuts } = setup();
    const pressed = press('b');
    shortcuts.handle(pressed, 'mini-player');
    expect(pressed.defaultPrevented).toBe(false);
    expect(TestBed.inject(BookmarksStore).bookmarks()).toEqual([]);
  });

  it('goes back and forward by the skips the person chose (KBC-043 AC-1)', () => {
    const { shortcuts, media, engine, http } = setup();
    engine.seek(60_000);
    const preferences = TestBed.inject(ListeningPreferences);
    preferences.setSkipBack(5);
    shortcuts.handle(press('j'));
    expect(media.calls.at(-1)).toBe('seek:55');
    http.match(() => true).forEach((request) => request.flush({}));
  });
});
