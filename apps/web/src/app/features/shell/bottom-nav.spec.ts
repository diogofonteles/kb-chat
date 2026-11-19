import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { BottomNav, navTabs, type NavTab } from './bottom-nav.js';

const labels = (audio: Parameters<typeof navTabs>[0]) =>
  navTabs(audio).map((tab) => tab.label);

describe('the phone navigation under the audio rule (KBC-125 BR-2, AC-4)', () => {
  it('is Conversas · Buscar · Acervos without audio', () => {
    expect(labels(null)).toEqual(['Conversas', 'Buscar', 'Acervos']);
  });

  it('is Conversas · Buscar · Biblioteca · Fila with audio and the queue', () => {
    expect(labels({ queue: true, library: '/biblioteca' })).toEqual([
      'Conversas',
      'Buscar',
      'Biblioteca',
      'Fila',
    ]);
  });

  it('keeps Acervos in the place of Fila for who has no queue', () => {
    expect(labels({ queue: false, library: '/biblioteca' })).toEqual([
      'Conversas',
      'Buscar',
      'Biblioteca',
      'Acervos',
    ]);
  });

  it('names the tab Mídia when it opens Mídia (no library permission)', () => {
    expect(labels({ queue: false, library: '/midia' })).toEqual([
      'Conversas',
      'Buscar',
      'Mídia',
      'Acervos',
    ]);
  });

  it('has no library tab when the person cannot open the library', () => {
    expect(labels({ queue: true, library: null })).toEqual([
      'Conversas',
      'Buscar',
      'Acervos',
    ]);
  });
});

describe('the phone navigation has one current tab (KBC-125 FR-4)', () => {
  async function renderNav(active: NavTab | null) {
    const view = await render(BottomNav, {
      inputs: {
        tabs: navTabs({ queue: true, library: '/biblioteca' }),
        active,
      },
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    await view.fixture.whenStable();
    return view;
  }
  const current = () =>
    screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent?.trim());
  const bold = () =>
    [...document.querySelectorAll('.tab.on')].map((tab) =>
      tab.textContent?.trim(),
    );

  it('is Conversas on the conversation', async () => {
    await renderNav(null);
    expect(current()).toEqual(['Conversas']);
    expect(bold()).toEqual(['Conversas']);
  });

  it('is only Buscar while searching, though both share the same page', async () => {
    await renderNav('search');
    expect(current()).toEqual(['Buscar']);
    expect(bold()).toEqual(['Buscar']);
  });
});
