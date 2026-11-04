import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type { DraftTrack } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import { TrackRowList } from './track-row-list.js';

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
  };
  return render(TrackRowList, {
    providers: [provideZonelessChangeDetection()],
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
    expect(spies.listen).toHaveBeenCalledWith('start');
  });
});
