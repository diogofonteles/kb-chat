import { describe, expect, it } from 'vitest';
import {
  acceptTracks,
  acceptVoices,
  wordsOf,
  parseWindowReply,
  titleOf,
  type TrackRules,
} from './proposal-validation.js';
import type { PromptSegment } from './windows.js';

/** Segments 1..n of 2 s each; voice 2 asks on odd ids, voice 1 answers on even ones. */
const window = (n: number, firstId = 1): PromptSegment[] =>
  Array.from({ length: n }, (_, index) => ({
    id: firstId + index,
    startMs: (firstId + index - 1) * 2_000,
    endMs: (firstId + index) * 2_000,
    text: `fala ${firstId + index}`,
    voice: (firstId + index) % 2 === 1 ? 2 : 1,
  }));

const rules = (overrides: Partial<TrackRules> = {}): TrackRules => ({
  window: window(20),
  last: null,
  kept: [],
  voices: new Set([1, 2]),
  ...overrides,
});

const track = (first: number, last: number, extra: object = {}) => ({
  primeiro_id: first,
  ultimo_id: last,
  tipo: 'pergunta_resposta',
  quem_pergunta: 'Voz 2',
  quem_responde: 'Voz 1',
  titulo: `Faixa ${first}`,
  continua_faixa_anterior: false,
  ...extra,
});

describe('parseWindowReply (KBC-067 FR-2)', () => {
  it('reads the JSON inside fences and after a reasoning block', () => {
    const parsed = parseWindowReply(
      '<think>vou pensar {x}</think>\n```json\n{"faixas":[{"a":1}]}\n```',
    );
    expect(parsed).toEqual({
      ok: true,
      reply: { faixas: [{ a: 1 }], vozes: [] },
    });
  });

  it('asks again for text without JSON, broken JSON or no tracks', () => {
    expect(parseWindowReply('desculpe')).toEqual({
      ok: false,
      error: 'JSON inválido: sem JSON na resposta',
    });
    expect(parseWindowReply('{"faixas": [').ok).toBe(false);
    expect(parseWindowReply('{"faixas": []}')).toEqual({
      ok: false,
      error: 'o campo "faixas" falta ou está vazio',
    });
  });
});

describe('acceptTracks (KBC-067 FR-2, ADR 0029 §4)', () => {
  it('turns ids into the segments’ times, kinds and voices', () => {
    const accepted = acceptTracks(
      [track(1, 6), track(7, 20, { tipo: 'exposicao' })],
      rules(),
    );
    expect(accepted.discarded).toBe(0);
    expect(accepted.tracks).toEqual([
      {
        firstSegment: 1,
        lastSegment: 6,
        startMs: 0,
        endMs: 12_000,
        kind: 'qa',
        title: 'Faixa 1',
        askerVoice: 2,
        answererVoice: 1,
      },
      expect.objectContaining({ kind: 'talk', askerVoice: null }),
    ]);
  });

  it('drops an overlapping track, unknown ids, a reversed one, a bad kind and one under 5 s (AC-5)', () => {
    const accepted = acceptTracks(
      [
        track(1, 6),
        track(4, 10),
        track(7, 99),
        track(9, 8),
        track(7, 10, { tipo: 'outro' }),
        track(7, 8),
        track(9, 20),
      ],
      rules(),
    );
    expect(accepted.tracks.map((one) => one.firstSegment)).toEqual([1, 9]);
    expect(accepted.discarded).toBe(5);
  });

  it('refuses a title over 80 characters and voices not in the recording (AC-9)', () => {
    const [only] = acceptTracks(
      [track(1, 6, { titulo: 'x'.repeat(140), quem_pergunta: 'Voz 7' })],
      rules(),
    ).tracks;
    expect(only).toMatchObject({ title: null, askerVoice: null });
  });

  it('joins the first track to the run’s last when it continues it (AC-8)', () => {
    const accepted = acceptTracks(
      [track(21, 25, { continua_faixa_anterior: true }), track(26, 40)],
      rules({
        window: window(20, 21),
        last: { lastSegment: 20, startMs: 30_000 },
      }),
    );
    expect(accepted.extendLast).toEqual({ lastSegment: 25, endMs: 50_000 });
    expect(accepted.tracks.map((one) => one.firstSegment)).toEqual([26]);
  });

  it('does not join across a gap or a person’s track, nor on the first window', () => {
    const gap = acceptTracks(
      [track(23, 30, { continua_faixa_anterior: true })],
      rules({ window: window(20, 21), last: { lastSegment: 20, startMs: 0 } }),
    );
    expect(gap.extendLast).toBeNull();
    expect(gap.tracks).toHaveLength(1);
    const kept = acceptTracks(
      [track(21, 30, { continua_faixa_anterior: true })],
      rules({
        window: window(20, 21),
        last: { lastSegment: 20, startMs: 0 },
        kept: [{ startMs: 39_000, endMs: 41_000 }],
      }),
    );
    expect(kept.extendLast).toBeNull();
    const first = acceptTracks(
      [track(1, 6, { continua_faixa_anterior: true })],
      rules(),
    );
    expect(first.tracks).toHaveLength(1);
  });

  it('never crosses a person’s track; touching it is fine (BR-6)', () => {
    const accepted = acceptTracks([track(1, 5), track(6, 10), track(11, 20)], {
      ...rules(),
      kept: [{ startMs: 10_000, endMs: 20_000 }],
    });
    expect(accepted.tracks.map((one) => one.firstSegment)).toEqual([1, 11]);
  });
});

