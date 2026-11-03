import { describe, expect, it } from 'vitest';
import { shortcutOf, type KeyPress } from './shortcuts.js';

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: 'page',
  ...extra,
});

describe('player shortcuts (T15, FR-6, BR-5)', () => {
  it.each([
    [' ', { kind: 'toggle' }],
    ['k', { kind: 'toggle' }],
    ['K', { kind: 'toggle' }],
    ['j', { kind: 'back' }],
    ['l', { kind: 'forward' }],
    ['ArrowLeft', { kind: 'seek-by', deltaMs: -5_000 }],
    ['ArrowRight', { kind: 'seek-by', deltaMs: 5_000 }],
    ['<', { kind: 'speed', direction: -1 }],
    ['>', { kind: 'speed', direction: 1 }],
    ['m', { kind: 'mute' }],
    ['b', { kind: 'bookmark' }],
    ['B', { kind: 'bookmark' }],
    ['c', { kind: 'captions' }],
    ['C', { kind: 'captions' }],
    ['0', { kind: 'seek-fraction', fraction: 0 }],
    ['5', { kind: 'seek-fraction', fraction: 0.5 }],
    ['9', { kind: 'seek-fraction', fraction: 0.9 }],
    ['?', { kind: 'help' }],
  ])('maps %j', (key, action) => {
    expect(shortcutOf(press(key), true)).toEqual(action);
  });

  it('ignores other keys', () => {
    for (const key of [
      'a',
      'x',
      'Enter',
      'Tab',
      'Escape',
      'F5',
      'ArrowUp',
      '12',
    ])
      expect(shortcutOf(press(key), true)).toBeNull();
  });

  it('never acts in a field, a menu or a dialog (BR-5, AC-7)', () => {
    for (const target of ['field', 'menu', 'dialog'] as const)
      for (const key of ['k', ' ', 'l', '5', 'ArrowRight'])
        expect(shortcutOf(press(key, { target }), true)).toBeNull();
  });

  it('does nothing with the single-key shortcuts turned off (WCAG 2.1.4)', () => {
    for (const key of ['k', ' ', 'j', 'l', 'm', '5', '?', 'ArrowLeft'])
      expect(shortcutOf(press(key), false)).toBeNull();
  });

  it('leaves keys with Ctrl, Cmd or Alt to the browser', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const)
      expect(shortcutOf(press('k', { [mod]: true }), true)).toBeNull();
  });

  it('leaves the keys a focused control consumes to it (AC-8)', () => {
    for (const key of ['ArrowLeft', 'ArrowRight'])
      expect(shortcutOf(press(key, { target: 'slider' }), true)).toBeNull();
    expect(shortcutOf(press('k', { target: 'slider' }), true)).toEqual({
      kind: 'toggle',
    });
    // Space and Enter press a focused button themselves.
    expect(shortcutOf(press(' ', { target: 'button' }), true)).toBeNull();
    expect(shortcutOf(press('l', { target: 'button' }), true)).toEqual({
      kind: 'forward',
    });
    // Elsewhere the same keys act.
    expect(shortcutOf(press(' ', { target: 'page' }), true)).toEqual({
      kind: 'toggle',
    });
    expect(shortcutOf(press('ArrowRight', { target: 'button' }), true)).toEqual(
      { kind: 'seek-by', deltaMs: 5_000 },
    );
  });

  it('reads Shift+, and Shift+. as the speed keys, whatever the layout says', () => {
    expect(shortcutOf(press(',', { shiftKey: true }), true)).toEqual({
      kind: 'speed',
      direction: -1,
    });
    expect(shortcutOf(press('.', { shiftKey: true }), true)).toEqual({
      kind: 'speed',
      direction: 1,
    });
    expect(shortcutOf(press(','), true)).toBeNull();
  });
});
