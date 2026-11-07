import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { LOCALE_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { ProposalEstimate, ProposalRun } from '@kb-chat/contracts';
import { EMPTY, Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { ProposeResult } from './track-draft-state.js';
import { TrackProposals } from './track-proposals.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const URL = `/api/v1/media/${MEDIA}/edit/proposals`;
const RUN: ProposalRun = {
  id: '22222222-2222-4222-8222-222222222222',
  mediaId: MEDIA,
  status: 'running',
  model: 'stub',
  windowsTotal: 5,
  windowsDone: 2,
  tracks: 3,
  estimateUsd: 0.02,
  limitUsd: 0.02,
  spentUsd: 0.01,
  failure: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  finishedAt: null,
};
const ESTIMATE: ProposalEstimate = {
  estimateUsd: 0.02,
  runCapUsd: 0.25,
  windows: 5,
  model: 'stub',
  allowed: true,
  refusal: null,
  restarts: false,
  month: { spentUsd: 1.2, capUsd: 10 },
};

async function setup(inputs: object = {}) {
  const rendered = await render(TrackProposals, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: LOCALE_ID, useValue: 'pt-BR' },
    ],
    inputs: {
      mediaId: MEDIA,
      start: (): Observable<ProposeResult> => of({ kind: 'started' }),
      ...inputs,
    },
  });
  return { ...rendered, http: TestBed.inject(HttpTestingController) };
}

const ask = async (rendered: Awaited<ReturnType<typeof setup>>) => {
  fireEvent.click(screen.getByRole('button', { name: 'Propor faixas com IA' }));
  const estimate = rendered.http.expectOne(URL);
  expect(estimate.request.body).toEqual({ dryRun: true });
  return estimate;
};

