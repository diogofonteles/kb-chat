import {
  ChangeDetectionStrategy,
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { UiMenu, UiMenuItem } from './menu.js';

@Component({
  imports: [UiMenu, UiMenuItem],
  template: `
    <ui-menu label="Ordenar" menuId="order">
      <span uiMenuTrigger>Ordenar por</span>
      <button
        uiMenuItem
        type="button"
        [checked]="order() === 'recent'"
        (click)="order.set('recent')"
      >
        Recentes
      </button>
      <button
        uiMenuItem
        type="button"
        [checked]="order() === 'alpha'"
        (click)="order.set('alpha')"
      >
        Ordem alfabética
      </button>
      <button uiMenuItem type="button" (click)="field.focus()">Renomear</button>
    </ui-menu>
    <input #field aria-label="Nome" />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class OrderMenuHost {
  readonly order = signal<'recent' | 'alpha'>('recent');
}

describe('UiMenu (KBC-125 D5, APG menu button)', () => {
  async function setup() {
    const view = await render(OrderMenuHost, {
      providers: [provideZonelessChangeDetection()],
    });
    const trigger = screen.getByRole('button', { name: 'Ordenar por' });
    fireEvent.click(trigger);
    await view.fixture.whenStable();
    return { view, trigger };
  }

  it('exposes a set of choices as menuitemradio with the chosen one checked', async () => {
    const { view } = await setup();
    const recent = screen.getByRole('menuitemradio', { name: 'Recentes' });
    const alpha = screen.getByRole('menuitemradio', {
      name: 'Ordem alfabética',
    });
    expect(recent.getAttribute('aria-checked')).toBe('true');
    expect(alpha.getAttribute('aria-checked')).toBe('false');
    // A plain action keeps the menuitem role, with no aria-checked.
    const rename = screen.getByRole('menuitem', { name: 'Renomear' });
    expect(rename.hasAttribute('aria-checked')).toBe(false);
    // The arrows reach the choices too.
    expect(document.activeElement).toBe(recent);
    fireEvent.keyDown(recent, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(alpha);

    fireEvent.click(alpha);
    await view.fixture.whenStable();
    expect(alpha.getAttribute('aria-checked')).toBe('true');
    expect(recent.getAttribute('aria-checked')).toBe('false');
  });

  it('gives the focus back to the trigger after a choice that does not move it', async () => {
    const { view, trigger } = await setup();
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'Ordem alfabética' }),
    );
    await view.fixture.whenStable();
    expect(screen.getByRole('menu', { hidden: true }).hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves the focus where the item took it', async () => {
    const { view } = await setup();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }));
    await view.fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Nome' }),
    );
  });

  it('keeps an Escape to itself: the panel or dialog around it stays open', async () => {
    const { view, trigger } = await setup();
    const outer = vi.fn();
    view.fixture.nativeElement.addEventListener('keydown', outer);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await view.fixture.whenStable();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(outer).not.toHaveBeenCalled();
    // A key the menu does not use still reaches the page.
    fireEvent.click(trigger);
    await view.fixture.whenStable();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'x' });
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
