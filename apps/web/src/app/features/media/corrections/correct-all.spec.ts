import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type {
  MediaTranscript,
  Occurrence,
  Occurrences,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackAudition } from '../tracks/track-audition.js';
import { TrackTextSource } from '../tracks/track-text-source.js';
import { CorrectAll, replacementOf } from './correct-all.js';
import { CorrectionDesk } from './correction-desk.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const BASE = `/api/v1/media/${MEDIA}/transcript`;
const GROUP = '33333333-3333-4333-8333-333333333333';

const transcript: MediaTranscript = {
  mediaId: MEDIA,
  version: 1,
  revision: 0,
  confidence: 'normal',
  segments: [],
};

const occurrence = (index: number): Occurrence => ({
  position: index * 10,
  count: 1,
  expected: [index === 0 ? 'Tiuako,' : 'Tiuako'],
  segment: index,
  startMs: 60_000 + index * 10_000,
  endMs: 60_400 + index * 10_000,
  contextBefore: 'o mestre',
  text: index === 0 ? 'Tiuako,' : 'Tiuako',
  contextAfter: 'disse',
  inWindow: index < 3,
});

const preview = (count: number, total = count): Occurrences => ({
  mediaId: MEDIA,
  version: 1,
  revision: 0,
  total,
  inWindow: 3,
  occurrences: Array.from({ length: count }, (_, index) => occurrence(index)),
});

let http: HttpTestingController | null = null;

async function renderAll(window: { startMs: number; endMs: number } | null) {
  // jsdom has no modal dialogs: open is what matters here.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  const source = { transcript: signal(transcript), reload: vi.fn() };
  const view = await render(CorrectAll, {
    inputs: { find: 'Tiuako', window },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      CorrectionDesk,
      { provide: TrackTextSource, useValue: source },
      { provide: TrackAudition, useValue: { play: vi.fn(), seek: vi.fn() } },
    ],
  });
  const controller = TestBed.inject(HttpTestingController);
  http = controller;
  const answer = async (body: Occurrences) => {
    TestBed.tick();
    controller
      .expectOne((one) => one.url === `${BASE}/occurrences`)
      .flush(body);
    await view.fixture.whenStable();
  };
  return { view, source, http: controller, answer };
}

const confirmButton = () =>
  screen.getByRole('button', { name: /^Corrigir \d+ ocorr/ });

afterEach(() => {
  http?.verify();
  http = null;
});

