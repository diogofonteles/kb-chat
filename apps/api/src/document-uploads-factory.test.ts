import { describe, expect, it } from 'vitest';
import { mediaProgressOf } from './document-uploads-factory.js';

type Wiring = Parameters<typeof mediaProgressOf>[0];

const ID = '11111111-1111-4111-8111-111111111111';

/** The library with one recording, as far as its progress reads it. */
function library(of: {
  readonly media: {
    readonly status?: string;
    readonly progress?: number;
    readonly jobStatus?: string | null;
    readonly version?: number | null;
  } | null;
  readonly publication?: string;
}): Wiring {
  const { media, publication } = of;
  const record = media && {
    id: ID,
    status: media.status ?? 'ready',
    progress: media.progress ?? null,
    transcription: {
      jobStatus: media.jobStatus ?? null,
      version: media.version ?? null,
    },
  };
  return {
    media: { store: { getMedia: () => record } },
    documents: {
      status: { of: () => (publication ? { state: publication } : null) },
    },
    mac: { percentOf: () => 42 },
  } as unknown as Wiring;
}

describe('where a recording sent by its link is (KBC-184)', () => {
  it('one that is not in the library any more is nowhere', () => {
    expect(mediaProgressOf(library({ media: null }), ID)).toBeNull();
  });

  it.each([
    ['its conversion failed', { media: { status: 'failed' } }, 'failed', null],
    [
      'it is live in the collection',
      { media: { version: 1 }, publication: 'live' },
      'ready',
      null,
    ],
    [
      'it is being prepared',
      { media: { status: 'processing', progress: 30 } },
      'transcribing',
      { step: 'preparing', percent: 30 },
    ],
    [
      'it waits to be transcribed',
      { media: { jobStatus: 'queued' } },
      'transcribing',
      { step: 'waiting', percent: null },
    ],
    [
      'it is being transcribed',
      { media: { jobStatus: 'leased' } },
      'transcribing',
      { step: 'transcribing', percent: 42 },
    ],
    [
      'it did not transcribe: it waits for a person',
      { media: { jobStatus: 'failed' } },
      'transcribing',
      { step: 'attention', percent: null },
    ],
    [
      'it is transcribed, with tracks to review',
      { media: { version: 1 } },
      'transcribing',
      { step: 'attention', percent: null },
    ],
    [
      'it is being published',
      { media: { version: 1 }, publication: 'publishing' },
      'transcribing',
      { step: 'publishing', percent: null },
    ],
    [
      'its publication failed: whole here, it is never sent again from its link (I5)',
      { media: { version: 1 }, publication: 'failed' },
      'transcribing',
      { step: 'attention', percent: null },
    ],
  ] as const)('%s', (_name, of, state, step) => {
    expect(mediaProgressOf(library(of), ID)).toEqual({ state, step });
  });
});
