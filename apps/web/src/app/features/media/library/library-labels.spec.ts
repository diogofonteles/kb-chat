import type { LibraryItem } from '@kb-chat/contracts';
import { aMediaItem } from '../../../testing/media-fixtures.js';
import {
  activeFiltersOf,
  applyFilterChange,
  NO_FILTERS,
  countTextOf,
  coverToneOf,
  initialsOf,
  percentOf,
  playedAgoOf,
  resumeTextOf,
  stateTextOf,
  toggled,
} from './library-labels.js';

const anItem = (overrides: Partial<LibraryItem> = {}): LibraryItem => ({
  ...aMediaItem(),
  kind: 'audio',
  lastPlayedAt: null,
  tracks: [],
  ...overrides,
});

describe('library labels (T16)', () => {
  it('says the state in words, leaving "Não ouvida" out', () => {
    expect(stateTextOf(anItem())).toBe('');
    expect(stateTextOf(anItem({ positionMs: 10 }))).toBe('Em andamento');
    expect(
      stateTextOf(anItem({ completedAt: '2026-11-01T00:00:00.000Z' })),
    ).toBe('✓ Ouvida');
  });

  it('offers "Continuar de" only for a ready media heard in part', () => {
    expect(resumeTextOf(anItem({ positionMs: 1_390_000 }))).toBe(
      'Continuar de 23:10',
    );
    expect(
      resumeTextOf(anItem({ positionMs: 1_390_000, status: 'processing' })),
    ).toBe('');
    expect(resumeTextOf(anItem())).toBe('');
  });

  it('gives the share heard, never past 100', () => {
    expect(percentOf(anItem({ positionMs: 500, durationMs: 1_000 }))).toBe(50);
    expect(percentOf(anItem({ positionMs: 5, durationMs: null }))).toBe(0);
    expect(percentOf(anItem({ positionMs: 2_000, durationMs: 1_000 }))).toBe(
      100,
    );
  });

  it('counts the media and their length', () => {
    expect(countTextOf(1, 0)).toBe('1 mídia');
    expect(countTextOf(12, 45 * 60_000)).toBe('12 mídias · 45 min');
    expect(countTextOf(42, 31 * 3_600_000)).toBe('42 mídias · 31 h');
    expect(countTextOf(2, 10_000)).toBe('2 mídias · 1 min');
  });

  it('says how long ago a media was played', () => {
    const now = new Date('2026-11-03T12:00:00.000Z');
    expect(playedAgoOf('2026-11-03T11:59:30.000Z', now, 'pt-BR')).toBe(
      'agora há pouco',
    );
    expect(playedAgoOf('2026-11-01T12:00:00.000Z', now, 'pt-BR')).toBe(
      'anteontem',
    );
    expect(playedAgoOf('2026-10-27T12:00:00.000Z', now, 'pt-BR')).toBe(
      'semana passada',
    );
    expect(playedAgoOf('2026-11-03T09:00:00.000Z', now, 'pt-BR')).toBe(
      'há 3 horas',
    );
  });

  it('makes a cover of the first words’ initials, the same tone per collection', () => {
    expect(initialsOf('Palestra de 1998')).toBe('P1');
    expect(initialsOf('a b')).toBe('A');
    expect(coverToneOf('hermetismo')).toBe(coverToneOf('hermetismo'));
    expect(coverToneOf('hermetismo')).toBeGreaterThanOrEqual(0);
    expect(coverToneOf('hermetismo')).toBeLessThan(4);
  });

  it('counts the active filters and toggles a chip', () => {
    expect(
      activeFiltersOf({
        states: ['heard', 'unheard'],
        authors: [],
        topic: 'hermetismo',
        allTopics: false,
        subject: null,
      }),
    ).toBe(2);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggled(['b'], 'a')).toEqual(['b', 'a']);
  });

  it('applies each change to the filters held now, so two quick changes keep both', () => {
    const pressed = applyFilterChange(NO_FILTERS, {
      kind: 'toggle-state',
      state: 'in-progress',
    });
    const both = applyFilterChange(pressed, {
      kind: 'author',
      author: '-',
    });
    expect(both).toEqual({
      states: ['in-progress'],
      authors: ['-'],
      topic: null,
      allTopics: false,
      subject: null,
    });
    expect(applyFilterChange(both, { kind: 'topic', topic: 'udv' }).topic).toBe(
      'udv',
    );
    expect(
      applyFilterChange(both, { kind: 'author', author: null }).authors,
    ).toEqual([]);
    expect(applyFilterChange(both, { kind: 'clear' })).toEqual(NO_FILTERS);
  });
});