describe('Corrigir todas (KBC-093 FR-11)', () => {
  it('keeps each occurrence its own edge punctuation (BR-11, AC-31)', () => {
    expect(replacementOf('Tiuako,', 'Tiuaco')).toBe('Tiuaco,');
    expect(replacementOf('(tiuako)', 'Tiuaco')).toBe('(Tiuaco)');
    expect(replacementOf('Tiuako', 'Tiuaco')).toBe('Tiuaco');
  });

  it('KBC-106: below a track of the recording, the preview says why instead of failing', async () => {
    const { view, http } = await renderAll(null);
    TestBed.tick();
    http
      .expectOne((one) => one.url === `${BASE}/occurrences`)
      .flush(
        { error: { code: 'EDIT_ABOVE_YOUR_LEVEL', message: 'x' } },
        { status: 403, statusText: 'Forbidden' },
      );
    await view.fixture.whenStable();
    expect(
      screen.getByText(
        'Esta gravação tem faixas acima do seu nível. Só quem tem todos os níveis dela pode editá-la.',
      ),
    ).toBeTruthy();
  });

  it('AC-29, AC-30: starts in this track, all checked; unchecking two counts them out; none disables it', async () => {
    const { answer, view } = await renderAll({
      startMs: 60_000,
      endMs: 90_000,
    });
    await answer(preview(3, 12));
    expect(
      screen.getByRole('radio', { name: 'Nesta faixa (3)' }),
    ).toHaveProperty('checked', true);
    expect(
      screen.getByRole('radio', { name: 'Na gravação inteira (12)' }),
    ).toBeTruthy();
    fireEvent.input(screen.getByRole('textbox', { name: 'Texto certo' }), {
      target: { value: 'Tiuaco' },
    });
    await view.fixture.whenStable();
    // "antes → depois", each with its own punctuation (AC-31).
    expect(
      [...document.querySelectorAll('ins')].map((one) => one.textContent),
    ).toEqual(['Tiuaco,', 'Tiuaco', 'Tiuaco']);
    expect(confirmButton().textContent?.trim()).toBe('Corrigir 3 ocorrências');

    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    await view.fixture.whenStable();
    expect(confirmButton().textContent?.trim()).toBe('Corrigir 1 ocorrência');
    fireEvent.click(screen.getByRole('button', { name: 'Desmarcar todas' }));
    await view.fixture.whenStable();
    expect(confirmButton()).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Marcar todas' }));
    await view.fixture.whenStable();
    expect(confirmButton().textContent?.trim()).toBe('Corrigir 3 ocorrências');
  });

  it('AC-32: says how many are left out past 200', async () => {
    const { answer } = await renderAll(null);
    await answer(preview(200, 340));
    expect(
      screen.getByText(
        /Mostrando 200 de 340; depois de corrigir, repita para as outras./,
      ),
    ).toBeTruthy();
  });

  it('AC-28, AC-33: a changed occurrence comes back unchecked with its text now; then it saves with a new key and offers Desfazer', async () => {
    const { answer, view, http, source } = await renderAll(null);
    await answer(preview(3));
    fireEvent.input(screen.getByRole('textbox', { name: 'Texto certo' }), {
      target: { value: 'Tiuaco' },
    });
    fireEvent.click(confirmButton());
    await view.fixture.whenStable();
    const first = http.expectOne(`${BASE}/corrections/batch`);
    expect(first.request.body).toMatchObject({
      version: 1,
      text: 'Tiuaco',
      items: [
        { position: 0, count: 1, expected: ['Tiuako,'] },
        { position: 10, count: 1, expected: ['Tiuako'] },
        { position: 20, count: 1, expected: ['Tiuako'] },
      ],
    });
    first.flush(
      {
        error: {
          code: 'CORRECTION_CONFLICT',
          message: 'changed',
          details: {
            reason: 'word-changed',
            changed: [{ position: 10, current: 'Tiuacu' }],
          },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await view.fixture.whenStable();

    expect(
      screen.getByText('Mudou desde a prévia: agora diz «Tiuacu».'),
    ).toBeTruthy();
    expect(confirmButton().textContent?.trim()).toBe('Corrigir 2 ocorrências');
    fireEvent.click(confirmButton());
    await view.fixture.whenStable();
    const second = http.expectOne(`${BASE}/corrections/batch`);
    expect(second.request.body.key).not.toBe(first.request.body.key);
    expect(second.request.body.items).toHaveLength(2);
    second.flush(
      { groupId: GROUP, count: 2, version: 1, revision: 1, segments: [] },
      { status: 201, statusText: 'Created' },
    );
    await view.fixture.whenStable();
    expect(source.reload).toHaveBeenCalled();
    http.expectOne(`${BASE}/corrections?cursor=0`).flush({
      mediaId: MEDIA,
      total: 1,
      entries: [],
      next: null,
      carry: null,
    });
    const desk = view.fixture.debugElement.injector.get(CorrectionDesk);
    expect(desk.notice()?.text).toBe('2 ocorrências corrigidas.');
    desk.notice()?.undo?.();
    http
      .expectOne(`${BASE}/corrections/groups/${GROUP}/undo`)
      .flush({ undone: 1, changed: 1, version: 1, revision: 2, segments: [] });
    http.expectOne(`${BASE}/corrections?cursor=0`).flush({
      mediaId: MEDIA,
      total: 2,
      entries: [],
      next: null,
      carry: null,
    });
    expect(desk.notice()?.text).toBe(
      '1 desfeitas; 1 mudaram depois e ficaram como estão.',
    );
  });

  it('AC-34, BR-13: a retry after a failure sends the same key; another text or choice sends a new one', async () => {
    const { answer, view, http } = await renderAll(null);
    await answer(preview(3));
    const field = screen.getByRole('textbox', { name: 'Texto certo' });
    fireEvent.input(field, { target: { value: 'Tiuaco' } });
    const send = async () => {
      fireEvent.click(confirmButton());
      await view.fixture.whenStable();
      return http.expectOne(`${BASE}/corrections/batch`);
    };
    const lost = () => ({ status: 0, statusText: 'Unknown Error' });
    const first = await send();
    first.error(new ProgressEvent('error'), lost());
    await view.fixture.whenStable();
    const retry = await send();
    expect(retry.request.body.key).toBe(first.request.body.key);
    retry.error(new ProgressEvent('error'), lost());
    await view.fixture.whenStable();

    fireEvent.input(field, { target: { value: 'Tiuacu' } });
    const otherText = await send();
    expect(otherText.request.body.key).not.toBe(first.request.body.key);
    otherText.error(new ProgressEvent('error'), lost());
    await view.fixture.whenStable();

    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    const otherChoice = await send();
    expect(otherChoice.request.body.key).not.toBe(otherText.request.body.key);
    expect(otherChoice.request.body.items).toHaveLength(2);
    otherChoice.flush(
      { groupId: GROUP, count: 1, version: 1, revision: 1, segments: [] },
      { status: 200, statusText: 'OK' },
    );
    await view.fixture.whenStable();
    http.expectOne(`${BASE}/corrections?cursor=0`).flush({
      mediaId: MEDIA,
      total: 1,
      entries: [],
      next: null,
      carry: null,
    });
    const desk = view.fixture.debugElement.injector.get(CorrectionDesk);
    expect(desk.notice()?.text).toBe('1 ocorrência corrigida.');
  });

  it('AC-34: a new version says so and nothing is written', async () => {
    const { answer, view, http, source } = await renderAll(null);
    await answer(preview(2));
    fireEvent.input(screen.getByRole('textbox', { name: 'Texto certo' }), {
      target: { value: 'Tiuaco' },
    });
    fireEvent.click(confirmButton());
    await view.fixture.whenStable();
    http
      .expectOne(`${BASE}/corrections/batch`)
      .flush(
        { error: { code: 'TRANSCRIPT_CHANGED', message: 'again' } },
        { status: 412, statusText: 'Precondition Failed' },
      );
    await view.fixture.whenStable();
    expect(
      screen.getByText(
        'A transcrição foi refeita. Confira as ocorrências no texto novo.',
      ),
    ).toBeTruthy();
    expect(source.reload).toHaveBeenCalled();
  });
});
