import { aHit, aMediaHit } from '../../testing/fixtures.js';
import { mixReferences, passageKey } from './references.js';

describe('mixReferences (KBC-039 FR-6)', () => {
  it('puts each passage before the first document it outscores', () => {
    const docs = [
      aHit({ id: 'a.md', score: 0.9 }),
      aHit({ id: 'b.md', score: 0.5 }),
    ];
    const passage = aMediaHit({ score: 0.7 });
    expect(mixReferences(docs, [passage]).map((one) => one.key)).toEqual([
      'text:hermetismo:a.md',
      `audio:${passageKey(passage)}`,
      'text:hermetismo:b.md',
    ]);
  });

  it('keeps the passages in the order the API gave (normal before low, BR-3)', () => {
    const normal = aMediaHit({ startMs: 1_000, score: 0.3 });
    const low = aMediaHit({ startMs: 2_000, score: 0.8, confidence: 'low' });
    const mixed = mixReferences([aHit({ score: 0.5 })], [normal, low]);
    expect(mixed.map((one) => one.kind)).toEqual(['text', 'audio', 'audio']);
    expect(mixed[1]?.hit).toBe(normal);
  });

  it('lists passages alone when there are no documents, and documents alone otherwise', () => {
    expect(mixReferences([], [aMediaHit()]).map((one) => one.kind)).toEqual([
      'audio',
    ]);
    expect(mixReferences([aHit()], []).map((one) => one.kind)).toEqual([
      'text',
    ]);
  });
});
