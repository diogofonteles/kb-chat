import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LibraryItem } from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aMediaItem, mediaId } from '../../../testing/media-fixtures.js';
import { LibraryRow, type RowAction } from './library-row.js';

const lecture: LibraryItem = {
  ...aMediaItem({ id: mediaId(1), title: 'Palestra 1' }),
  kind: 'audio',
  lastPlayedAt: null,
  tracks: [],
};

async function setup({ phone }: { readonly phone: boolean }) {
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }])],
  });
  const fixture = TestBed.createComponent(LibraryRow);
  fixture.componentRef.setInput('item', lecture);
  fixture.componentRef.setInput('phone', phone);
  const acted: RowAction[] = [];
  fixture.componentInstance.acted.subscribe((action) => acted.push(action));
  await fixture.whenStable();
  // The press's timer, under the test's clock (after the render, which waits on real time).
  vi.useFakeTimers();
  const host = fixture.nativeElement as HTMLElement;
  const title = host.querySelector('.main') as HTMLElement;
  return { fixture, host, title, acted };
}

const press = (target: Element, type: string, { x = 10, y = 10 } = {}) =>
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }),
  );

describe('LibraryRow, a phone starts a selection with a long press (media-library-row-menu@mobile)', () => {
  afterEach(() => vi.useRealTimers());

  it('selects after half a second on the row, and the lift opens nothing', async () => {
    const { title, acted } = await setup({ phone: true });
    press(title, 'pointerdown');
    vi.advanceTimersByTime(499);
    expect(acted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(acted).toEqual(['select']);
    press(title, 'pointerup');
    // The lift's click stops at the row: the link under it never sees it.
    const reached: Event[] = [];
    title.addEventListener('click', (event) => {
      reached.push(event);
      event.preventDefault();
    });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    title.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(reached).toEqual([]);
    // The next tap is a tap again.
    title.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(reached).toHaveLength(1);
  });

  it('a finger that scrolls, or lifts early, selects nothing', async () => {
    const { title, acted } = await setup({ phone: true });
    press(title, 'pointerdown');
    press(title, 'pointermove', { y: 40 });
    vi.advanceTimersByTime(600);
    press(title, 'pointerdown');
    vi.advanceTimersByTime(300);
    press(title, 'pointerup');
    vi.advanceTimersByTime(600);
    expect(acted).toEqual([]);
  });

  it('the context menu (Android, the menu key, Shift+F10) selects it', async () => {
    const { title, acted } = await setup({ phone: true });
    const menu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    title.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    title.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'F10',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(acted).toEqual(['select', 'select']);
  });

  it('the ⋯ keeps its own press, and a desktop row is left alone', async () => {
    const phone = await setup({ phone: true });
    const more = phone.host.querySelector('app-menu-button button');
    expect(more).not.toBeNull();
    if (more) press(more, 'pointerdown');
    vi.advanceTimersByTime(600);
    expect(phone.acted).toEqual([]);

    vi.useRealTimers();
    TestBed.resetTestingModule();
    const desktop = await setup({ phone: false });
    press(desktop.title, 'pointerdown');
    vi.advanceTimersByTime(600);
    const menu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    desktop.title.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
    expect(desktop.acted).toEqual([]);
  });
});
