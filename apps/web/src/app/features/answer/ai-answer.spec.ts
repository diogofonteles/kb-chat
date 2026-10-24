import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EMPTY_FILTERS, type AnswerEvent } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { AnswersApi } from '@core/api/answers-api.js';
import { SpendStore } from '@core/spend/spend-store.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { Subject, of, throwError } from 'rxjs';
import { AiAnswer } from './ai-answer.js';
import {
  formatCost,
  formatEstimate,
  renderAnswer as renderAnswerHtml,
} from './answer-format.js';

const usage = { track: vi.fn() };

function setup(
  estimate: ReturnType<AnswersApi['estimate']> = of({
    usd: 0.0005,
    model: 'm',
    passages: 3,
    billing: 'per-token',
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

async function renderAnswer(api: object, spend = { refresh: vi.fn() }) {
  const opened = vi.fn();
  const view = await render(AiAnswer, {
    providers: [
      provideZonelessChangeDetection(),
      { provide: AnswersApi, useValue: api },
      { provide: SpendStore, useValue: spend },
      { provide: UsageLog, useValue: usage },
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
    expect(screen.getByText(/^Custo: US\$\s0,0004$/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('link', { name: 'Fonte 1: A Natureza Sétupla' }),
    );
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
      (
        screen.getByRole('button', {
          name: /Responder com IA/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
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
    expect(screen.getByRole('alert').textContent).toMatch(
      /Não consegui gerar a resposta agora/,
    );
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

describe('AiAnswer guards (KBC-004 review)', () => {
  it('ignores a second click while an answer is streaming', async () => {
    const { api } = setup();
    const view = await renderAnswer(api);
    const button = screen.getByRole('button', { name: /Responder com IA/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await view.fixture.whenStable();
    expect(api.answer).toHaveBeenCalledTimes(1);
  });

  it('stops the stream of the old search when the filters change (BR-4)', async () => {
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    await view.fixture.whenStable();
    view.fixture.componentRef.setInput('filters', {
      ...EMPTY_FILTERS,
      genres: ['paper'],
    });
    await view.fixture.whenStable();
    expect(stream.observed).toBe(false);
    expect(
      screen.getByText('Considerando: Tipo de texto: Estudo acadêmico'),
    ).toBeTruthy();
  });

  it('announces a finished answer and suggests another search when the collection lacks material (AC-11)', async () => {
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    stream.next(SOURCES);
    stream.next({
      type: 'token',
      text: 'O acervo não traz informação suficiente sobre isso.',
    });
    stream.next({ type: 'done', usd: 0.0001, model: 'm', interrupted: false });
    await view.fixture.whenStable();
    expect(screen.getByText(/refaça a busca com outras palavras/)).toBeTruthy();
    expect(
      view.container.querySelector('[aria-live="polite"]')?.textContent,
    ).toBe('Resposta da IA pronta.');
  });

  it('offers a retry after stopping before the first token and links to add credits', async () => {
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    await view.fixture.whenStable();
    expect(
      screen.getByText('Resposta interrompida antes de começar.'),
    ).toBeTruthy();
    expect(screen.getByText(/custo do que já foi processado/)).toBeTruthy();
    expect(screen.queryByText(/Lendo/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    stream.next({ type: 'error', code: 'LLM_INSUFFICIENT_CREDIT' });
    await view.fixture.whenStable();
    expect(
      screen
        .getByRole('link', { name: 'Adicionar créditos' })
        .getAttribute('href'),
    ).toBe('https://openrouter.ai/settings/credits');
  });
});

describe('AiAnswer and the spend of the day (KBC-005 FR-5)', () => {
  async function started(answer?: unknown) {
    const { api, stream } = setup();
    if (answer) api.answer.mockReturnValueOnce(answer as never);
    const spend = { refresh: vi.fn() };
    const view = await renderAnswer(api, spend);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    await view.fixture.whenStable();
    return { stream, spend, view };
  }

  it('refreshes the spend when an answer finishes', async () => {
    const { stream, spend } = await started();
    stream.next({ type: 'token', text: 'Texto' });
    stream.next({ type: 'done', usd: 0.0001, model: 'm', interrupted: false });
    stream.complete();
    expect(spend.refresh).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('refreshes the spend when an answer fails', async () => {
    const { spend } = await started(throwError(() => new Error('x')));
    expect(spend.refresh).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('refreshes the spend a moment after "Parar"', async () => {
    const { spend, view } = await started();
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    await view.fixture.whenStable();
    expect(spend.refresh).toHaveBeenCalledExactlyOnceWith(1000);
  });

  it('refreshes the spend when the answer is dropped with its conversation', async () => {
    const { spend, view } = await started();
    view.fixture.destroy();
    expect(spend.refresh).toHaveBeenCalledExactlyOnceWith(1000);
  });
});

describe('AiAnswer usage log (KBC-006 BR-2)', () => {
  it('logs a finished answer with its cost and a stopped one as a cancel', async () => {
    usage.track.mockClear();
    const { api, stream } = setup();
    const view = await renderAnswer(api);
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    stream.next({ type: 'token', text: 'Texto' });
    stream.next({ type: 'done', usd: 0.0003, model: 'm', interrupted: false });
    await view.fixture.whenStable();
    expect(usage.track).toHaveBeenCalledWith({
      type: 'ai_answer',
      usd: 0.0003,
    });
    view.fixture.componentRef.setInput('question', 'outra');
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: /Responder com IA/ }));
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    expect(usage.track).toHaveBeenLastCalledWith({ type: 'ai_cancel' });
  });
});

describe('answer formatting', () => {
  it('drops raw HTML, links and images from model output, keeping citations', () => {
    const html = renderAnswerHtml(
      'Veja <img src="https://evil/x?q=1"> e [site](https://evil) e ![x](https://evil/i.png) [1].',
      [{ n: 1, id: 'a.md', title: 'A' }],
    );
    expect(html).not.toMatch(/<img|href="https:\/\/evil/);
    expect(html).toContain('&lt;img');
    expect(html).toContain('site');
    expect(html).toContain(
      '<a class="cite" href="#fonte-1" aria-label="Fonte 1: A"',
    );
    expect(renderAnswerHtml('sem fonte [9]')).toContain('[9]');
  });

  it('formats estimates and costs in pt-BR', () => {
    expect(formatEstimate(0.004)).toBe('menos de US$ 0,01');
    expect(formatEstimate(0.031)).toMatch(/^~US\$\s0,04$/);
    expect(formatCost(0.00042)).toMatch(/^US\$\s0,0004$/);
  });
});
