import { describe, expect, it } from 'vitest';
import {
  confirmVoicesRequestSchema,
  mergeVoicesRequestSchema,
  nameVoiceRequestSchema,
  splitVoiceRequestSchema,
} from './media.js';
import {
  SPEAKER_NAME_MAX,
  collectionSpeakerCreateSchema,
  collectionSpeakerUpdateSchema,
  speakerKeyOf,
  speakerNameSchema,
} from './speakers.js';

const SPEAKER_ID = '11111111-1111-4111-8111-111111111111';

describe('speakerNameSchema (KBC-065 FR-1, AC-7)', () => {
  it('collapses spaces and keeps a name up to the limit', () => {
    expect(speakerNameSchema.parse('  Maria   da Paz ')).toBe('Maria da Paz');
    const longest = 'a'.repeat(SPEAKER_NAME_MAX);
    expect(speakerNameSchema.parse(longest)).toBe(longest);
  });

  it.each([
    '',
    '   ',
    'a'.repeat(121),
    'Ana\nMaria',
    'Ana «Maria»',
    'Ana "M"',
    '\u0301',
    '\u0301\u0302 \u0303',
  ])('refuses %j', (name) => {
    expect(speakerNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('speakerKeyOf', () => {
  it('takes two spellings of a name as one speaker', () => {
    expect(speakerKeyOf(' MARIA  da PÁZ')).toBe(speakerKeyOf('Maria da Paz'));
  });
});

describe('the speakers requests', () => {
  it('takes a name with or without an author, and nothing else', () => {
    const body = { name: 'Ana', authorSlug: 'ana' };
    expect(collectionSpeakerCreateSchema.safeParse(body).success).toBe(true);
    expect(collectionSpeakerUpdateSchema.safeParse(body).success).toBe(true);
    expect(
      collectionSpeakerCreateSchema.safeParse({ ...body, main: true }).success,
    ).toBe(false);
  });
});

describe('the voices requests (KBC-065 FR-2)', () => {
  it('names a voice as a speaker or the audience, not both', () => {
    const base = { version: 1, speakerId: null, audience: false };
    expect(nameVoiceRequestSchema.safeParse(base).success).toBe(true);
    expect(
      nameVoiceRequestSchema.safeParse({ ...base, audience: true }).success,
    ).toBe(true);
    expect(
      nameVoiceRequestSchema.safeParse({
        version: 1,
        speakerId: SPEAKER_ID,
        audience: true,
      }).success,
    ).toBe(false);
  });

  it('joins two different voices', () => {
    const join = { version: 1, voice: 2, into: 1 };
    expect(mergeVoicesRequestSchema.safeParse(join).success).toBe(true);
    expect(
      mergeVoicesRequestSchema.safeParse({ ...join, into: 2 }).success,
    ).toBe(false);
  });

  it('needs the version of the separation', () => {
    expect(splitVoiceRequestSchema.safeParse({ voice: 1 }).success).toBe(false);
    expect(confirmVoicesRequestSchema.safeParse({}).success).toBe(false);
    expect(confirmVoicesRequestSchema.safeParse({ version: 2 }).success).toBe(
      true,
    );
  });
});
