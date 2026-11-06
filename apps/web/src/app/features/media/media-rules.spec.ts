import type { MediaItem } from '@kb-chat/contracts';
import { isInFlight, statusTextOf } from './media-labels.js';
import { matchesTitle, newlyReady, summaryOf } from './media-summary.js';
import {
  fileProblemOf,
  overQuota,
  sentOf,
  titleFromFileName,
} from './upload-rules.js';

const anItem = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  parent: null,
  archived: false,
  id: '11111111-1111-4111-8111-111111111111',
  topic: 'hermetismo',
  title: 'Palestra de 1998',
  author: { slug: 'mestre-laercio', name: 'Mestre Laércio', main: true },
  status: 'ready',
  progress: null,
  failure: null,
  durationMs: 3_735_000,
  bytes: 30_000_000,
  createdAt: '2026-10-28T12:00:00.000Z',
  canRetry: false,
  canTranscribeAgain: false,
  canUseGroq: false,
  canEdit: false,
  positionMs: 0,
  completedAt: null,
  positionUpdatedAt: null,
  transcription: {
    status: 'none',
    confidence: null,
    version: null,
    transcriber: 'none',
    transcriberOffSince: null,
    lastAttemptFailed: false,
    provider: null,
    route: 'transcriber',
    hold: null,
  },
  ...overrides,
});

describe('statusTextOf (T14: status in words, UP-20)', () => {
  it.each([
    [{ status: 'uploading' }, 'Enviando…'],
    [{ status: 'queued' }, 'Na fila'],
    [{ status: 'processing', progress: null }, 'Convertendo…'],
    [{ status: 'processing', progress: 40 }, 'Convertendo… 40%'],
    [{ status: 'ready' }, 'Pronta'],
    [
      { status: 'failed', failure: 'invalid-audio' },
      'Falhou: o arquivo não é um áudio válido',
    ],
    [
      { status: 'failed', failure: 'conversion-failed' },
      'Falhou: a conversão falhou várias vezes',
    ],
    [
      { status: 'failed', failure: 'too-many-attempts' },
      'Falhou: a conversão parou várias vezes',
    ],
    [
      { status: 'failed', failure: 'upload-abandoned' },
      'Falhou: o envio não terminou',
    ],
  ] as const)('says %o as "%s"', (overrides, text) => {
    expect(statusTextOf(anItem(overrides))).toBe(text);
  });

  it('tells which items are still moving', () => {
    expect(isInFlight(anItem({ status: 'queued' }))).toBe(true);
    expect(isInFlight(anItem({ status: 'uploading' }))).toBe(false);
    expect(isInFlight(anItem({ status: 'processing' }))).toBe(true);
    expect(isInFlight(anItem({ status: 'ready' }))).toBe(false);
    expect(isInFlight(anItem({ status: 'failed' }))).toBe(false);
  });
});

describe('summaryOf', () => {
  it('counts the items and their total length', () => {
    expect(summaryOf([])).toBe('0 áudios');
    expect(summaryOf([anItem({ durationMs: null })])).toBe('1 áudio');
    expect(summaryOf([anItem({ durationMs: 45 * 60_000 })])).toBe(
      '1 áudio · 45 min',
    );
    expect(summaryOf([anItem({ durationMs: 10_000 })])).toBe('1 áudio · 1 min');
    expect(
      summaryOf([
        anItem({ durationMs: 16 * 3_600_000 }),
        anItem({ durationMs: 15 * 3_600_000 }),
      ]),
    ).toBe('2 áudios · 31 h');
  });
});

describe('matchesTitle', () => {
  it('finds titles without minding accents or case', () => {
    const item = anItem({ title: 'Lição sobre Salomão' });
    expect(matchesTitle(item, 'salomao')).toBe(true);
    expect(matchesTitle(item, ' LIÇÃO ')).toBe(true);
    expect(matchesTitle(item, 'hermes')).toBe(false);
    expect(matchesTitle(item, '')).toBe(true);
  });
});

describe('newlyReady', () => {
  it('names only items that turned ready between two refreshes', () => {
    const before = [
      anItem({ id: 'a', status: 'processing' }),
      anItem({ id: 'b', status: 'ready' }),
      anItem({ id: 'c', status: 'queued' }),
    ];
    const after = [
      anItem({ id: 'a', status: 'ready' }),
      anItem({ id: 'b', status: 'ready' }),
      anItem({ id: 'c', status: 'processing' }),
      anItem({ id: 'd', status: 'ready' }),
    ];
    expect(newlyReady(before, after).map((item) => item.id)).toEqual(['a']);
  });
});

describe('upload rules (MA-20, MA-25)', () => {
  it('accepts an audio file up to 4 GB', () => {
    expect(fileProblemOf({ name: 'aula.mp3', size: 1_000 })).toBeNull();
    expect(
      fileProblemOf({ name: 'aula.OPUS', size: 4 * 1024 ** 3 }),
    ).toBeNull();
  });

  it('never calls a file over the limit a file of 4 GB', () => {
    expect(fileProblemOf({ name: 'aula.mp3', size: 4 * 1024 ** 3 + 10 })).toBe(
      'Este arquivo tem 4,1 GB. O limite é 4 GB.',
    );
  });

  it('says a small quota in MB, never as 0 GB', () => {
    expect(overQuota(50 * 1024 ** 2)).toBe(
      'Este envio passa da sua cota de 50 MB. Fale com um master para aumentar.',
    );
    expect(overQuota(5 * 1024 ** 3)).toBe(
      'Este envio passa da sua cota de 5 GB. Fale com um master para aumentar.',
    );
  });

  it('says what is wrong and how to fix it', () => {
    expect(fileProblemOf({ name: 'apostila.pdf', size: 10 })).toBe(
      'Este arquivo não é um áudio aceito. Envie mp3, m4a, wav, flac, ogg ou opus.',
    );
    expect(fileProblemOf({ name: 'aula.wav', size: 4.1 * 1024 ** 3 })).toBe(
      'Este arquivo tem 4,1 GB. O limite é 4 GB.',
    );
    expect(fileProblemOf({ name: 'aula.mp3', size: 0 })).toBe(
      'Este arquivo está vazio. Escolha outro.',
    );
  });

  it('suggests the title from the file name', () => {
    expect(titleFromFileName('Palestra_de_1998.mp3')).toBe('Palestra de 1998');
    expect(titleFromFileName('aula.final.m4a')).toBe('aula.final');
    expect(titleFromFileName('.hidden')).toBe('.hidden');
    expect(titleFromFileName(`${'a'.repeat(300)}.mp3`)).toHaveLength(200);
  });

  it('shows how much was sent', () => {
    expect(sentOf(128 * 1024 * 1024, 312 * 1024 * 1024)).toBe('128 de 312 MB');
  });
});
