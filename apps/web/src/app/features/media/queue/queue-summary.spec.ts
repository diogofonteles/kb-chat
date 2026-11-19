import {
  DestroyRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { aQueueItem, MEDIA_ID } from '../../../testing/preparation-fixtures.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  UploadsInFlight,
  type UploadInFlight,
} from '@core/media/uploads-in-flight.js';
import { ProcessingQueueStore } from './processing-queue-store.js';
import { QueueSummary } from './queue-summary.js';

const item = (n: number) =>
  aQueueItem({ mediaId: `${MEDIA_ID}${n}`, title: `Áudio ${n}` });

/** The phone's single card: shown only on a phone, so not in the accessible tree here. */
const phoneCard = () =>
  screen
    .getAllByRole('link', { hidden: true })
    .find(
      (link) =>
        link.getAttribute('href') === '/fila' &&
        link.textContent?.trim() !== 'Ver a fila',
    );

async function setup(
  items: ReturnType<typeof item>[],
  active: number,
  {
    transcriber = 'on',
    scope = null,
  }: {
    readonly transcriber?: 'on' | 'off';
    readonly scope?: ReadonlySet<string> | null;
  } = {},
) {
  return render(QueueSummary, {
    inputs: { scope },
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ProcessingQueueStore,
        useValue: {
          items: signal(items),
          active: signal(active),
          queue: signal({ items, active, transcriber }),
          refresh: () => undefined,
        },
      },
      { provide: SessionStore, useValue: { can: () => true } },
    ],
  });
}

