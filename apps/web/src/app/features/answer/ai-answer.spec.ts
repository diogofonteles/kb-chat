import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EMPTY_FILTERS, type AnswerEvent } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { AnswersApi } from '@core/api/answers-api.js';
import { Subject, of, throwError } from 'rxjs';
import { AiAnswer } from './ai-answer.js';
import { formatCost, formatEstimate } from './answer-format.js';

function setup(
  estimate: ReturnType<AnswersApi['estimate']> = of({
    usd: 0.0005,
    model: 'm',
    passages: 3,
  }),
) {
  const stream = new Subject<AnswerEvent>();
  const api = {
    estimate: vi.fn(() => estimate),
    answer: vi.fn(() => stream),
    spendToday: vi.fn(),
  };
  return { stream, api };
}

async function renderAnswer(api: object) {
  const opened = vi.fn();
  const view = await render(AiAnswer, {
    providers: [
      provideZonelessChangeDetection(),
      { provide: AnswersApi, useValue: api },
    ],
    inputs: {
      topic: 'hermetismo',
      question: 'o que é a natureza?',
      mode: 'all',
      filters: EMPTY_FILTERS,
    },
    on: { opened },
  });
  // The estimate resource settles on the next change-detection pass.
  TestBed.tick();
  await view.fixture.whenStable();
  return { ...view, opened };
}

const SOURCES: AnswerEvent = {
  type: 'sources',
  sources: [{ n: 1, id: 'raw/a.md', title: 'A Natureza Sétupla' }],
};

describe('AiAnswer', () => {
  it('shows the estimated cost and never runs by itself (AC-1, AC-2)', async () => {
    const { api } = setup();
    await renderAnswer(api);
    expect(
      screen.getByRole('button', {
        name: /Responder com IA · menos de US\$ 0,01/,
      }),
    ).toBeTruthy();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('streams the answer with clickable citations, sources and cost (AC-3)', async () => {
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    await view.fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Parar' })).toBeTruthy();
    stream.next(SOURCES);
    await view.fixture.whenStable();
    expect(screen.getByText(/Lendo 1 trechos/)).toBeTruthy();
    stream.next({ type: 'token', text: 'A natureza é sétupla ' });
    stream.next({ type: 'token', text: '[1].' });
    stream.next({ type: 'done', usd: 0.0004, model: 'm', interrupted: false });
    await view.fixture.whenStable();
    expect(screen.getByText(/A natureza é sétupla/)).toBeTruthy();
    expect(screen.getByText('Custo: US$ 0,0004')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '[1]' }));
    expect(view.opened).toHaveBeenCalledWith({
      id: 'raw/a.md',
      title: 'A Natureza Sétupla',
    });
    fireEvent.click(screen.getByRole('button', { name: 'A Natureza Sétupla' }));
    expect(view.opened).toHaveBeenCalledTimes(2);
  });

  it('stops on "Parar" and marks the answer as interrupted (AC-8)', async () => {
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    stream.next({ type: 'token', text: 'Começo' });
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    await view.fixture.whenStable();
    expect(stream.observed).toBe(false);
    expect(screen.getByText('(interrompida)')).toBeTruthy();
  });

  it('explains how to enable answers when no provider is configured (AC-6)', async () => {
    const error = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'LLM_NOT_CONFIGURED', message: 'x' } },
    });
    const { api } = setup(throwError(() => error));
    await renderAnswer(api);
    expect(
      screen.queryByRole('button', { name: /Responder com IA/ }),
    ).toBeNull();
    expect(screen.getByText(/configure um provedor de IA/)).toBeTruthy();
  });

  it('shows the daily cap and credit refusals with a retry (AC-5, AC-7)', async () => {
    const { api } = setup();
    const refusal = new HttpErrorResponse({
      status: 429,
      error: JSON.stringify({
        error: { code: 'DAILY_CAP_REACHED', message: 'x' },
      }),
    });
    api.answer.mockReturnValueOnce(throwError(() => refusal) as never);
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(/Limite de gasto/);
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });

  it('treats a finished answer without text as a failure', async () => {
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    stream.next(SOURCES);
    stream.next({ type: 'done', usd: 0.0006, model: 'm', interrupted: false });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(/Algo deu errado/);
  });

  it('reports an error event from the stream', async () => {
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    stream.next({ type: 'error', code: 'LLM_INSUFFICIENT_CREDIT' });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(
      /créditos da OpenRouter acabaram/,
    );
  });

  it('starts over when the filters change (BR-4)', async () => {
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    stream.next({ type: 'token', text: 'Texto' });
    await view.fixture.whenStable();
    view.fixture.componentRef.setInput('filters', {
      ...EMPTY_FILTERS,
      genres: ['paper'],
    });
    await view.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: /Responder com IA/ }),
    ).toBeTruthy();
  });
});

describe('answer formatting', () => {
  it('formats estimates and costs in pt-BR', () => {
    expect(formatEstimate(0.004)).toBe('menos de US$ 0,01');
    expect(formatEstimate(0.031)).toBe('~US$ 0,04');
    expect(formatCost(0.00042)).toBe('US$ 0,0004');
  });
});
