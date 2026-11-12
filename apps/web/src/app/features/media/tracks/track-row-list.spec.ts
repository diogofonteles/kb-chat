import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type { DraftTrack } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import { TrackAudition } from './track-audition.js';
import { TrackRowList } from './track-row-list.js';
import { TrackTextSource } from './track-text-source.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';

const track = (n: number, startMs: number, endMs: number): DraftTrack => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  runId: null,
  source: 'manual',
  edited: false,
  firstSegment: null,
  lastSegment: null,
  startMs,
  endMs,
  kind: 'qa',
  title: `Faixa ${n}`,
  askerVoice: null,
  answererVoice: null,
  askerSpeakerId: null,
  answererSpeakerId: null,
  level: null,
});

const ONE = { track: track(1, 0, 9_000), ordinal: 1 };
const TWO = {
  track: { ...track(2, 9_000, 30_000), source: 'ai' as const },
  ordinal: 2,
};
const IDS = { one: ONE.track.id, two: TWO.track.id };

function setup(selectedId: string, extra: object = {}) {
  const spies = {
    selectTrack: vi.fn(),
    titleChange: vi.fn(),
    kindChange: vi.fn(),
    personChange: vi.fn(),
    split: vi.fn(),
    join: vi.fn(),
    remove: vi.fn(),
    listen: vi.fn(),
    listenKey: vi.fn(),
    stopPlaying: vi.fn(),
    levelChange: vi.fn(),
  };
  return render(TrackRowList, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      TrackTextSource,
      { provide: TrackAudition, useValue: { positionMs: signal(null) } },
    ],
    inputs: {
      tracks: [ONE, TWO],
      selectedId,
      people: [{ value: 'v1', label: 'Voz 1' }],
      ...extra,
    },
    on: spies,
  }).then((rendered) => ({ ...rendered, spies }));
}

