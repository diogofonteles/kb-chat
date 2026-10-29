import { describe, expect, it } from 'vitest';
import {
  MEDIA_MAX_UPLOAD_BYTES,
  createMediaRequestSchema,
  failJobRequestSchema,
  hasAcceptedAudioExtension,
  mediaItemSchema,
} from './media.js';

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
    };
    expect(mediaItemSchema.parse(item)).toEqual(item);
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
});
