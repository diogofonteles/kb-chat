import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { MenuButton, type MenuOption } from './menu-button.js';

const SPEEDS: MenuOption[] = [
  { id: '1', label: '1×' },
  { id: '1.5', label: '1,5×', checked: true },
  { id: '2', label: '2×' },
];

async function renderChoice() {
  const chosen = vi.fn();
  const view = await render(MenuButton, {
    providers: [provideZonelessChangeDetection()],
    inputs: {
      label: 'Velocidade: 1,5 vezes',
      menuLabel: 'Velocidade',
      options: SPEEDS,
      kind: 'choice',
      keyshortcuts: 'Shift+. Shift+,',
    },
    on: { chosen },
  });
  const trigger = screen.getByRole('button', { name: 'Velocidade: 1,5 vezes' });
  return { ...view, trigger, chosen };
}

describe('MenuButton (APG menu button)', () => {
  it('lists choices as radio items with the current one checked, its check drawn', async () => {
    const { trigger, fixture } = await renderChoice();
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Shift+. Shift+,');
    fireEvent.click(trigger);
    await fixture.whenStable();
    expect(screen.getByRole('menu', { name: 'Velocidade' })).toBeTruthy();
    const current = screen.getByRole('menuitemradio', { name: /1,5×/ });
    expect(current.getAttribute('aria-checked')).toBe('true');
    // A ✓ beside it, never the colour alone (UP-20); none beside the others.
    expect(current.querySelector('.check ui-icon')).not.toBeNull();
    expect(
      screen
        .getByRole('menuitemradio', { name: /^\s*2×/ })
        .querySelector('.check ui-icon'),
    ).toBeNull();
    expect(
      screen
        .getByRole('menuitemradio', { name: /^\s*2×/ })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('opens on the checked choice, and Home and End reach the ends', async () => {
    const { trigger, fixture } = await renderChoice();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await fixture.whenStable();
    const items = screen.getAllByRole('menuitemradio');
    await vi.waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('gives the chosen id and puts the focus back on the button', async () => {
    const { trigger, fixture, chosen } = await renderChoice();
    fireEvent.click(trigger);
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^\s*2×/ }));
    await fixture.whenStable();
    expect(chosen).toHaveBeenCalledWith('2');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Escape inside the menu, so a dialog around it stays open', async () => {
    const { trigger, fixture } = await renderChoice();
    fireEvent.click(trigger);
    await fixture.whenStable();
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    document.removeEventListener('keydown', outside);
    expect(outside).not.toHaveBeenCalled();
  });

  it('hears the document only while open: a click outside closes it (NFR-2)', async () => {
    const listening = vi.spyOn(document, 'addEventListener');
    const { trigger, fixture } = await renderChoice();
    // Closed, it listens to no click of the document (one ⋯ per row of 2 000).
    expect(listening.mock.calls.some(([type]) => type === 'click')).toBe(false);
    fireEvent.click(trigger);
    await fixture.whenStable();
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(document.body);
    await fixture.whenStable();
    expect(screen.queryByRole('menu')).toBeNull();
    const stopped = vi.spyOn(document, 'removeEventListener');
    fireEvent.click(trigger);
    await fixture.whenStable();
    fireEvent.click(document.body);
    await fixture.whenStable();
    expect(stopped.mock.calls.some(([type]) => type === 'click')).toBe(true);
    listening.mockRestore();
    stopped.mockRestore();
  });

  it.each([
    [
      'Escape',
      (menu: HTMLElement) => fireEvent.keyDown(menu, { key: 'Escape' }),
    ],
    ['Tab', (menu: HTMLElement) => fireEvent.keyDown(menu, { key: 'Tab' })],
    [
      'a choice',
      () =>
        fireEvent.click(screen.getByRole('menuitemradio', { name: /^\s*2×/ })),
    ],
  ])(
    'stops hearing the document as soon as it closes by %s, with no click after',
    async (_how, close) => {
      const { trigger, fixture } = await renderChoice();
      fireEvent.click(trigger);
      await fixture.whenStable();
      const stopped = vi.spyOn(document, 'removeEventListener');

      close(screen.getByRole('menu'));
      await fixture.whenStable();

      expect(screen.queryByRole('menu')).toBeNull();
      expect(stopped.mock.calls.some(([type]) => type === 'click')).toBe(true);
      stopped.mockRestore();
    },
  );

  describe('stays on the screen, however wide its text', () => {
    const rectOf = (left: number, right: number) =>
      ({ left, right }) as DOMRect;

    const openWith = async (left: number, right: number) => {
      vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(
        390,
      );
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
        rectOf(left, right),
      );
      // The list as wide as its text, lined up with the button's end.
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(
        right - left,
      );
      const { trigger, fixture } = await renderChoice();
      fireEvent.click(trigger);
      await fixture.whenStable();
      return screen.getByRole('menu');
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** The menu's left edge and the room it keeps from both sides of a 390 screen. */
    const onScreen = (menu: HTMLElement) => {
      const left = Number.parseFloat(menu.style.left);
      return left >= 8 && left <= 390 - 8;
    };

    it('moves right when it would start past the left edge', async () => {
      const menu = await openWith(-27.5, 182.5);
      await vi.waitFor(() => expect(menu.style.left).toBe('8px'));
      expect(onScreen(menu)).toBe(true);
    });

    it('moves left when it would end past the right edge', async () => {
      const menu = await openWith(200, 410);
      await vi.waitFor(() => expect(menu.style.left).toBe('172px'));
      expect(onScreen(menu)).toBe(true);
    });

    it('stays under the button when it fits', async () => {
      const menu = await openWith(40, 250);
      await vi.waitFor(() => expect(menu.style.left).toBe('40px'));
      expect(onScreen(menu)).toBe(true);
    });
  });
});
