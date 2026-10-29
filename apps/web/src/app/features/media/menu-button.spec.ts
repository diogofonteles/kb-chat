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
  it('lists choices as radio items with the current one checked, in text too', async () => {
    const { trigger, fixture } = await renderChoice();
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Shift+. Shift+,');
    fireEvent.click(trigger);
    await fixture.whenStable();
    expect(screen.getByRole('menu', { name: 'Velocidade' })).toBeTruthy();
    const current = screen.getByRole('menuitemradio', { name: /1,5×/ });
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect(current.textContent).toContain('✓');
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
});
