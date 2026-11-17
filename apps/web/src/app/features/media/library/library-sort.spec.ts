import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { LibrarySortMenu } from './library-sort.js';

async function renderSort(phone = false) {
  const sorts: string[] = [];
  const views: string[] = [];
  const view = await render(LibrarySortMenu, {
    providers: [provideZonelessChangeDetection()],
    inputs: { sort: 'recently-played', view: 'list', phone },
    on: {
      sortChange: (value: string) => sorts.push(value),
      viewChange: (value: string) => views.push(value),
    },
  });
  return { ...view, sorts, views };
}

describe('LibrarySortMenu ("Ordenar e ver como", KBC-128 FR-3)', () => {
  it('orders through a menu button and switches the view', async () => {
    const { sorts, views, fixture } = await renderSort();
    fireEvent.click(
      screen.getByRole('button', { name: 'Ordenar: Ouvidas recentemente' }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Duração/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Ordenar: Ouvidas recentemente' }),
    );
    await fixture.whenStable();
    expect(
      screen.getByRole('group', { name: 'Ver como' }).textContent,
    ).toContain('✓');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Grade/ }));
    expect(sorts).toEqual(['duration']);
    expect(views).toEqual(['grid']);
  });

  it('says nothing when the order or the view chosen is the current one', async () => {
    const { sorts, views, fixture } = await renderSort(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Ordenar: Ouvidas recentemente' }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Lista/ }));
    expect(views).toEqual([]);
    expect(sorts).toEqual([]);
  });

  it('on a phone with a filter on, shows how much is left; the menu keeps its name', async () => {
    const { fixture } = await render(LibrarySortMenu, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        sort: 'recently-played',
        view: 'list',
        phone: true,
        summary: '5 mídias · 3 min',
      },
    });
    await fixture.whenStable();
    const trigger = screen.getByRole('button', {
      name: 'Ordenar: Ouvidas recentemente',
    });
    expect(trigger.textContent).toContain('5 mídias · 3 min');
    expect(trigger.textContent).not.toContain('Ouvidas recentemente');
  });

  it('offers "Compacta", "Lista" and "Grade" in that order, "Compacta" checked when on', async () => {
    const views: string[] = [];
    const { fixture } = await render(LibrarySortMenu, {
      providers: [provideZonelessChangeDetection()],
      inputs: { sort: 'recently-played', view: 'compact' },
      on: { viewChange: (value: string) => views.push(value) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Ordenar: Ouvidas recentemente' }),
    );
    await fixture.whenStable();
    const group = screen.getByRole('group', { name: 'Ver como' });
    const items = Array.from(
      group.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
    expect(
      items.map((item) => item.textContent?.replace('✓', '').trim()),
    ).toEqual(['Compacta', 'Lista', 'Grade']);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Lista/ }));
    expect(views).toEqual(['list']);
  });

  it('ends a phone\'s sheet with "Limpar recentes", an action among the choices', async () => {
    let cleared = 0;
    const { fixture } = await render(LibrarySortMenu, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        sort: 'recently-played',
        view: 'list',
        phone: true,
        clearRecents: true,
      },
      on: { recentsCleared: () => (cleared += 1) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Ordenar: Ouvidas recentemente' }),
    );
    await fixture.whenStable();
    const clear = screen.getByRole('menuitem', { name: 'Limpar recentes' });
    expect(clear.getAttribute('aria-checked')).toBeNull();
    fireEvent.click(clear);
    expect(cleared).toBe(1);
  });
});
