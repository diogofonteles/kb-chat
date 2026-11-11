import { describe, expect, it } from 'vitest';
import { impactOf, removalTargets } from './level-impact.js';
import { scaleVersion } from './scale-version.js';

const held = {
  documents: { qs: 5, ci: 14, cdc: 6 },
  media: { qs: 1, ci: 2, cdc: 3 },
  people: { qs: 3, ci: 2, cdc: 1 },
  implicit: 0,
  unassigned: 0,
};
const QS_CI_CDC = ['qs', 'ci', 'cdc'];

describe('impactOf (KBC-108 FR-2)', () => {
  it('moving CDC below CI: CI gains CDC, CDC loses CI, QS is untouched', () => {
    expect(
      impactOf({ before: QS_CI_CDC, after: ['qs', 'cdc', 'ci'] }, held),
    ).toEqual({
      gaining: { people: 2, documents: 6, media: 3 },
      losing: { people: 1, documents: 14, media: 2 },
    });
  });

  it('an order that does not change anything has no impact', () => {
    expect(impactOf({ before: QS_CI_CDC, after: QS_CI_CDC }, held)).toEqual({
      gaining: { people: 0, documents: 0, media: 0 },
      losing: { people: 0, documents: 0, media: 0 },
    });
  });

  it('nobody counts as gaining a level that holds no item', () => {
    const empty = { ...held, documents: { qs: 5 }, media: {} };
    expect(
      impactOf({ before: QS_CI_CDC, after: ['qs', 'cdc', 'ci'] }, empty)
        .gaining,
    ).toEqual({ people: 0, documents: 0, media: 0 });
  });

  it('deleting CI with the defaults: its people lose CI content, which goes to CDC', () => {
    const change = {
      before: QS_CI_CDC,
      after: ['qs', 'cdc'],
      removal: { level: 'ci', moveContentTo: 'cdc', movePeopleTo: 'qs' },
    };
    expect(impactOf(change, held)).toEqual({
      gaining: { people: 0, documents: 0, media: 0 },
      losing: { people: 2, documents: 14, media: 2 },
    });
  });

  it('deleting CI with its content sent down: QS gains it', () => {
    const change = {
      before: QS_CI_CDC,
      after: ['qs', 'cdc'],
      removal: { level: 'ci', moveContentTo: 'qs', movePeopleTo: 'cdc' },
    };
    expect(impactOf(change, held)).toEqual({
      gaining: { people: 5, documents: 20, media: 5 },
      losing: { people: 0, documents: 0, media: 0 },
    });
  });
});

describe('removalTargets (KBC-108 BR-2)', () => {
  it('content goes up and people down; at the edges, the other way', () => {
    expect(removalTargets(QS_CI_CDC, 'ci')).toEqual({
      moveContentTo: 'cdc',
      movePeopleTo: 'qs',
    });
    expect(removalTargets(QS_CI_CDC, 'cdc')).toEqual({
      moveContentTo: 'ci',
      movePeopleTo: 'ci',
    });
    expect(removalTargets(QS_CI_CDC, 'qs')).toEqual({
      moveContentTo: 'ci',
      movePeopleTo: 'ci',
    });
    expect(removalTargets(['qs'], 'qs')).toEqual({
      moveContentTo: null,
      movePeopleTo: null,
    });
  });
});

describe('scaleVersion (KBC-108 FR-5)', () => {
  const level = (id: string, code = id.toUpperCase(), description = '') => ({
    id,
    code,
    description,
    createdBy: 'owner@example.com',
    createdAt: '2026-11-01T00:00:00.000Z',
  });

  it('changes with the order, a code or a description, and holds for the same scale', () => {
    const base = scaleVersion([level('qs'), level('ci')]);
    expect(scaleVersion([level('qs'), level('ci')])).toBe(base);
    expect(scaleVersion([level('ci'), level('qs')])).not.toBe(base);
    expect(scaleVersion([level('qs', 'Q.S.'), level('ci')])).not.toBe(base);
    expect(scaleVersion([level('qs', 'QS', 'Quadro'), level('ci')])).not.toBe(
      base,
    );
    expect(scaleVersion([level('qs')])).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });
});
