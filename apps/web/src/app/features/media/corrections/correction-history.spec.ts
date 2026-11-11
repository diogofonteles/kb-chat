import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type {
  CorrectionHistory as History,
  MediaTranscript,
  TranscriptCorrection,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackAudition } from '../tracks/track-audition.js';
import { TrackTextSource } from '../tracks/track-text-source.js';
import { CorrectionDesk } from './correction-desk.js';
import { CorrectionHistory } from './correction-history.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const BASE = `/api/v1/media/${MEDIA}/transcript/corrections`;
const GROUP = '33333333-3333-4333-8333-333333333333';

const transcript: MediaTranscript = {
  mediaId: MEDIA,
  version: 2,
  revision: 0,
  confidence: 'normal',
  segments: [],
};

let ids = 0;
const row = (
  overrides: Partial<TranscriptCorrection> = {},
): TranscriptCorrection => ({
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  kind: 'correct',
  state: 'active',
  learned: false,
  version: 2,
  revision: 1,
  position: 2,
  count: 1,
  segment: 0,
  startMs: 72_000,
  endMs: 73_000,
  before: ['Tiuako'],
  after: 'Tiuaco',
  reverts: null,
  carriedTo: null,
  found: null,
  groupId: null,
  authorName: 'Maria',
  mine: true,
  canUndo: true,
  createdAt: '2026-11-09T12:00:00.000Z',
  ...overrides,
});

const historyOf = (entries: History['entries']): History => ({
  mediaId: MEDIA,
  total: entries.length,
  entries,
  next: null,
  carry: null,
});

let http: HttpTestingController | null = null;

async function renderHistory(page: History) {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  const view = await render(CorrectionHistory, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      CorrectionDesk,
      {
        provide: TrackTextSource,
        useValue: { transcript: signal(transcript), reload: vi.fn() },
      },
      { provide: TrackAudition, useValue: { play: vi.fn(), seek: vi.fn() } },
    ],
  });
  const controller = TestBed.inject(HttpTestingController);
  http = controller;
  const desk = view.fixture.debugElement.injector.get(CorrectionDesk);
  desk.loadHistory();
  controller.expectOne(`${BASE}?cursor=0`).flush(page);
  await view.fixture.whenStable();
  return { view, http: controller, desk };
}

afterEach(() => {
  http?.verify();
  http = null;
});

