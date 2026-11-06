import { describe, expect, it } from 'vitest';
import type { DesiredDocument } from '../../ports/media-document-store.js';
import { MediaDocumentReconciler } from './reconciler.js';
import type { TrackDocumentInput } from './track-document.js';

const RECORDING = '0b9c1f7e-1111-4a2b-8c3d-000000000002';
const GOOD = '0b9c1f7e-1111-4a2b-8c3d-000000000001';
const BAD = '0b9c1f7e-1111-4a2b-8c3d-000000000003';

const inputOf = (mediaId: string): TrackDocumentInput => ({
  topic: 'hermetismo',
  mediaId,
  kind: 'track',
  title: 'Faixa',
  recordingId: RECORDING,
  recordingTitle: 'Gravação',
  ordinal: 1,
  total: 2,
  startMs: 0,
  durationMs: 10_000,
  confidence: 'normal',
  authorship: 'outros-autores',
  author: null,
  subjects: [],
  domain: 'esoterismo',
  transcribedAt: '2026-10-01T00:00:00.000Z',
  segments: [{ startMs: 0, endMs: 1_000, text: 'fala' }],
});

/** A source whose BAD track throws while `broken` holds (an author or YAML gone wrong). */
function world() {
  const state = { broken: true };
  const desired: DesiredDocument[] = [];
  const queued: string[] = [];
  const errors: string[] = [];
  const reconciler = new MediaDocumentReconciler({
    source: {
      inputOf: (mediaId) => {
        if (mediaId === BAD && state.broken) throw new Error('no author');
        return inputOf(mediaId);
      },
      tracksOf: () => [GOOD, BAD],
    },
    documents: {
      desire: (document) => {
        desired.push(document);
        return true;
      },
      pendingOf: () => [{ mediaId: GOOD, path: 'p' }],
      enqueue: ({ topic }) => {
        queued.push(topic);
      },
    },
    liveTracks: () => [GOOD],
    onError: (mediaId) => errors.push(mediaId),
  });
  return { state, desired, queued, errors, reconciler };
}

describe('MediaDocumentReconciler (KBC-099 review: a render never undoes a publication)', () => {
  it('a track whose render throws does not throw into the publication; the others go on', () => {
    const { desired, queued, errors, reconciler } = world();
    expect(() => reconciler.reconcileRecording(RECORDING)).not.toThrow();
    expect(desired.map((one) => one.mediaId)).toEqual([GOOD]);
    expect(queued).toEqual(['hermetismo']);
    expect(errors).toEqual([BAD]);
  });

  it('the sweep renders again a first render that failed, until it succeeds', () => {
    const { state, desired, errors, reconciler } = world();
    reconciler.reconcileRecording(RECORDING);
    reconciler.reconcileAll();
    expect(errors).toEqual([BAD, BAD]);
    state.broken = false;
    desired.length = 0;
    reconciler.reconcileAll();
    expect(desired.map((one) => one.mediaId).sort()).toEqual(
      [GOOD, BAD].sort(),
    );
    desired.length = 0;
    reconciler.reconcileAll();
    // Rendered once: no longer retried beyond the live tracks.
    expect(desired.map((one) => one.mediaId)).toEqual([GOOD]);
  });
});
