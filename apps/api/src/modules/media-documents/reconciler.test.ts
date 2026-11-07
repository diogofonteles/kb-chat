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
  const state = { broken: true, text: 'fala', gone: new Set<string>() };
  const desired: DesiredDocument[] = [];
  const queued: string[] = [];
  const errors: string[] = [];
  const retired: string[] = [];
  const rows = new Map<string, string>();
  const reconciler = new MediaDocumentReconciler({
    source: {
      inputOf: (mediaId) => {
        if (mediaId === BAD && state.broken) throw new Error('no author');
        if (mediaId === RECORDING || state.gone.has(mediaId)) return null;
        const input = inputOf(mediaId);
        return {
          ...input,
          segments: [{ startMs: 0, endMs: 1_000, text: state.text }],
        };
      },
      tracksOf: () => [GOOD, BAD],
    },
    documents: {
      desire: (document) => {
        if (rows.get(document.mediaId) === document.fingerprint) return false;
        rows.set(document.mediaId, document.fingerprint);
        desired.push(document);
        return true;
      },
      retire: (mediaId) => {
        if (!rows.delete(mediaId)) return null;
        retired.push(mediaId);
        return 'hermetismo';
      },
      hasPending: () => desired.length + retired.length > 0,
      enqueue: ({ topic }) => {
        queued.push(topic);
      },
      documented: () => [...rows.keys()],
      documentedUnder: () => [],
      undocumentedRecordings: () => [],
      statusOf: () => null,
    },
    hasFolder: (topic) => topic === 'hermetismo',
    onError: (mediaId) => errors.push(mediaId),
  });
  return { state, desired, queued, errors, retired, reconciler };
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
    // GOOD is wanted as it already was; BAD gets its first document.
    expect(desired.map((one) => one.mediaId)).toEqual([BAD]);
    desired.length = 0;
    reconciler.reconcileAll();
    // Rendered once and unchanged since: nothing new is wanted.
    expect(desired).toEqual([]);
  });
});

describe('MediaDocumentReconciler (KBC-100)', () => {
  it('KBC-093 trigger: a text that changed is wanted again; one that did not, is not (BR-1)', () => {
    const { state, desired, queued, reconciler } = world();
    state.broken = false;
    reconciler.reconcileTracks([GOOD, BAD]);
    desired.length = 0;
    queued.length = 0;
    reconciler.reconcileTracks([GOOD]);
    expect(desired).toEqual([]);
    state.text = 'fala corrigida';
    reconciler.reconcileTracks([GOOD]);
    expect(desired.map((one) => one.mediaId)).toEqual([GOOD]);
    expect(queued).toEqual(['hermetismo']);
  });

  it('BR-2: a media that stopped having a document is retired, and its collection queued', () => {
    const { state, retired, queued, reconciler } = world();
    state.broken = false;
    reconciler.reconcileRecording(RECORDING);
    queued.length = 0;
    state.gone.add(GOOD);
    reconciler.reconcileRecording(RECORDING);
    expect(retired).toEqual([GOOD]);
    expect(queued).toEqual(['hermetismo']);
  });

  it('AC-12: a collection with no folder in the vault gets no document', () => {
    const { state, desired, reconciler } = world();
    state.broken = false;
    expect(reconciler.preview(GOOD)?.topic).toBe('hermetismo');
    const noFolder = new MediaDocumentReconciler({
      source: {
        inputOf: (mediaId) => ({ ...inputOf(mediaId), topic: 'nova' }),
        tracksOf: () => [GOOD],
      },
      documents: {
        desire: () => {
          throw new Error('nothing is wanted');
        },
        retire: () => null,
        hasPending: () => false,
        enqueue: () => {
          throw new Error('nothing is queued');
        },
        documented: () => [],
        documentedUnder: () => [],
        undocumentedRecordings: () => [],
        statusOf: () => null,
      },
      hasFolder: () => false,
    });
    expect(() => noFolder.reconcileRecording(RECORDING)).not.toThrow();
    expect(noFolder.preview(GOOD)).toBeNull();
    expect(desired).toEqual([]);
  });
});
