import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { LOCALE_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { ProposalEstimate, ProposalRun } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { MEDIA_POLL_MS } from '../media-polling.js';
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
  month: { spentUsd: 1.2, capUsd: 10 },
};

async function setup(inputs: object = {}) {
  const rendered = await render(TrackProposals, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_POLL_MS, useValue: 5 },
      { provide: LOCALE_ID, useValue: 'pt-BR' },
    ],
    inputs: { mediaId: MEDIA, topic: 'hermetismo', ...inputs },
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
    const rendered = await setup();
    (await ask(rendered)).flush(ESTIMATE);
    await rendered.fixture.whenStable();
    expect(screen.getByText(/Custa cerca de US\$\s0,02/)).toBeTruthy();
    expect(
      screen.getByText(/Este mês: US\$\s1,20 de US\$\s10,00/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e propor' }));
    const run = rendered.http.expectOne(URL);
    expect(run.request.body).toEqual({ dryRun: false });
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

  it('follows a run and shows what it cost (FR-4)', async () => {
    const rendered = await setup({ latestRun: RUN });
    let changes = 0;
    rendered.fixture.componentInstance.changed.subscribe(() => (changes += 1));
    expect(screen.getByText(/Propondo… janela 2 de 5/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    rendered.http
      .match(`${URL}/${RUN.id}`)
      .at(-1)
      ?.flush({ ...RUN, status: 'done', spentUsd: 0.02 });
    await rendered.fixture.whenStable();
    expect(changes).toBe(1);
    expect(screen.getByText(/Custou US\$\s0,02/)).toBeTruthy();
  });

  it('says when it could not propose (FR-5)', async () => {
    await setup({ latestRun: { ...RUN, status: 'failed' } });
    expect(screen.getByText('Não foi possível propor.')).toBeTruthy();
  });

  it('accepts a name, registering a new speaker (BR-5, FR-3)', async () => {
    const rendered = await setup({
      separation: 3,
      suggestions: [
        {
          voice: 1,
          name: 'Mestre Gabriel',
          audience: false,
          reason: 'é o autor do áudio',
        },
      ],
    });
    expect(screen.getByText(/é o autor do áudio/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar' }));
    const id = '33333333-3333-4333-8333-333333333333';
    rendered.http.expectOne('/api/v1/topics/hermetismo/speakers').flush({
      id,
      name: 'Mestre Gabriel',
      authorSlug: null,
      main: false,
    });
    const named = rendered.http.expectOne(`/api/v1/media/${MEDIA}/voices/1`);
    expect(named.request.body).toEqual({
      version: 3,
      speakerId: id,
      audience: false,
    });
  });
});
