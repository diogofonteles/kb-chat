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
    mediaOf: (topic) => (topic === 'hermetismo' ? [RECORDING] : []),
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

  it('the sweep renders again a first render that failed, until it succeeds', async () => {
    const { state, desired, errors, reconciler } = world();
    reconciler.reconcileRecording(RECORDING);
    await reconciler.reconcileAll();
    expect(errors).toEqual([BAD, BAD]);
    state.broken = false;
    desired.length = 0;
    await reconciler.reconcileAll();
    // GOOD is wanted as it already was; BAD gets its first document.
    expect(desired.map((one) => one.mediaId)).toEqual([BAD]);
    desired.length = 0;
    await reconciler.reconcileAll();
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

describe('MediaDocumentReconciler (KBC-100 fix round 1)', () => {
  it("QA BUG-1: a change to the whole collection renders its recordings' tracks again", () => {
    const { state, desired, queued, reconciler } = world();
    state.broken = false;
    reconciler.reconcileTopic('hermetismo');
    expect(desired.map((one) => one.mediaId).sort()).toEqual(
      [GOOD, BAD].sort(),
    );
    expect(queued).toEqual(['hermetismo']);
  });

  /** A library of `count` documents, every one rendered once already. */
  function library(count: number, sweep: { limit: number; slice: number }) {
    const ids = Array.from(
      { length: count },
      (_, at) => `0b9c1f7e-2222-4a2b-8c3d-${String(at).padStart(12, '0')}`,
    );
    const rendered: string[] = [];
    const turns: number[] = [];
    let running = 0;
    const reconciler = new MediaDocumentReconciler({
      source: {
        inputOf: (mediaId) => {
          rendered.push(mediaId);
          running += 1;
          return inputOf(mediaId);
        },
        tracksOf: () => [],
      },
      documents: {
        desire: () => false,
        retire: () => null,
        hasPending: () => false,
        enqueue: () => undefined,
        documented: () => [...ids].reverse(),
        documentedUnder: () => [],
        undocumentedRecordings: () => [],
        statusOf: () => null,
      },
      hasFolder: () => true,
      sweep: {
        ...sweep,
        pause: async () => {
          turns.push(running);
          running = 0;
        },
      },
    });
    return { ids, rendered, turns, reconciler };
  }

  it('review 6: one sweep renders at most its limit, a slice per turn of the event loop', async () => {
    const { ids, rendered, turns, reconciler } = library(1_200, {
      limit: 500,
      slice: 20,
    });

    const report = await reconciler.reconcileAll();

    expect(report).toEqual({ rendered: 500, slices: 25 });
    expect(rendered).toEqual(ids.slice(0, 500));
    // The event loop runs after every 20 renders, never later.
    expect(turns).toHaveLength(25);
    expect(Math.max(...turns)).toBe(20);
  });

  it('review 6: the next sweeps go on after the cursor and come round to the first ones', async () => {
    const { ids, rendered, reconciler } = library(1_200, {
      limit: 500,
      slice: 50,
    });

    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    await reconciler.reconcileAll();

    expect(rendered.slice(500, 1_000)).toEqual(ids.slice(500, 1_000));
    expect(rendered.slice(1_000)).toEqual([
      ...ids.slice(1_000),
      ...ids.slice(0, 300),
    ]);
  });

  it('review 6: a sweep still running when the next is due makes that one skip', async () => {
    const { rendered, reconciler } = library(100, { limit: 500, slice: 10 });

    const [first, second] = await Promise.all([
      reconciler.reconcileAll(),
      reconciler.reconcileAll(),
    ]);

    expect(first).toEqual({ rendered: 100, slices: 10 });
    expect(second).toEqual({ rendered: 0, slices: 0 });
    expect(rendered).toHaveLength(100);
  });

  it('review suggestion: the backfill skips recordings of collections with no vault folder before rendering', async () => {
    const read: string[] = [];
    const reconciler = new MediaDocumentReconciler({
      source: {
        inputOf: (mediaId) => {
          read.push(mediaId);
          return null;
        },
        tracksOf: () => [],
      },
      documents: {
        desire: () => false,
        retire: () => null,
        hasPending: () => false,
        enqueue: () => undefined,
        documented: () => [],
        documentedUnder: () => [],
        undocumentedRecordings: () => [
          { mediaId: GOOD, topic: 'hermetismo' },
          { mediaId: BAD, topic: 'nova' },
        ],
        statusOf: () => null,
      },
      hasFolder: (topic) => topic === 'hermetismo',
    });

    await reconciler.reconcileAll();

    expect(read).toEqual([GOOD]);
  });
});