describe('TrackProposals (KBC-067 on KBC-066)', () => {
  it('shows the estimate and the month before running (BR-3)', async () => {
    const start = vi.fn(() => EMPTY);
    const rendered = await setup({ start });
    (await ask(rendered)).flush(ESTIMATE);
    await rendered.fixture.whenStable();
    expect(screen.getByText(/Custa até US\$\s0,020\./)).toBeTruthy();
    expect(
      screen.getByText(/Este mês: US\$\s1,20 de US\$\s10,00/),
    ).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    expect(start).toHaveBeenCalledOnce();
  });

  const estimated = async (inputs: object) => {
    const rendered = await setup(inputs);
    (await ask(rendered)).flush(ESTIMATE);
    await rendered.fixture.whenStable();
    return rendered;
  };

  it('asks once, and waits for the answer of that press (R-1)', async () => {
    const answer = new Subject<ProposeResult>();
    const start = vi.fn(() => answer);
    const rendered = await estimated({ start });
    const confirm = () =>
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Confirmar e propor',
      });
    fireEvent.click(confirm());
    await rendered.fixture.whenStable();
    expect(confirm().disabled).toBe(true);
    fireEvent.click(confirm());
    expect(start).toHaveBeenCalledOnce();
    answer.next({ kind: 'started' });
    await rendered.fixture.whenStable();
    expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
  });

  it('says what stopped it and lets the person press again (BR-2)', async () => {
    const rendered = await estimated({
      start: () => of({ kind: 'stopped', result: 'failed' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    await rendered.fixture.whenStable();
    expect(
      screen.getByText('Nada foi feito: não consegui salvar a última mudança.'),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Confirmar e propor',
      }).disabled,
    ).toBe(false);
  });

  it('says a restart pays the finished windows again, before the press (KBC-097)', async () => {
    const rendered = await setup();
    (await ask(rendered)).flush({ ...ESTIMATE, restarts: true });
    await rendered.fixture.whenStable();
    expect(screen.getByText(/recomeça do início/)).toBeTruthy();
  });

  it('says nothing of a restart on a plain estimate (KBC-097)', async () => {
    await estimated({});
    expect(screen.queryByText(/recomeça do início/)).toBeNull();
  });

  it('says what a new run may swap, only when there is something to swap (KBC-097)', async () => {
    await estimated({ replaces: true });
    expect(screen.getByText(/As que você editou ou criou ficam/)).toBeTruthy();
  });

  it('confirms the value the person saw (KBC-097)', async () => {
    const start = vi.fn(() => EMPTY);
    await estimated({ start });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    expect(start).toHaveBeenCalledWith(ESTIMATE.estimateUsd);
  });

  it('shows the new value when it rose, and starts nothing until it is confirmed (KBC-097)', async () => {
    const rose = new HttpErrorResponse({
      status: 409,
      error: {
        error: {
          code: 'MEDIA_CONFLICT',
          message: 'The estimate rose',
          details: { reason: 'estimate-rose', estimateUsd: 0.05 },
        },
      },
    });
    const start = vi
      .fn<(usd: number) => Observable<ProposeResult>>()
      .mockReturnValueOnce(of({ kind: 'refused', error: rose }))
      .mockReturnValue(of({ kind: 'started' }));
    const rendered = await estimated({ start });
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    try {
      fireEvent.click(
        screen.getByRole('button', { name: 'Confirmar e propor' }),
      );
      rendered.http.expectOne(URL).flush({ ...ESTIMATE, estimateUsd: 0.05 });
      await rendered.fixture.whenStable();
      // The notice and the actions under it come into view together, clear of the
      // editor's bottom bar on a phone (QA R2-5): the actions are what is scrolled to.
      const actions = screen.getByRole('button', {
        name: 'Confirmar e propor',
      }).parentElement;
      expect(scrolled.mock.contexts.at(-1)).toBe(actions);
    } finally {
      scrolled.mockRestore();
    }
    expect(screen.getByText(/Custa até US\$\s0,050\./)).toBeTruthy();
    // Neutral: a price or a plan may have changed it, not only a save.
    const notice = screen.getByText(
      'O valor mudou. Nada foi gasto: confira o novo valor.',
    );
    // Read before the actions, so a phone shows it above them, not under its bar.
    const confirm = screen.getByRole('button', { name: 'Confirmar e propor' });
    expect(
      notice.compareDocumentPosition(confirm) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(start).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    expect(start).toHaveBeenLastCalledWith(0.05);
  });

  it('ignores a late answer to a press the person cancelled (PD-03, KBC-097)', async () => {
    const answer = new Subject<ProposeResult>();
    const rendered = await estimated({ start: () => answer });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    answer.next({
      kind: 'refused',
      error: new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'MEDIA_CONFLICT',
            message: 'The estimate rose',
            details: { reason: 'estimate-rose', estimateUsd: 0.05 },
          },
        },
      }),
    });
    answer.complete();
    await rendered.fixture.whenStable();
    rendered.http.expectNone(URL);
    expect(screen.queryByText(/O valor mudou/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Propor faixas com IA' }),
    ).toBeTruthy();
  });

  it('takes each answer for its own press: an older one never stands for a newer (PD-03)', async () => {
    const first = new Subject<ProposeResult>();
    const second = new Subject<ProposeResult>();
    const start = vi
      .fn<(usd: number) => Observable<ProposeResult>>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const rendered = await estimated({ start });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    (await ask(rendered)).flush(ESTIMATE);
    await rendered.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    // The first press answers late: it must not take the place of the second.
    first.next({ kind: 'refused', error: new Error('late') });
    first.complete();
    await rendered.fixture.whenStable();
    rendered.http.expectNone(URL);
    expect(
      screen.getByRole('button', { name: 'Confirmar e propor' }),
    ).toHaveProperty('disabled', true);
    // The second press's answer is the one taken.
    second.next({ kind: 'started' });
    second.complete();
    await rendered.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Propor faixas com IA' }),
    ).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('says what the server refused', async () => {
    const rendered = await estimated({
      start: () => of({ kind: 'refused', error: new Error('no') }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    await rendered.fixture.whenStable();
    expect(screen.getByText(/Algo deu errado|Tente de novo/)).toBeTruthy();
  });

  it('shows when the estimate cannot be read, and comes back', async () => {
    const rendered = await setup();
    (await ask(rendered)).flush({}, { status: 500, statusText: 'No' });
    await rendered.fixture.whenStable();
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Propor faixas com IA',
      }).disabled,
    ).toBe(false);
  });

  it('asks nothing while the draft has a conflict (R-3)', async () => {
    await setup({ blocked: true });
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Propor faixas com IA',
      }).disabled,
    ).toBe(true);
  });

  it('says the monthly cap stops it, and offers no way to run (AC-3)', async () => {
    const rendered = await setup();
    (await ask(rendered)).flush({
      ...ESTIMATE,
      allowed: false,
      refusal: 'monthly-cap',
    });
    await rendered.fixture.whenStable();
    expect(
      screen.getByText('O teto mensal da mídia foi atingido.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
  });

  it('shows the windows of a run, then what it cost (FR-4)', async () => {
    const rendered = await setup({ latestRun: RUN });
    expect(screen.getByText(/Propondo… janela 2 de 5/)).toBeTruthy();
    rendered.fixture.componentRef.setInput('latestRun', {
      ...RUN,
      status: 'done',
      spentUsd: 0.02,
    });
    await rendered.fixture.whenStable();
    expect(screen.getByText(/Custou US\$\s0,02/)).toBeTruthy();
  });

  it('says when it could not propose, instead of an older run`s cost (FR-5, R-7)', async () => {
    await setup({
      latestRun: { ...RUN, status: 'done', spentUsd: 0.02 },
      lastFailure: 'provider',
    });
    expect(screen.getByText('Não foi possível propor.')).toBeTruthy();
    expect(screen.queryByText(/Custou/)).toBeNull();
  });

  it('says the most it costs, rounded up, and that it stops there (KBC-112 AC-8, FR-4)', async () => {
    const rendered = await setup();
    (await ask(rendered)).flush({ ...ESTIMATE, estimateUsd: 0.0234 });
    await rendered.fixture.whenStable();
    expect(
      screen.getByText(
        /^Custa até US\$\s0,024\. Se a IA precisar perguntar de novo alguma parte, a análise para nesse valor e você decide se continua\.$/,
      ),
    ).toBeTruthy();
  });

  it('says what was spent with common rounding (KBC-112 AC-8)', async () => {
    await setup({
      latestRun: { ...RUN, status: 'done', spentUsd: 0.0234 },
    });
    expect(screen.getByText('Custou US$ 0,023')).toBeTruthy();
  });

  it('a run stopped at the value says what is ready and what going on costs (KBC-112 AC-2, FR-3, AC-14)', async () => {
    const rendered = await setup({
      latestRun: { ...RUN, status: 'running' },
    });
    rendered.fixture.componentRef.setInput('latestRun', {
      ...RUN,
      status: 'failed',
      failure: 'accepted-limit',
      windowsDone: 7,
      windowsTotal: 9,
    });
    rendered.fixture.componentRef.setInput('lastFailure', 'accepted-limit');
    rendered.fixture.componentRef.setInput('stopped', {
      limitUsd: 0.0234,
      spentUsd: 0.018,
      windowsDone: 7,
      windowsTotal: 9,
    });
    await rendered.fixture.whenStable();
    const going = rendered.http.expectOne(URL);
    expect(going.request.body).toEqual({ dryRun: true });
    going.flush({ ...ESTIMATE, estimateUsd: 0.0051, windows: 2 });
    await rendered.fixture.whenStable();
    expect(
      screen.getByText(
        'A análise parou no valor aceito (US$ 0,024): 7 de 9 janelas prontas. Continuar custa cerca de US$ 0,006.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Não foi possível propor.')).toBeNull();
    const retry = screen.getByRole('button', { name: 'Tentar de novo' });
    expect(document.activeElement).toBe(retry);
    expect(retry.closest('[role="status"]')).toBeTruthy();
    fireEvent.click(retry);
    rendered.http.expectOne(URL).flush({ ...ESTIMATE, estimateUsd: 0.0051 });
    await rendered.fixture.whenStable();
    expect(screen.getByText(/Custa até US\$\s0,006\./)).toBeTruthy();
    // The pressed button went: the focus is on the next action, not lost (PD-01).
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Confirmar e propor' }),
    );
    rendered.http.verify();
  });

  it('a stop without the cost of going on still offers to try again (KBC-112 FR-3)', async () => {
    const rendered = await setup({
      lastFailure: 'accepted-limit',
      stopped: {
        limitUsd: 0.02,
        spentUsd: 0.01,
        windowsDone: 1,
        windowsTotal: 3,
      },
    });
    rendered.http.expectOne(URL).flush(null, {
      status: 503,
      statusText: 'Unavailable',
    });
    await rendered.fixture.whenStable();
    const said = screen.getByText(
      'A análise parou no valor aceito (US$ 0,020): 1 de 3 janelas prontas.',
    );
    // An expected stop, the person decides: said as a notice, not in an error's red.
    expect(said.classList).toContain('stopped');
    expect(said.classList).not.toContain('refusal');
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });
});