describe('QueueSummary (KBC-090)', () => {
  it('shows nothing with nothing in the queue', async () => {
    const { container } = await setup([], 0);
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows the first ones, how many more, and the way to the queue', async () => {
    await setup([item(1), item(2), item(3), item(4)], 2);
    expect(
      screen.getByRole('heading', { name: '2 áudios em processamento' }),
    ).toBeTruthy();
    expect(screen.getByText('Áudio 3')).toBeTruthy();
    expect(screen.queryByText('Áudio 4')).toBeNull();
    // The rest is a tap away in "Ver a fila" (media-library: no count under the cards).
    expect(screen.getByRole('link', { name: 'Ver a fila' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver a fila' })).toBeTruthy();
  });

  it('puts what needs the person first, and leaves out what is not theirs', async () => {
    await setup(
      [
        item(1),
        item(2),
        item(3),
        { ...item(4), phase: 'attention' },
        { ...item(5), phase: 'stopped' },
      ],
      3,
    );
    expect(screen.getByText('Áudio 4')).toBeTruthy();
    expect(screen.queryByText('Áudio 5')).toBeNull();
    // The rest is a tap away in "Ver a fila" (media-library: no count under the cards).
    expect(screen.getByRole('link', { name: 'Ver a fila' })).toBeTruthy();
  });

  it('counts one in the singular', async () => {
    await setup([item(1)], 1);
    expect(
      screen.getByRole('heading', { name: '1 áudio em processamento' }),
    ).toBeTruthy();
  });

  it('says when only a person is awaited', async () => {
    await setup([item(1)], 0);
    expect(screen.getByText('Precisa da sua atenção')).toBeTruthy();
  });

  it('gives each audio its state in a word and its direct action (KBC-128 FR-2)', async () => {
    await setup(
      [
        { ...item(1), phase: 'attention', state: 'failed', action: null },
        { ...item(2), waitsForTranscriber: true, action: null },
        { ...item(3), phase: 'attention', action: 'validate', step: 3 },
      ],
      1,
    );
    expect(screen.getByText('Falhou')).toBeTruthy();
    expect(screen.getByText('Aguardando')).toBeTruthy();
    expect(screen.getByText('Falta validar as faixas')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Ver detalhes: Áudio 1' }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Validar: Áudio 3' })
        .getAttribute('href'),
    ).toContain(MEDIA_ID + '3');
  });

  it('says each card in a few words: the stage that failed, the transcriber off, the tracks to validate (media-library)', async () => {
    await setup(
      [
        {
          ...item(1),
          phase: 'attention',
          state: 'failed',
          stage: 'convert',
          action: null,
        },
        { ...item(2), waitsForTranscriber: true, action: null },
        { ...item(3), phase: 'attention', action: 'validate', step: 3 },
      ],
      1,
      { transcriber: 'off' },
    );
    expect(screen.getByText('conversão')).toBeTruthy();
    expect(screen.getByText('transcritor desligado')).toBeTruthy();
    expect(screen.getByText('Falta validar as faixas')).toBeTruthy();
  });

  it('says why a failure with its own reason failed, in its short words (owner, 2026-11-18)', async () => {
    await setup(
      [
        {
          ...item(1),
          phase: 'attention',
          state: 'failed',
          stage: 'tracks',
          failure: 'estimate-rose',
          action: 'retry',
        },
      ],
      0,
    );
    expect(
      screen.getByText(
        'Faixas com IA: A estimativa de custo subiu e a análise não rodou. Nada foi cobrado.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Tentar de novo: Áudio 1' }),
    ).toBeTruthy();
  });

  it('offers Groq to an audio waiting for the transcriber when Groq may take it (KBC-128 AC-2)', async () => {
    await setup(
      [
        { ...item(1), phase: 'next', waitsForTranscriber: true },
        {
          ...item(2),
          phase: 'next',
          waitsForTranscriber: true,
          canUseGroq: true,
        },
      ],
      2,
    );
    expect(
      screen.getByRole('button', { name: 'Transcrever com Groq: Áudio 2' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: 'Ver detalhes: Áudio 2' }),
    ).toBeNull();
    // Without Groq, the way stays the audio's page.
    expect(
      screen.getByRole('link', { name: 'Ver detalhes: Áudio 1' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Transcrever com Groq: Áudio 1' }),
    ).toBeNull();
  });

  it('sums everything up in one way to the queue for a phone (media-library@mobile)', async () => {
    await setup(
      [
        { ...item(1), phase: 'attention', state: 'failed', action: 'retry' },
        { ...item(2), phase: 'next', waitsForTranscriber: true },
        { ...item(3), phase: 'attention', action: 'validate', step: 3 },
      ],
      0,
    );
    const compact = phoneCard();
    expect(compact?.textContent).toMatch(/3 itens precisam de atenção/);
    expect(compact?.getAttribute('href')).toBe('/fila');
    expect(compact?.textContent).toContain(
      '1 para validar · 1 falhou · 1 aguardando',
    );
  });

  it('counts what is at work in the phone summary', async () => {
    await setup([item(1), { ...item(2), phase: 'next' }], 2);
    const compact = phoneCard();
    expect(compact?.textContent).toMatch(/2 áudios em processamento/);
    expect(compact?.textContent).toContain('2 em processamento');
  });
});

describe('QueueSummary: what this browser sends (v2 media-upload-sending)', () => {
  it('counts it among those at work and shows it first, how far it has gone', async () => {
    const view = await setup([{ ...item(1), phase: 'attention' }], 0);
    const panel = signal<readonly UploadInFlight[]>([
      {
        key: 'panel-1',
        title: 'Palestra',
        topic: 'hermetismo',
        loaded: 25,
        total: 100,
      },
    ]);
    TestBed.inject(UploadsInFlight).register(panel, TestBed.inject(DestroyRef));
    await view.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: '1 áudio em processamento' }),
    ).toBeTruthy();
    const cards = screen.getAllByRole('listitem');
    expect(cards[0]?.textContent).toContain('Palestra');
    expect(cards[0]?.textContent).toContain('Enviando · 25%');
    panel.set([]);
    await view.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: 'Precisa da sua atenção' }),
    ).toBeTruthy();
  });
});

