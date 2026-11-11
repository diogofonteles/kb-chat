import { describe, expect, it } from 'vitest';
import {
  libraryQuerySchema,
  listeningPreferencesUpdateSchema,
  listeningStateOf,
  markPlayedRequestSchema,
} from './media-library.js';

describe('listeningStateOf (KBC-051 BR-6)', () => {
  it('is unheard with no position and no completion', () => {
    expect(listeningStateOf({ positionMs: 0, completedAt: null })).toBe(
      'unheard',
    );
  });

  it('is in progress with a position and no completion', () => {
    expect(listeningStateOf({ positionMs: 1, completedAt: null })).toBe(
      'in-progress',
    );
  });

  it('stays heard when played again after being heard', () => {
    expect(
      listeningStateOf({
        positionMs: 60_000,
        completedAt: '2026-11-01T10:00:00.000Z',
      }),
    ).toBe('heard');
  });
});

describe('libraryQuerySchema (FR-1)', () => {
  it('reads comma-separated chips', () => {
    expect(
      libraryQuerySchema.parse({
        state: 'in-progress,heard',
        sort: 'duration',
      }),
    ).toEqual({
      state: ['in-progress', 'heard'],
      sort: 'duration',
    });
  });

  it('refuses an unknown chip, sort or cursor', () => {
    expect(libraryQuerySchema.safeParse({ state: 'paused' }).success).toBe(
      false,
    );
    expect(libraryQuerySchema.safeParse({ sort: 'random' }).success).toBe(
      false,
    );
    expect(libraryQuerySchema.safeParse({ cursor: '-1' }).success).toBe(false);
  });
});

describe('markPlayedRequestSchema (FR-3)', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  it('takes from 1 to 200 ids', () => {
    expect(
      markPlayedRequestSchema.safeParse({ ids: [id], played: true }).success,
    ).toBe(true);
    expect(
      markPlayedRequestSchema.safeParse({ ids: [], played: true }).success,
    ).toBe(false);
    expect(
      markPlayedRequestSchema.safeParse({
        ids: Array.from({ length: 201 }, () => id),
        played: false,
      }).success,
    ).toBe(false);
  });
});

describe('listeningPreferencesUpdateSchema (FR-5)', () => {
  it('takes only the fields that changed', () => {
    expect(
      listeningPreferencesUpdateSchema.parse({ libraryView: 'grid' }),
    ).toEqual({ libraryView: 'grid' });
  });

  it('refuses an empty update and unknown fields', () => {
    expect(listeningPreferencesUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      listeningPreferencesUpdateSchema.safeParse({ libraryColor: 'red' })
        .success,
    ).toBe(false);
  });

  it('refuses a filter outside the chips', () => {
    expect(
      listeningPreferencesUpdateSchema.safeParse({
        libraryFilters: {
          states: ['paused'],
          authors: [],
          topic: null,
        },
      }).success,
    ).toBe(false);
  });
});
