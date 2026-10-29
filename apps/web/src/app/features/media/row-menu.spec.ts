import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { RowMenu } from './row-menu.js';

async function renderMenu() {
  const removeChosen = vi.fn();
  const view = await render(RowMenu, {
    providers: [provideZonelessChangeDetection()],
    inputs: { label: 'Mais ações para Palestra' },
    on: { removeChosen },
  });
  const trigger = screen.getByRole('button', {
    name: 'Mais ações para Palestra',
  });
  return { ...view, trigger, removeChosen };
}

describe('RowMenu (menu button pattern)', () => {
  it('opens on a click with the focus on its first item', async () => {
    const { trigger, fixture } = await renderMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    await fixture.whenStable();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name: 'Remover' }),
      ),
    );
  });

  it('opens with the arrows, moves between items, and closes with Escape on the button', async () => {
    const { trigger, fixture } = await renderMenu();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    await fixture.whenStable();
    const item = screen.getByRole('menuitem', { name: 'Remover' });
    await vi.waitFor(() => expect(document.activeElement).toBe(item));
    fireEvent.keyDown(item, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'Escape' });
    await fixture.whenStable();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('ignores other keys on the button', async () => {
    const { trigger, fixture } = await renderMenu();
    fireEvent.keyDown(trigger, { key: 'a' });
    await fixture.whenStable();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('chooses "Remover" and closes', async () => {
    const { trigger, fixture, removeChosen } = await renderMenu();
    fireEvent.click(trigger);
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }));
    await fixture.whenStable();
    expect(removeChosen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a second click, on Tab, on a click outside and when the focus leaves', async () => {
    const { trigger, fixture } = await renderMenu();
    fireEvent.click(trigger);
    await fixture.whenStable();
    fireEvent.click(trigger);
    await fixture.whenStable();
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    await fixture.whenStable();
    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Tab' });
    await fixture.whenStable();
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    await fixture.whenStable();
    fireEvent.click(document.body);
    await fixture.whenStable();
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    await fixture.whenStable();
    const outside = document.createElement('button');
    document.body.append(outside);
    fireEvent.focusOut(screen.getByRole('menu'), { relatedTarget: outside });
    await fixture.whenStable();
    expect(screen.queryByRole('menu')).toBeNull();
    outside.remove();
  });

  it('stays open when the focus moves inside it', async () => {
    const { trigger, fixture } = await renderMenu();
    fireEvent.click(trigger);
    await fixture.whenStable();
    fireEvent.focusOut(screen.getByRole('menu'), {
      relatedTarget: screen.getByRole('menuitem'),
    });
    await fixture.whenStable();
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});
