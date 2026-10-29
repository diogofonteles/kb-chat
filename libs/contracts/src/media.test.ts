import { describe, expect, it } from 'vitest';
import {
  MEDIA_MAX_UPLOAD_BYTES,
  createMediaRequestSchema,
  failJobRequestSchema,
  MEDIA_SPEEDS,
  hasAcceptedAudioExtension,
  mediaItemSchema,
  mediaPreferencesSchema,
  mediaProgressRequestSchema,
} from './media.js';

const PREFS = {
  speed: 1,
  showRemaining: true,
  skipBackSec: 15,
  skipForwardSec: 30,
};

const aRequest = {
  title: '  Palestra de 1998 ',
  authorship: 'mestre-laercio',
  fileName: 'palestra.mp3',
  bytes: 3_000_000,
};

describe('media contracts', () => {
  it('trims the title of an upload request', () => {
    expect(createMediaRequestSchema.parse(aRequest).title).toBe(
      'Palestra de 1998',
    );
  });

  it('refuses an upload above 500 MB or of zero bytes', () => {
    const over = { ...aRequest, bytes: MEDIA_MAX_UPLOAD_BYTES + 1 };
    expect(createMediaRequestSchema.safeParse(over).success).toBe(false);
    expect(
      createMediaRequestSchema.safeParse({ ...aRequest, bytes: 0 }).success,
    ).toBe(false);
    expect(
      createMediaRequestSchema.safeParse({
        ...aRequest,
        bytes: MEDIA_MAX_UPLOAD_BYTES,
      }).success,
    ).toBe(true);
  });

  it('accepts only the two media authorships and no extra fields', () => {
    expect(
      createMediaRequestSchema.safeParse({ ...aRequest, authorship: 'sintese' })
        .success,
    ).toBe(false);
    expect(
      createMediaRequestSchema.safeParse({ ...aRequest, extra: 1 }).success,
    ).toBe(false);
  });

  it('refuses a blank title', () => {
    expect(
      createMediaRequestSchema.safeParse({ ...aRequest, title: '   ' }).success,
    ).toBe(false);
  });

  it.each([
    ['aula.MP3', true],
    ['aula.m4a', true],
    ['aula.wav', true],
    ['aula.flac', true],
    ['aula.ogg', true],
    ['aula.opus', true],
    ['aula.pdf', false],
    ['aula', false],
    ['mp3', false],
  ])('tells whether %s is an accepted audio file (%s)', (name, accepted) => {
    expect(hasAcceptedAudioExtension(name)).toBe(accepted);
  });

  it('describes a media item with nullable progress and failure', () => {
    const item = {
      id: '11111111-1111-4111-8111-111111111111',
      topic: 'hermetismo',
      title: 'Palestra',
      authorship: 'outros-autores',
      status: 'failed',
      progress: null,
      failure: 'invalid-audio',
      durationMs: null,
      bytes: null,
      createdAt: '2026-10-28T12:00:00.000Z',
      canRetry: false,
      positionMs: 0,
      completedAt: null,
      positionUpdatedAt: null,
    };
    expect(mediaItemSchema.parse(item)).toEqual(item);
    expect(mediaItemSchema.safeParse({ ...item, positionMs: -1 }).success).toBe(
      false,
    );
    expect(mediaItemSchema.safeParse({ ...item, progress: 101 }).success).toBe(
      false,
    );
  });

  it('accepts only the worker failures a worker can report', () => {
    const fail = {
      worker: 'vm',
      leaseId: '22222222-2222-4222-8222-222222222222',
      failure: 'invalid-audio',
      detail: 'no stream',
    };
    expect(failJobRequestSchema.parse(fail)).toEqual(fail);
    expect(
      failJobRequestSchema.safeParse({ ...fail, failure: 'too-many-attempts' })
        .success,
    ).toBe(false);
  });

  it('accepts only the six speeds of the menu and the time display choice (KBC-041 FR-1)', () => {
    expect(MEDIA_SPEEDS).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2]);
    for (const speed of MEDIA_SPEEDS)
      expect(
        mediaPreferencesSchema.safeParse({ ...PREFS, speed }).success,
      ).toBe(true);
    for (const speed of [3, 0.5, 1.1, '1.5'])
      expect(
        mediaPreferencesSchema.safeParse({ ...PREFS, speed }).success,
      ).toBe(false);
    expect(
      mediaPreferencesSchema.safeParse({ ...PREFS, showRemaining: 'yes' })
        .success,
    ).toBe(false);
    expect(mediaPreferencesSchema.safeParse({ ...PREFS, x: 1 }).success).toBe(
      false,
    );
  });

  it('takes a position as whole, non-negative milliseconds, with the save it continues (FR-2, FR-3)', () => {
    const request = { positionMs: 1_390_000, basedOn: null };
    expect(mediaProgressRequestSchema.parse(request)).toEqual(request);
    for (const positionMs of [-1, 1.5, '10'])
      expect(
        mediaProgressRequestSchema.safeParse({ positionMs, basedOn: null })
          .success,
      ).toBe(false);
    // Required: a client can never skip the check against newer saves.
    expect(
      mediaProgressRequestSchema.safeParse({ positionMs: 1 }).success,
    ).toBe(false);
  });

  it('takes skips only from the "Pulos" menu (KBC-043 FR-1)', () => {
    for (const skipBackSec of [5, 10, 15, 30])
      expect(
        mediaPreferencesSchema.safeParse({ ...PREFS, skipBackSec }).success,
      ).toBe(true);
    for (const skipForwardSec of [10, 15, 30, 45, 60])
      expect(
        mediaPreferencesSchema.safeParse({ ...PREFS, skipForwardSec }).success,
      ).toBe(true);
    for (const skipBackSec of [7, 0, 60])
      expect(
        mediaPreferencesSchema.safeParse({ ...PREFS, skipBackSec }).success,
      ).toBe(false);
    expect(
      mediaPreferencesSchema.safeParse({ ...PREFS, skipForwardSec: 5 }).success,
    ).toBe(false);
  });
});