describe('Correções (KBC-093 FR-9, FR-13)', () => {
  it('KBC-113 FR-6: a learned group is named as the learning, with Desfazer o grupo', async () => {
    const group = '33333333-3333-4333-8333-333333333333';
    const learned = (position: number) =>
      row({
        learned: true,
        groupId: group,
        position,
        before: ['a', 'Manta'],
        after: 'Atlântida',
        authorName: 'Aprendizado das correções',
        mine: false,
      });
    await renderHistory(
      historyOf([
        { groupId: group, items: [learned(2), learned(9)], canUndoGroup: true },
      ]),
    );
    expect(screen.getByText('Aprendizado:')).toBeTruthy();
    expect(screen.getAllByText('Corrigida pelo aprendizado')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Desfazer o grupo' }),
    ).toBeTruthy();
  });

  it('says when there is none', async () => {
    await renderHistory(historyOf([]));
    expect(screen.getByText('Nenhuma correção nesta gravação.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Correções' })).toBeTruthy();
  });

  it('AC-17: Desfazer only where the person may; an undo that met a later change says so (AC-11)', async () => {
    const mine = row();
    const theirs = row({ mine: false, canUndo: false, authorName: 'João' });
    const { view, http } = await renderHistory(
      historyOf([
        { groupId: null, items: [mine], canUndoGroup: false },
        { groupId: null, items: [theirs], canUndoGroup: false },
      ]),
    );
    const entries = screen.getAllByRole('listitem');
    expect(
      within(entries[0] as HTMLElement).queryByRole('button', {
        name: 'Desfazer',
      }),
    ).toBeTruthy();
    expect(
      within(entries[1] as HTMLElement).queryByRole('button', {
        name: 'Desfazer',
      }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    await view.fixture.whenStable();
    http.expectOne(`${BASE}/${mine.id}/undo`).flush(
      {
        error: {
          code: 'CORRECTION_CONFLICT',
          message: 'changed',
          details: { reason: 'changed-since', current: ['Tiuacu'] },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await view.fixture.whenStable();
    // Shown, and said by the live region.
    expect(
      screen.getAllByText(
        'Esta palavra mudou depois: agora diz «Tiuacu». Corrija à mão se precisar.',
      ),
    ).toHaveLength(2);
  });

  it('AC-35: a group is one line that opens on its occurrences, with Desfazer o grupo', async () => {
    const items = Array.from({ length: 12 }, () => row({ groupId: GROUP }));
    const { view, http, desk } = await renderHistory(
      historyOf([{ groupId: GROUP, items, canUndoGroup: true }]),
    );
    expect(screen.getByText('12 ocorrências')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer o grupo' }));
    await view.fixture.whenStable();
    http
      .expectOne(`${BASE}/groups/${GROUP}/undo`)
      .flush({ undone: 10, changed: 2, version: 2, revision: 2, segments: [] });
    http.expectOne(`${BASE}?cursor=0`).flush(historyOf([]));
    await view.fixture.whenStable();
    expect(desk.notice()?.text).toBe(
      '10 desfeitas; 2 mudaram depois e ficaram como estão.',
    );
  });

  it('PD-02: a double click on Desfazer o grupo or Desfazer sends one request', async () => {
    const items = Array.from({ length: 12 }, () => row({ groupId: GROUP }));
    const single = row();
    const { view, http, desk } = await renderHistory(
      historyOf([
        { groupId: GROUP, items, canUndoGroup: true },
        { groupId: null, items: [single], canUndoGroup: false },
      ]),
    );
    const group = screen.getByRole('button', { name: 'Desfazer o grupo' });
    fireEvent.click(group);
    fireEvent.click(group);
    await view.fixture.whenStable();
    expect(group).toHaveProperty('disabled', true);
    http
      .expectOne(`${BASE}/groups/${GROUP}/undo`)
      .flush({ undone: 12, changed: 0, version: 2, revision: 2, segments: [] });
    http.expectOne(`${BASE}?cursor=0`).flush(historyOf([]));
    await view.fixture.whenStable();
    expect(desk.notice()?.text).toBe('12 desfeitas.');

    desk.undo(single.id);
    desk.undo(single.id);
    http.expectOne(`${BASE}/${single.id}/undo`).flush({
      correction: null,
      version: 2,
      revision: 3,
      segments: [],
    });
    http.expectOne(`${BASE}?cursor=0`).flush(historyOf([]));
  });

  it('PD-03: an older answer to the history never overwrites a newer one', async () => {
    const { view, http, desk } = await renderHistory(historyOf([]));
    desk.loadHistory();
    desk.loadHistory();
    const [older, newer] = http.match(`${BASE}?cursor=0`);
    expect(older?.cancelled).toBe(true);
    newer?.flush({
      ...historyOf([]),
      total: 3,
      carry: { version: 2, carried: 1, notCarried: 0 },
    });
    await view.fixture.whenStable();
    expect(desk.history()?.total).toBe(3);
    expect(desk.history()?.carry).toEqual({
      version: 2,
      carried: 1,
      notCarried: 0,
    });
  });

  it('AC-19, FR-8: a correction not carried says what the new version has, with Corrigir aqui', async () => {
    const lost = row({
      state: 'not-carried',
      canUndo: false,
      before: ['Mariri'],
      after: 'Mariri,',
      found: 'Mareri',
      version: 1,
    });
    const { view } = await renderHistory(
      historyOf([{ groupId: null, items: [lost], canUndoGroup: false }]),
    );
    const fixHere = vi.fn();
    view.fixture.componentInstance.fixHere.subscribe(fixHere);
    expect(
      screen.getByText('Não reaplicada: a transcrição nova diz «Mareri».'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Corrigir aqui' }));
    expect(fixHere).toHaveBeenCalledWith(lost);
  });
});
