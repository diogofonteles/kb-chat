import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import type { AiStatus } from '@kb-chat/contracts';
import { anAiStatus } from '../../testing/settings-fixtures.js';
import { AiStatusCard } from './ai-status-card.js';
import { SettingsStore } from './settings-store.js';

async function renderCard(status: AiStatus) {
  return render(AiStatusCard, {
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: SettingsStore,
        useValue: { aiStatus: { hasValue: () => true, value: () => status } },
      },
    ],
  });
}

describe('AiStatusCard (KBC-022, T6)', () => {
  it('says the app lends the AI, that it is free and the researches left', async () => {
    await renderCard(
      anAiStatus({
        source: 'app',
        appAi: 'house',
        provider: 'app',
        remainingToday: 3,
        dailyResearches: 5,
        enforced: true,
      }),
    );
    const card = screen.getByRole('group', { name: 'Quem atende você agora' });
    expect(card.textContent).toContain(
      'IA da aplicação (cedida pelo administrador)',
    );
    expect(card.textContent).toContain('Plano da casa');
    expect(card.textContent).toContain('Pesquisas restantes hoje: 3 de 5');
    expect(card.textContent).toContain('O administrador definiu');
  });

  it('says when the person’s own AI serves them, and when none does', async () => {
    await renderCard(anAiStatus({ source: 'own', provider: 'openrouter' }));
    expect(document.body.textContent).toContain('Sua IA');
    expect(document.body.textContent).toContain('OpenRouter');
  });

  it('says when nothing serves the person', async () => {
    await renderCard(anAiStatus());
    expect(document.body.textContent).toContain('só a busca nos documentos');
  });
});

describe('SettingsStore.returnFromOpenRouter (KBC-022 AC-1)', () => {
  it('opens "IA da aplicação" with the outcome, and ignores other addresses', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const store = TestBed.inject(SettingsStore);
    expect(store.returnFromOpenRouter('?q=1')).toBe(false);
    expect(store.returnFromOpenRouter('?openrouter=connected&for=house')).toBe(
      true,
    );
    expect(store.connectOutcome()).toBe('connected');
    expect(store.section()).toBe('house');
    expect(store.panel()).toBe('settings');
    store.returnFromOpenRouter('?openrouter=error');
    expect(store.section()).toBe('ai');
  });
});
