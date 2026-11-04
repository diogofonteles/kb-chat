import type { Author, CollectionSpeaker } from '@kb-chat/contracts';
import {
  MAX_SPEAKER_SUGGESTIONS,
  isInvalidSpeakerName,
  suggestSpeakers,
} from './speaker-suggestions.js';

const speaker = (name: string, index = 0): CollectionSpeaker => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  name,
  authorSlug: null,
  main: false,
});

const MASTER: Author = {
  slug: 'mestre-gabriel',
  name: 'Mestre Gabriel',
  main: true,
};
const OTHER: Author = { slug: 'ana', name: 'Ana', main: false };

const labels = (input: Partial<Parameters<typeof suggestSpeakers>[0]>) =>
  suggestSpeakers({
    speakers: [],
    authors: [],
    text: '',
    current: '',
    ...input,
  }).map(({ label }) => label);

describe('suggestSpeakers (KBC-065 AC-2)', () => {
  it("offers the audience, the collection's speakers and its authors, the main one first", () => {
    expect(
      labels({ speakers: [speaker('Bia')], authors: [OTHER, MASTER] }),
    ).toEqual(['Pergunta da plateia', 'Mestre Gabriel', 'Bia', 'Ana']);
  });

  it('shows an author already linked to a speaker once', () => {
    const linked = {
      ...speaker('Mestre Gabriel'),
      authorSlug: MASTER.slug,
      main: true,
    };
    expect(labels({ speakers: [linked], authors: [MASTER] })).toEqual([
      'Pergunta da plateia',
      'Mestre Gabriel',
    ]);
  });

  it('BUG-8: a speaker and a free author of one name are one option, the author', () => {
    const options = suggestSpeakers({
      speakers: [speaker('Ana')],
      authors: [OTHER],
      text: '',
      current: '',
    });
    expect(options.map(({ label }) => label)).toEqual([
      'Pergunta da plateia',
      'Ana',
    ]);
    expect(options[1]?.choice).toEqual({ kind: 'author', author: OTHER });
  });

  it('keeps an exact name on a list cut short', () => {
    const speakers = [
      ...Array.from({ length: 9 }, (_, index) =>
        speaker(`Ana Falante ${index}`, index),
      ),
      speaker('Ana', 9),
    ];
    expect(labels({ speakers, text: 'Ana' })).toContain('Ana');
  });

  it('filters without accents or case and offers to register a new name', () => {
    expect(labels({ speakers: [speaker('José')], text: 'jose' })).toEqual([
      'José',
    ]);
    expect(labels({ speakers: [speaker('José')], text: 'Maria' })).toEqual([
      'Cadastrar «Maria»',
    ]);
  });

  it('shows everything for what the voice already is, with "Sem nome"', () => {
    expect(
      labels({
        speakers: [speaker('Ana'), speaker('Bia', 1)],
        text: 'Ana',
        current: 'Ana',
      }),
    ).toEqual(['Pergunta da plateia', 'Ana', 'Bia', 'Sem nome']);
  });

  it('never offers to register the audience', () => {
    expect(labels({ text: 'pergunta da plateia' })).toEqual([
      'Pergunta da plateia',
    ]);
  });

  it('AC-7: offers no registration for an invalid name', () => {
    const name = 'a'.repeat(121);
    expect(isInvalidSpeakerName(name)).toBe(true);
    expect(isInvalidSpeakerName('  ')).toBe(false);
    expect(labels({ text: name })).toEqual([]);
  });

  it('keeps the list short', () => {
    const speakers = Array.from({ length: 20 }, (_, index) =>
      speaker(`Falante ${index}`, index),
    );
    expect(labels({ speakers })).toHaveLength(MAX_SPEAKER_SUGGESTIONS + 1);
  });

  it('NFR-2: answers within 100 ms with 500 speakers', () => {
    const speakers = Array.from({ length: 500 }, (_, index) =>
      speaker(`Falante número ${index}`, index),
    );
    const started = performance.now();
    suggestSpeakers({ speakers, authors: [], text: 'número 49', current: '' });
    expect(performance.now() - started).toBeLessThan(100);
  });
});
