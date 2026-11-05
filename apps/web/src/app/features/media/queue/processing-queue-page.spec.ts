import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import type { MediaPreparation, ProcessingQueue } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ChatStore } from '@features/chat/chat-store.js';
import { sessionAs } from '../../../testing/media-fixtures.js';
import {
  MEDIA_ID,
  aPreparation,
  aQueue,
  aQueueItem,
} from '../../../testing/preparation-fixtures.js';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { ProcessingQueuePage } from './processing-queue-page.js';

const URL = '/api/v1/media/processing';
const PLAN = `/api/v1/media/${MEDIA_ID}/preparation`;
const wait = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(
  queue: ProcessingQueue | 'fails',
  features: ('media' | 'media-upload' | 'media-edit')[] = [
    'media',
    'media-upload',
    'media-edit',
  ],
) {
  const rendered = await render(ProcessingQueuePage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: '**', children: [] }]),
      { provide: MEDIA_POLL_MS, useValue: 60_000 },
      sessionAs({ features }),
      {
        provide: ChatStore,
        useValue: {
          topicList: signal([{ slug: 'hermetismo', title: 'Hermetismo' }]),
        },
      },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  await settle(rendered.fixture);
  http
    .match(URL)
    .forEach((one) =>
      queue === 'fails'
        ? one.flush('', { status: 500, statusText: 'x' })
        : one.flush(queue),
    );
  await settle(rendered.fixture);
  return { ...rendered, http };
}

async function settle(fixture: { whenStable(): Promise<unknown> }) {
  await wait();
  await fixture.whenStable();
}

describe('ProcessingQueuePage (T30, KBC-090)', () => {
  it('says plainly when nothing is being processed', async () => {
    await open(aQueue());
    expect(screen.getByText('Nada sendo processado agora.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Ir para a Biblioteca' }),
    ).toBeTruthy();
  });

  it('offers to try again when the first read fails', async () => {
    const { http, fixture } = await open('fails');
    screen.getByRole('button', { name: 'Tentar de novo' }).click();
    await settle(fixture);
    http.expectOne(URL).flush(aQueue());
    await settle(fixture);
    expect(screen.getByText('Nada sendo processado agora.')).toBeTruthy();
  });

  it('separates what needs a person, what runs and what is next', async () => {
    await open(
      aQueue({
        active: 2,
        items: [
          aQueueItem({ title: 'Roda agora' }),
          aQueueItem({
            mediaId: '22222222-2222-4222-8222-222222222222',
            title: 'Vem depois',
            phase: 'next',
            state: 'queued',
            percent: null,
            cuts: null,
            position: 2,
          }),
          aQueueItem({
            mediaId: '33333333-3333-4333-8333-333333333333',
            title: 'Parou',
            phase: 'attention',
            state: 'failed',
            stage: 'speakers',
            failure: 'work',
            action: 'retry',
            retryStage: 'speakers',
            nextStage: null,
          }),
        ],
      }),
    );
    const now = screen.getByRole('region', { name: 'Agora' });
    expect(within(now).getByRole('link', { name: 'Roda agora' })).toBeTruthy();
    expect(
      within(now).getByRole('progressbar').getAttribute('aria-valuenow'),
    ).toBe('35');
    expect(now.textContent).toContain('(cortes 14 de 40)');
    expect(now.textContent).toContain('Depois: Vozes');
    const next = screen.getByRole('region', { name: 'A seguir' });
    expect(next.textContent).toContain('2º na fila');
    const attention = screen.getByRole('region', { name: 'Precisa de você' });
    expect(
      within(attention).getByRole('button', { name: 'Tentar de novo' }),
    ).toBeTruthy();
  });

  it('says the transcriber is off when that is why nothing moves', async () => {
    await open(
      aQueue({
        active: 1,
        transcriber: 'off',
        transcriberOffSince: '2026-11-04T15:00:00.000Z',
        items: [
          aQueueItem({
            phase: 'next',
            state: 'queued',
            percent: null,
            cuts: null,
            waitsForTranscriber: true,
            position: 1,
          }),
        ],
      }),
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Aguardando o transcritor',
    );
    expect(
      screen.getByRole('region', { name: 'A seguir' }).textContent,
    ).toContain('aguardando o transcritor');
  });

  it('retries where it is, once for two presses, and keeps the focus on the row', async () => {
    const failed = aQueueItem({
      phase: 'attention',
      state: 'failed',
      stage: 'speakers',
      failure: 'work',
      action: 'retry',
      retryStage: 'speakers',
    });
    const { http, fixture } = await open(aQueue({ items: [failed] }));
    const retry = screen.getByRole('button', { name: 'Tentar de novo' });
    retry.click();
    retry.click();
    const [call, ...more] = http.match(`${PLAN}/steps/speakers/retry`);
    expect(more).toHaveLength(0);
    call?.flush(aPreparation());
    await settle(fixture);
    http
      .expectOne(URL)
      .flush(
        aQueue({ active: 1, items: [aQueueItem({ title: failed.title })] }),
      );
    await settle(fixture);
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: failed.title }),
    );
  });

  it('never retries the paid stage from here: it leads to where the value shows', async () => {
    await open(
      aQueue({
        items: [
          aQueueItem({
            phase: 'attention',
            state: 'failed',
            stage: 'tracks',
            action: 'retry',
            retryStage: 'tracks',
          }),
        ],
      }),
    );
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    const link = screen.getByRole('link', { name: 'Tentar de novo' });
    expect(link.getAttribute('href')).toBe(`/midia/${MEDIA_ID}/preparar`);
  });

  it('"Validar faixas" moves on and opens step 3', async () => {
    const { http, fixture } = await open(
      aQueue({
        items: [
          aQueueItem({
            phase: 'attention',
            stage: null,
            state: null,
            action: 'validate',
          }),
        ],
      }),
    );
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    screen.getByRole('button', { name: 'Validar faixas' }).click();
    const answer: MediaPreparation = aPreparation({ step: 3 });
    http.expectOne(`${PLAN}/advance`).flush(answer);
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(`/midia/${MEDIA_ID}/faixas`);
  });

  it('says what went wrong with a press, and the row stays', async () => {
    const { http, fixture } = await open(
      aQueue({
        items: [
          aQueueItem({
            phase: 'attention',
            stage: null,
            state: null,
            action: 'conclude',
          }),
        ],
      }),
    );
    screen.getByRole('button', { name: 'Concluir' }).click();
    http
      .expectOne(`${PLAN}/advance`)
      .flush(
        { error: { code: 'INTERNAL', message: 'x' } },
        { status: 500, statusText: 'x' },
      );
    await settle(fixture);
    expect(screen.getByRole('alert').textContent?.length).toBeGreaterThan(0);
  });

  it('continues on step 3 at the editor, and without "media-edit" leads to the audio', async () => {
    const onStep3 = aQueueItem({
      phase: 'attention',
      stage: null,
      state: null,
      step: 3,
      action: 'continue',
    });
    await open(aQueue({ items: [onStep3] }));
    expect(
      screen.getByRole('link', { name: 'Continuar' }).getAttribute('href'),
    ).toBe(`/midia/${MEDIA_ID}/faixas`);
  });

  it('leads to the audio page for who cannot open plans', async () => {
    await open(aQueue({ active: 1, items: [aQueueItem()] }), [
      'media',
      'media-upload',
    ]);
    expect(
      screen
        .getByRole('link', { name: 'Palestra de 1998' })
        .getAttribute('href'),
    ).toBe(`/midia/${MEDIA_ID}`);
  });
});
