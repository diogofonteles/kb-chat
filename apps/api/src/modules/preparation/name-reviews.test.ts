import { describe, expect, it } from 'vitest';
import type { VoiceText } from '../../ports/track-proposal-store.js';
import { nameReviewsOf } from './name-reviews.js';

const RUN = '33333333-3333-4333-8333-333333333333';
const ONE = '44444444-4444-4444-8444-000000000001';
const TWO = '44444444-4444-4444-8444-000000000002';

const text = (voice: number, name: string): VoiceText => ({
  runId: RUN,
  voice,
  name,
  written: null,
});
const person = (voice: number, name: string) => ({
  voice,
  name,
  kind: 'person' as const,
});

describe('nameReviewsOf (KBC-090, KBC-102)', () => {
  it('AC-3: a one-word suggestion that is part of the name given is not wrong', () => {
    expect(
      nameReviewsOf({
        texts: [text(1, 'Laércio')],
        labels: [person(1, 'Laércio Fonseca')],
        refused: [],
        tracks: [{ id: ONE, title: 'Laércio explica a Tábua' }],
      }),
    ).toEqual([]);
  });

  it("AC-4: a refused name that a person gave another voice is that voice's name", () => {
    expect(
      nameReviewsOf({
        texts: [text(1, 'Ana Souza'), text(2, 'Ana Souza')],
        labels: [person(1, 'Ana Souza')],
        refused: [2],
        tracks: [{ id: ONE, title: 'Ana Souza responde' }],
      }),
    ).toEqual([]);
  });

  it("AC-4: a name corrected away from one voice stays another voice's name", () => {
    expect(
      nameReviewsOf({
        texts: [text(1, 'Ana Souza'), text(2, 'Ana Souza')],
        labels: [person(1, 'Ana Souza'), person(2, 'Bruno Lima')],
        refused: [],
        tracks: [{ id: ONE, title: 'Ana Souza responde' }],
      }),
    ).toEqual([]);
  });

  it('AC-5: the catalog spelling of the same name is the same name', () => {
    expect(
      nameReviewsOf({
        texts: [text(1, 'Laercio')],
        labels: [person(1, 'Laércio')],
        refused: [],
        tracks: [{ id: ONE, title: 'Laercio responde' }],
      }),
    ).toEqual([]);
  });

  it('AC-6: a one-word name that is part of no given name is still reviewed', () => {
    expect(
      nameReviewsOf({
        texts: [text(1, 'Pedro')],
        labels: [person(1, 'Marcos')],
        refused: [],
        tracks: [
          { id: ONE, title: 'São Pedro e Pedro Álvares' },
          { id: TWO, title: 'Outra conversa' },
        ],
      }),
    ).toEqual([
      {
        voice: 1,
        name: 'Pedro',
        tracks: [{ id: ONE, title: 'São Pedro e Pedro Álvares' }],
      },
    ]);
  });

  it('AC-7: a refused name nobody was given is still reviewed', () => {
    expect(
      nameReviewsOf({
        texts: [text(2, 'Joana Prado')],
        labels: [person(1, 'Márcio da Rós')],
        refused: [2],
        tracks: [{ id: TWO, title: 'Pergunta de Joana Prado' }],
      }),
    ).toEqual([
      {
        voice: 2,
        name: 'Joana Prado',
        tracks: [{ id: TWO, title: 'Pergunta de Joana Prado' }],
      },
    ]);
  });

  it('reads the given name by the same word boundaries as a title', () => {
    for (const given of ['Laércio, Fonseca', 'Laércio-Fonseca'])
      expect(
        nameReviewsOf({
          texts: [text(1, 'Laércio')],
          labels: [person(1, given)],
          refused: [],
          tracks: [{ id: ONE, title: 'Laércio explica a Tábua' }],
        }),
      ).toEqual([]);
  });

  it("BR-2: a one-word name held by another voice's given name is that voice's", () => {
    expect(
      nameReviewsOf({
        texts: [text(1, 'Pedro')],
        labels: [person(1, 'Marcos'), person(2, 'Pedro Álvares')],
        refused: [],
        tracks: [{ id: ONE, title: 'Pedro explica a viagem' }],
      }),
    ).toEqual([]);
  });

  it('a name that only shares a word with the given one is still reviewed', () => {
    expect(
      nameReviewsOf({
        texts: [text(1, 'Ana Lima')],
        labels: [person(1, 'Ana Souza')],
        refused: [],
        tracks: [{ id: ONE, title: 'Conversa com Ana Lima' }],
      }),
    ).toHaveLength(1);
  });
});