describe("QueueSummary: only the library's collections (owner, 2026-11-19)", () => {
  const inA = (n: number, phase: 'running' | 'next' | 'attention') => ({
    ...item(n),
    topic: 'udv',
    phase,
  });
  const inB = (n: number, phase: 'running' | 'next' | 'attention') => ({
    ...item(n),
    topic: 'hermetismo',
    phase,
  });
  const twoCollections = [
    inA(1, 'running'),
    inB(2, 'running'),
    inB(3, 'next'),
    { ...inA(4, 'next'), topic: 'udv/hinos' },
    inB(5, 'attention'),
  ];
  const cardTitles = () =>
    screen.getAllByRole('listitem').map((card) => card.textContent ?? '');

  it("shows only the scope's cards and counts only its audios at work", async () => {
    // The server counts all four at work; two of them are Hermetismo's.
    await setup(twoCollections, 4, { scope: new Set(['udv']) });
    expect(
      screen.getByRole('heading', { name: '1 áudio em processamento' }),
    ).toBeTruthy();
    expect(screen.getByText('Áudio 1')).toBeTruthy();
    for (const other of ['Áudio 2', 'Áudio 3', 'Áudio 4', 'Áudio 5'])
      expect(screen.queryByText(other)).toBeNull();
    expect(cardTitles()).toHaveLength(1);
  });

  it("takes in the scope's sub-collections", async () => {
    await setup(twoCollections, 4, { scope: new Set(['udv', 'udv/hinos']) });
    expect(
      screen.getByRole('heading', { name: '2 áudios em processamento' }),
    ).toBeTruthy();
    expect(screen.getByText('Áudio 1')).toBeTruthy();
    expect(screen.getByText('Áudio 4')).toBeTruthy();
    expect(screen.queryByText('Áudio 2')).toBeNull();
  });

  it("shows every collection's with no scope (Todas as mídias)", async () => {
    await setup(twoCollections, 4, { scope: null });
    expect(
      screen.getByRole('heading', { name: '4 áudios em processamento' }),
    ).toBeTruthy();
    expect(screen.getByText('Áudio 5')).toBeTruthy();
    expect(screen.getByText('Áudio 2')).toBeTruthy();
  });

  it('shows nothing while the choices are not known yet (an empty scope)', async () => {
    const { container } = await setup(twoCollections, 4, { scope: new Set() });
    expect(container.querySelector('section')).toBeNull();
  });

  it('leaves out, and does not count, what this browser sends to another collection', async () => {
    const view = await setup([inA(1, 'running')], 1, {
      scope: new Set(['udv']),
    });
    const panel = signal<readonly UploadInFlight[]>([
      {
        key: 'panel-1',
        title: 'Palestra de Hermetismo',
        topic: 'hermetismo',
        loaded: 10,
        total: 100,
      },
      {
        key: 'panel-2',
        title: 'Hino da UDV',
        topic: 'udv',
        loaded: 50,
        total: 100,
      },
    ]);
    TestBed.inject(UploadsInFlight).register(panel, TestBed.inject(DestroyRef));
    await view.fixture.whenStable();
    expect(
      screen.getByRole('heading', { name: '2 áudios em processamento' }),
    ).toBeTruthy();
    expect(screen.getByText('Hino da UDV')).toBeTruthy();
    expect(screen.queryByText('Palestra de Hermetismo')).toBeNull();
    expect(cardTitles()[0]).toContain('Enviando · 50%');
    // The phone's card counts the same, and says only the scope's send.
    expect(phoneCard()?.textContent).toMatch(/2 áudios em processamento/);
    expect(phoneCard()?.textContent).toContain('Enviando 1');
  });

  it('with no scope, shows what goes to any collection', async () => {
    const view = await setup([], 0, { scope: null });
    const panel = signal<readonly UploadInFlight[]>([
      {
        key: 'panel-1',
        title: 'Palestra de Hermetismo',
        topic: 'hermetismo',
        loaded: 10,
        total: 100,
      },
    ]);
    TestBed.inject(UploadsInFlight).register(panel, TestBed.inject(DestroyRef));
    await view.fixture.whenStable();
    expect(screen.getByText('Palestra de Hermetismo')).toBeTruthy();
  });
});
