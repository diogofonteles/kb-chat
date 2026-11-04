import { describe, expect, it } from 'vitest';
import {
  MAX_TRACK_SUBJECTS,
  SUBJECT_NAME_MAX,
  TRACK_SUMMARY_MAX,
  createSubjectRequestSchema,
  decideSuggestionsRequestSchema,
  saveTrackSubjectsRequestSchema,
  subjectKey,
  subjectRefSchema,
} from './track-subjects.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('subjectKey (KBC-069 FR-1)', () => {
  it.each([
    ['Burracheira', 'burracheira'],
    ['  BURRACHÉIRA ', 'burracheira'],
    ['Sete   Raios', 'sete raios'],
    ['Ação', 'acao'],
  ])('compares %j as %j', (name, key) => {
    expect(subjectKey(name)).toBe(key);
  });
});

describe('createSubjectRequestSchema', () => {
  it('trims the name', () => {
    expect(createSubjectRequestSchema.parse({ name: ' Cabala ' }).name).toBe(
      'Cabala',
    );
  });

  it.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(SUBJECT_NAME_MAX + 1)],
    ['two lines', 'um\ndois'],
  ])('refuses a %s name', (_case, name) => {
    expect(createSubjectRequestSchema.safeParse({ name }).success).toBe(false);
  });

  it('takes a name at the limit', () => {
    const name = 'x'.repeat(SUBJECT_NAME_MAX);
    expect(createSubjectRequestSchema.safeParse({ name }).success).toBe(true);
  });
});

describe('subjectRefSchema', () => {
  it('takes a concept by name and a free subject by id', () => {
    expect(
      subjectRefSchema.safeParse({ kind: 'concept', name: 'Cabala' }).success,
    ).toBe(true);
    expect(subjectRefSchema.safeParse({ kind: 'free', id: ID }).success).toBe(
      true,
    );
  });

  it('refuses a "new" subject: only a decision creates one (BR-2)', () => {
    expect(
      subjectRefSchema.safeParse({ kind: 'new', name: 'Outro' }).success,
    ).toBe(false);
  });
});

describe('saveTrackSubjectsRequestSchema (FR-2)', () => {
  const refs = (count: number) =>
    Array.from({ length: count }, () => ({ kind: 'free', id: ID }));

  it('reads a blank summary as none', () => {
    const saved = saveTrackSubjectsRequestSchema.parse({
      subjects: [],
      summary: '   ',
    });
    expect(saved.summary).toBeNull();
  });

  it('holds five subjects and refuses the sixth (BR-1)', () => {
    const parse = (subjects: unknown) =>
      saveTrackSubjectsRequestSchema.safeParse({ subjects, summary: null });
    expect(parse(refs(MAX_TRACK_SUBJECTS)).success).toBe(true);
    expect(parse(refs(MAX_TRACK_SUBJECTS + 1)).success).toBe(false);
  });

  it('refuses a summary past the limit and an unknown field', () => {
    expect(
      saveTrackSubjectsRequestSchema.safeParse({
        subjects: [],
        summary: 'x'.repeat(TRACK_SUMMARY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      saveTrackSubjectsRequestSchema.safeParse({
        subjects: [],
        summary: null,
        accepted: true,
      }).success,
    ).toBe(false);
  });
});

describe('decideSuggestionsRequestSchema (FR-4)', () => {
  it('fills what a decision leaves out', () => {
    expect(decideSuggestionsRequestSchema.parse({ accept: [ID] })).toEqual({
      accept: [ID],
      refuse: [],
      summary: null,
    });
  });

  it('takes a decision on the summary alone', () => {
    expect(
      decideSuggestionsRequestSchema.safeParse({ summary: 'refuse' }).success,
    ).toBe(true);
  });

  it('refuses a decision on nothing', () => {
    expect(decideSuggestionsRequestSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a suggestion both accepted and refused', () => {
    expect(
      decideSuggestionsRequestSchema.safeParse({ accept: [ID], refuse: [ID] })
        .success,
    ).toBe(false);
  });
});
