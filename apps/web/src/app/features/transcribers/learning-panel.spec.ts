import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type {
  LearnedRule,
  LearnedTerm,
  TranscriptLearning,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { LearningPanel } from './learning-panel.js';

const URL = '/api/v1/media/learning';
const RULE_ID = 'a'.repeat(32);
const TERM_ID = 'b'.repeat(32);

const rule = (overrides: Partial<LearnedRule> = {}): LearnedRule => ({
  id: RULE_ID,
  before: 'a Manta',
  after: 'Atlântida',
  contextBefore: 'com',
  contextAfter: 'foi',
  corrections: 3,
  recordings: 2,
  applied: 5,
  undone: 1,
  state: 'on',
  switchedBy: null,
  conflictWith: null,
  tiesWith: null,
  examples: [
    {
      mediaId: 'm1',
      title: 'Palestra de 1998',
      startMs: 72_000,
      before: 'a Manta',
      after: 'Atlântida',
      contextBefore: 'com',
      contextAfter: 'foi',
      authorName: 'Maria',
      createdAt: '2026-11-09T12:00:00.000Z',
    },
  ],
  ...overrides,
});

const TERM: LearnedTerm = {
  id: TERM_ID,
  term: 'Atlântida',
  corrections: 3,
  recordings: 2,
  state: 'in-list',
  switchedBy: null,
};

const LEARNING: TranscriptLearning = {
  rules: [rule()],
  terms: [TERM],
  tokens: { manual: 180, learned: 18, limit: 224 },
};

let http: HttpTestingController | null = null;

async function renderPanel(learning: TranscriptLearning | 'error' = LEARNING) {
  const view = await render(LearningPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  const read = http.expectOne(URL);
  if (learning === 'error')
    read.flush({}, { status: 500, statusText: 'Server Error' });
  else read.flush(learning);
  await view.fixture.whenStable();
  return view;
}

afterEach(() => {
  http?.verify();
  http = null;
});

describe('LearningPanel (KBC-113 FR-7, T21)', () => {
  it('shows each rule with its context, counts, state and examples, and each term', async () => {
    await renderPanel();

    expect(screen.getByText('Regras (1)')).toBeTruthy();
    expect(screen.getByText('depois de «com» · antes de «foi»')).toBeTruthy();
    expect(
      screen.getByText(
        '3 correções em 2 gravações · aplicada 5 vezes · desfeita 1',
      ),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Palestra de 1998 · 1:12' });
    expect(link.getAttribute('href')).toBe('/midia/m1?t=72');
    expect(
      screen.getByText('Termos aprendidos: 18 de 44 tokens livres.'),
    ).toBeTruthy();
    expect(screen.getByText('Na lista do transcritor')).toBeTruthy();
    expect(
      screen
        .getByRole('switch', { name: 'Regra a Manta → Atlântida: Ligada' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('AC-15, AC-19: switching a rule off saves at once and is announced', async () => {
    const view = await renderPanel();

    fireEvent.click(
      screen.getByRole('switch', { name: /^Regra a Manta → Atlântida: / }),
    );
    await view.fixture.whenStable();
    const put = http?.expectOne(`${URL}/rules/${RULE_ID}`);
    expect(put?.request.method).toBe('PUT');
    expect(put?.request.body).toEqual({ enabled: false });
    // One request per click while the first waits (PD-02).
    fireEvent.click(
      screen.getByRole('switch', { name: /^Regra a Manta → Atlântida: / }),
    );
    put?.flush({
      ...LEARNING,
      rules: [rule({ state: 'off', switchedBy: 'Diogo' })],
    });
    await view.fixture.whenStable();

    expect(screen.getByText('Desligada por Diogo')).toBeTruthy();
    expect(
      screen.getByRole('status', { name: '' }).textContent ?? '',
    ).toContain('Regra desligada. Vale para as próximas transcrições.');
    expect(
      screen
        .getByRole('switch', { name: /^Regra a Manta → Atlântida: / })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('review round 1: a rule switched by a master goes back to automatic; a tie is said', async () => {
    const view = await renderPanel({
      ...LEARNING,
      rules: [rule({ switchedBy: 'Diogo', tiesWith: 'Amanta' })],
    });
    expect(
      screen.getByText(
        'Ligada por Diogo · empata com «Amanta» quando os dois contextos batem; ali nenhuma se aplica',
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Voltar ao automático: Regra a Manta → Atlântida',
      }),
    );
    await view.fixture.whenStable();
    const put = http?.expectOne(`${URL}/rules/${RULE_ID}`);
    expect(put?.request.body).toEqual({ enabled: null });
    put?.flush(LEARNING);
    await view.fixture.whenStable();
    expect(
      screen.getByText(
        'De volta ao automático. Vale para as próximas transcrições.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^Voltar ao automático/ }),
    ).toBeNull();
  });

  it('NG-21: closing the panel while a switch waits drops the answer', async () => {
    const view = await renderPanel();
    fireEvent.click(
      screen.getByRole('switch', { name: /^Regra a Manta → Atlântida: / }),
    );
    await view.fixture.whenStable();
    const put = http?.expectOne(`${URL}/rules/${RULE_ID}`);
    view.fixture.destroy();
    expect(put?.cancelled).toBe(true);
  });

  it('a term turned off, and back on', async () => {
    const view = await renderPanel({
      ...LEARNING,
      terms: [{ ...TERM, state: 'off', switchedBy: 'Diogo' }],
    });
    expect(screen.getByText('Desligado por Diogo')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: /^Termo Atlântida: / }));
    await view.fixture.whenStable();
    const put = http?.expectOne(`${URL}/terms/${TERM_ID}`);
    expect(put?.request.body).toEqual({ enabled: true });
    put?.flush(LEARNING);
    await view.fixture.whenStable();
    expect(
      screen.getByText('Termo ligado. Vale para as próximas transcrições.'),
    ).toBeTruthy();
  });

  it('a failed switch says so and keeps the state', async () => {
    const view = await renderPanel();
    fireEvent.click(
      screen.getByRole('switch', { name: /^Regra a Manta → Atlântida: / }),
    );
    await view.fixture.whenStable();
    http
      ?.expectOne(`${URL}/rules/${RULE_ID}`)
      .flush({}, { status: 500, statusText: 'Server Error' });
    await view.fixture.whenStable();
    expect(
      screen.getByText('Não foi possível mudar a regra. Tente de novo.'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('switch', { name: /^Regra a Manta → Atlântida: / })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('states in words: any context, turned off by undos, in conflict, no room', async () => {
    await renderPanel({
      rules: [
        rule({
          id: '1'.repeat(32),
          contextBefore: null,
          contextAfter: null,
          applied: 1,
        }),
        rule({ id: '4'.repeat(32), applied: 0, undone: 0 }),
        rule({ id: '2'.repeat(32), state: 'auto-off', undone: 2 }),
        rule({
          id: '3'.repeat(32),
          state: 'conflict',
          conflictWith: 'Amanta',
          contextBefore: '',
          contextAfter: '',
        }),
      ],
      terms: [{ ...TERM, state: 'no-room' }],
      tokens: { manual: 224, learned: 0, limit: 224 },
    });
    expect(screen.getByText('em qualquer contexto')).toBeTruthy();
    expect(
      screen.getByText(
        '3 correções em 2 gravações · aplicada 1 vez · desfeita 1',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('3 correções em 2 gravações · ainda não aplicada'),
    ).toBeTruthy();
    // A plain "Ligada" is left to the switch.
    expect(screen.queryByText('Ligada', { selector: '.state' })).toBeNull();
    expect(screen.getByText('Desligada: desfeita 2 vezes')).toBeTruthy();
    expect(screen.getByText('Em conflito com «Amanta»')).toBeTruthy();
    expect(
      screen.getByText('no começo do trecho · no fim do trecho'),
    ).toBeTruthy();
    expect(screen.getByText('Fora por falta de espaço')).toBeTruthy();
  });

  it('shows 20 rules, then more on asking', async () => {
    const view = await renderPanel({
      ...LEARNING,
      rules: Array.from({ length: 25 }, (_, n) =>
        rule({ id: n.toString(16).padStart(32, '0'), after: `Certo${n}` }),
      ),
    });
    expect(screen.getAllByRole('switch', { name: /^Regra/ })).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais (5)' }));
    await view.fixture.whenStable();
    expect(screen.getAllByRole('switch', { name: /^Regra/ })).toHaveLength(25);
  });

  it('empty', async () => {
    await renderPanel({
      rules: [],
      terms: [],
      tokens: { manual: 0, learned: 0, limit: 224 },
    });
    expect(
      screen.getByText(/Nada aprendido das correções por enquanto/),
    ).toBeTruthy();
  });

  it('a failed read says so, with Tentar de novo', async () => {
    const view = await renderPanel('error');
    expect(
      screen.getByText('Não foi possível carregar o aprendizado.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http?.expectOne(URL).flush(LEARNING);
    await view.fixture.whenStable();
    expect(screen.getByText('Regras (1)')).toBeTruthy();
  });
});