describe('TrackRowList (KBC-066)', () => {
  it('has one Tab stop; the arrows move and only the selected row has its fields', async () => {
    const { spies } = await setup(IDS.one);
    const buttons = screen
      .getAllByRole('listitem')
      .map((row) => within(row).getAllByRole('button')[0]);
    expect(buttons[0]?.tabIndex).toBe(0);
    expect(buttons[1]?.tabIndex).toBe(-1);
    expect(screen.getAllByRole('textbox', { name: 'Título' })).toHaveLength(1);
    fireEvent.keyDown(buttons[0] as HTMLElement, { key: 'ArrowDown' });
    expect(spies.selectTrack).toHaveBeenCalledWith(IDS.two);
  });

  it('says who made each track, in words (UP-20)', async () => {
    await setup(IDS.one);
    expect(screen.getByText('Proposta pela IA')).toBeTruthy();
    expect(screen.getByText('Criada por você')).toBeTruthy();
  });

  it('saves a title on Enter and goes back on Esc (FR-6)', async () => {
    const { spies } = await setup(IDS.one);
    const field = screen.getByRole('textbox', {
      name: 'Título',
    }) as HTMLInputElement;
    field.value = 'Novo';
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);
    expect(spies.titleChange).not.toHaveBeenCalled();
    expect(field.value).toBe('Faixa 1');
    field.value = 'Novo';
    fireEvent.blur(field);
    expect(spies.titleChange).toHaveBeenCalledWith({
      id: IDS.one,
      title: 'Novo',
    });
  });

  it('offers no division on a track of 9 s (AC-5) and one on longer tracks', async () => {
    const { spies } = await setup(IDS.one);
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações da faixa' }),
    );
    expect(screen.queryByRole('menuitem', { name: 'Dividir aqui' })).toBeNull();
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Juntar com a próxima' }),
    );
    expect(spies.join).toHaveBeenCalledWith(IDS.one);
  });

  it('has no "Juntar" on the last track, and divides a long one', async () => {
    const { spies } = await setup(IDS.two);
    fireEvent.click(
      screen.getByRole('button', { name: 'Mais ações da faixa' }),
    );
    expect(screen.queryByRole('menuitem', { name: /Juntar/ })).toBeNull();
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Dividir aqui' }),
    );
    expect(spies.split).toHaveBeenCalledWith(IDS.two);
  });

  it('marks a problem with an icon and text, and changes kind and people', async () => {
    const { spies } = await setup(IDS.one, {
      problems: [{ trackId: IDS.one, ordinal: 1, problem: 'title' }],
    });
    expect(screen.getByText('Sem título')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Tipo' }), {
      target: { value: 'talk' },
    });
    expect(spies.kindChange).toHaveBeenCalledWith({
      id: IDS.one,
      kind: 'talk',
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Quem pergunta' }), {
      target: { value: 'v1' },
    });
    expect(spies.personChange).toHaveBeenCalledWith({
      id: IDS.one,
      field: 'asker',
      value: 'v1',
    });
  });

  it('listens from a row with the keys of FR-5', async () => {
    const { spies } = await setup(IDS.one);
    const row = screen
      .getAllByRole('listitem')
      .map((one) => within(one).getAllByRole('button')[0])[1] as HTMLElement;
    fireEvent.keyDown(row, { key: 'i' });
    expect(spies.selectTrack).toHaveBeenCalledWith(IDS.two);
    expect(spies.listenKey).toHaveBeenCalledWith('start');
  });

  it('turns only the button that plays into a stop, in words', async () => {
    const { spies } = await setup(IDS.one, { playing: 'start' });
    const stop = screen.getByRole('button', { name: 'Parar o início' });
    expect(stop.textContent).toContain('Parar o início');
    expect(screen.getByRole('button', { name: '▶ Ouvir' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ouvir o fim' })).toBeTruthy();
    fireEvent.click(stop);
    expect(spies.listen).toHaveBeenCalledWith('start');
  });

  it('offers to stop what another row plays', async () => {
    const { spies } = await setup(IDS.one, { playingElsewhere: true });
    fireEvent.click(
      screen.getByRole('button', { name: '■ Parar o que está tocando' }),
    );
    expect(spies.stopPlaying).toHaveBeenCalled();
  });

  it('says "■ Parar" on the track that plays', async () => {
    await setup(IDS.one, { playing: 'track' });
    expect(screen.getByRole('button', { name: '■ Parar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '▶ Ouvir' })).toBeNull();
  });

  it('shows the selected track’s text below its fields (AC-4, FR-2)', async () => {
    const { fixture } = await setup(IDS.two);
    TestBed.inject(TrackTextSource).follow(
      signal({ mediaId: MEDIA, status: 'done', key: '1' }),
    );
    TestBed.tick();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`/api/v1/media/${MEDIA}/transcript?v=1`).flush({
      mediaId: MEDIA,
      version: 1,
      confidence: 'normal',
      segments: [
        { startMs: 2_000, endMs: 4_000, text: 'antes da faixa' },
        { startMs: 12_000, endMs: 14_000, text: 'a segunda faixa fala' },
      ],
    });
    await fixture.whenStable();
    http
      .match(() => true)
      .forEach((one) => one.flush({ mediaId: MEDIA, version: 1, words: [] }));
    await fixture.whenStable();
    const texts = screen.getAllByRole('region', { name: /^Texto da faixa/ });
    expect(texts.map((one) => one.getAttribute('aria-label'))).toEqual([
      'Texto da faixa 2',
    ]);
    expect(texts[0]?.textContent).toContain('a segunda faixa fala');
    expect(texts[0]?.textContent).not.toContain('antes da faixa');
    // Below the fields (FR-2): after the actions in the row.
    const row = texts[0]?.closest('li');
    const fields = row?.querySelector('.fields');
    expect(
      fields &&
        texts[0] &&
        fields.compareDocumentPosition(texts[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows the text alone, to read, while proposals lock editing (AC-7)', async () => {
    await setup(IDS.one, { readOnly: true });
    expect(screen.queryByRole('textbox', { name: 'Título' })).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Texto da faixa 1' }),
    ).toBeTruthy();
  });

  it("offers the recording's level first and the levels above it, and says a track's own (KBC-106 FR-5)", async () => {
    const levels = {
      recording: { id: 'ci', code: 'CI' },
      choices: [{ id: 'cdc', code: 'CDC' }],
    };
    const { spies, rerender } = await setup(IDS.one, { levels });
    const field = screen.getByRole('combobox', { name: 'Nível' });
    expect(
      [...(field as HTMLSelectElement).options].map((one) => one.text.trim()),
    ).toEqual(['O da gravação (CI)', 'CDC']);
    fireEvent.change(field, { target: { value: 'cdc' } });
    expect(spies.levelChange).toHaveBeenCalledWith({
      id: IDS.one,
      level: 'cdc',
    });
    fireEvent.change(field, { target: { value: '' } });
    expect(spies.levelChange).toHaveBeenLastCalledWith({
      id: IDS.one,
      level: null,
    });
    await rerender({
      inputs: {
        tracks: [{ ...ONE, track: { ...ONE.track, level: 'cdc' } }, TWO],
        selectedId: IDS.one,
        levels,
      },
      partialUpdate: true,
    });
    expect(screen.getByText('Nível: CDC')).toBeTruthy();
  });

  it('has no "Nível" without levels', async () => {
    await setup(IDS.one);
    expect(screen.queryByRole('combobox', { name: 'Nível' })).toBeNull();
  });
});