describe('acceptVoices (KBC-067 BR-5)', () => {
  const evidence = {
    voices: new Set([1, 2, 3]),
    spoken: wordsOf('Mestre, o senhor pode falar? Meu nome é João da Silva.'),
    knownNames: ['Mestre Gabriel'],
  };

  it('keeps names the speech or the collection backs, with their reason (AC-2)', () => {
    expect(
      acceptVoices(
        [
          { voz: 'Voz 1', nome: 'Mestre  Gabriel', motivo: 'é o autor' },
          { voz: 'Voz 3', nome: 'joão da silva', motivo: 'se apresenta' },
        ],
        evidence,
      ),
    ).toEqual([
      {
        voice: 1,
        name: 'Mestre  Gabriel',
        audience: false,
        reason: 'é o autor',
      },
      {
        voice: 3,
        name: 'joão da silva',
        audience: false,
        reason: 'se apresenta',
      },
    ]);
  });

  it('never names the audience and drops a name nobody said (AC-9)', () => {
    expect(
      acceptVoices(
        [
          { voz: 'Voz 2', nome: 'Pedro', plateia: true, motivo: 'pergunta' },
          { voz: 'Voz 1', nome: 'Carlos Inventado', motivo: 'palpite' },
          { voz: 'Voz 9', nome: 'Mestre Gabriel', motivo: 'não existe' },
          { voz: 'Voz 3', nome: 'Mestre Gabriel', motivo: '  ' },
          { voz: 'Voz 2', nome: null, plateia: true, motivo: 'repetida' },
          'lixo',
        ],
        evidence,
      ),
    ).toEqual([{ voice: 2, name: null, audience: true, reason: 'pergunta' }]);
  });
});

describe('names are found by whole words (AC-9)', () => {
  it('does not find "Ana" inside "banana", but finds it said on its own', () => {
    const suggest = (spoken: string) =>
      acceptVoices([{ voz: 'Voz 1', nome: 'Ana', motivo: 'é chamada assim' }], {
        voices: new Set([1]),
        spoken: wordsOf(spoken),
        knownNames: [],
      });
    expect(suggest('Comprei uma banana, Ivone.')).toEqual([]);
    expect(suggest('Obrigado, Ana! Pode falar.')).toEqual([
      { voice: 1, name: 'Ana', audience: false, reason: 'é chamada assim' },
    ]);
    expect(wordsOf('  Mestre—José, Luiz! ')).toBe('mestre jose luiz');
  });
});

describe('titleOf (BR-4)', () => {
  it('trims and squeezes spaces; refuses empty, too long or not text', () => {
    expect(titleOf('  O que é   a burracheira? ')).toBe(
      'O que é a burracheira?',
    );
    expect(titleOf('   ')).toBeNull();
    expect(titleOf('x'.repeat(81))).toBeNull();
    expect(titleOf(42)).toBeNull();
  });
});
