import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import type { AiStatus } from '@kb-chat/contracts';
import { aSettingsView, anAiStatus } from '../../testing/settings-fixtures.js';
import { AiStatusCard } from './ai-status-card.js';
import { SettingsStore } from './settings-store.js';

async function renderCard(status: AiStatus) {
  return render(AiStatusCard, {
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: SettingsStore,
        useValue: {
          aiStatus: { hasValue: () => true, value: () => status },
          settings: () => aSettingsView(),
        },
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

  it('KBC-023 AC-7: shows today’s spend against the cap and the last test of one’s own AI', async () => {
    await renderCard(
      anAiStatus({
        source: 'own',
        provider: 'openai',
        spentTodayUsd: 0.02,
        dailyCapUsd: 1,
        lastTest: {
          provider: 'openai',
          ok: true,
          code: null,
          at: '2026-10-26T15:30:00.000Z',
        },
      }),
    );
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Você paga · Gasto hoje: US$ 0,02 de US$ 1,00');
    // The date in the browser's own time zone, as "dd/mm hh:mm" (AC-7).
    const at = new Date('2026-10-26T15:30:00.000Z');
    const two = (n: number) => String(n).padStart(2, '0');
    const when = `${two(at.getDate())}/${two(at.getMonth() + 1)} ${two(at.getHours())}:${two(at.getMinutes())}`;
    expect(text).toContain(`Último teste: funcionando (${when})`);
  });

  it('says one’s own free models cost nothing', async () => {
    await renderCard(
      anAiStatus({ source: 'own', provider: 'gemini', free: true }),
    );
    expect(document.body.textContent).toContain('Gratuito para você.');
  });

  it('names one’s own plan and why the last test failed (KBC-023 AC-1, BR-6)', async () => {
    await renderCard(
      anAiStatus({
        source: 'own',
        provider: 'openrouter',
        free: true,
        lastTest: {
          provider: 'openrouter',
          ok: false,
          code: 'LLM_KEY_REJECTED',
          at: '2026-10-26T15:30:00.000Z',
        },
      }),
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('OpenRouter');
    expect(text).toContain('Só modelos gratuitos');
    expect(text).toContain('Último teste: falhou');
    expect(text).toContain('A chave não foi aceita pelo provedor.');
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
