import type { LevelAuditEntry, LevelDelete } from '@kb-chat/contracts';
import type { LevelActor } from './access-levels-service.js';
import type { StoredLevel } from './level-directory.js';
import type { Moved } from './scale-steps.js';

/** Who and when, shared by every line of one operation (one moment: they read as one). */
export type AuditBase = Pick<LevelAuditEntry, 'at' | 'by' | 'actingAs'>;

export const auditBaseOf = (actor: LevelActor, at: string): AuditBase => ({
  at,
  by: actor.by,
  ...(actor.actingAs && { actingAs: actor.actingAs }),
});

/**
 * `count.people` is every entry of people.json the operation rewrote: the people with access
 * the preview counted, and any entry left by someone who lost the collection since (R1-14).
 */
const countOf = (moved: Moved) => ({
  documents: moved.documents.length,
  media: moved.media.length,
  people: moved.people.length,
});

/** One `item.level` line per document and audio, to redo by hand (no automatic undo). */
function itemLines(
  base: AuditBase,
  moved: Moved,
  after: string | null,
): LevelAuditEntry[] {
  const documents = moved.documents.map((one): LevelAuditEntry => ({
    ...base,
    kind: 'item.level',
    collection: one.collection,
    target: one.id,
    before: one.level,
    after,
  }));
  const media = moved.media.map((one): LevelAuditEntry => ({
    ...base,
    kind: 'item.level',
    collection: one.topic,
    target: one.id,
    before: one.level,
    after,
    count: { media: 1 },
  }));
  return [...documents, ...media];
}

function personLines(
  base: AuditBase,
  change: {
    readonly root: string;
    readonly moved: Moved;
    readonly after: string | null;
  },
): LevelAuditEntry[] {
  return change.moved.people.map((one): LevelAuditEntry => ({
    ...base,
    kind: 'person.level',
    collection: change.root,
    target: one.id,
    before: one.level,
    after: change.after,
    via: 'scale',
  }));
}

/** A delete's lines: what moved, then `scale.delete` last (a torn append never holds it alone). */
export function removalLines(
  base: AuditBase,
  change: {
    readonly root: string;
    readonly level: StoredLevel;
    readonly body: LevelDelete;
    readonly moved: Moved;
  },
): LevelAuditEntry[] {
  const { root, level, body, moved } = change;
  return [
    ...itemLines(base, moved, body.moveContentTo),
    ...personLines(base, { root, moved, after: body.movePeopleTo }),
    {
      ...base,
      kind: 'scale.delete',
      collection: root,
      target: level.id,
      before: { code: level.code, description: level.description },
      after: {
        moveContentTo: body.moveContentTo,
        movePeopleTo: body.movePeopleTo,
      },
      count: countOf(moved),
    },
  ];
}

/** A clear's lines: what moved, then `scale.clear` with the codes the levels had. */
export function clearLines(
  base: AuditBase,
  change: {
    readonly root: string;
    readonly scale: readonly StoredLevel[];
    readonly moved: Moved;
  },
): LevelAuditEntry[] {
  const { root, scale, moved } = change;
  return [
    ...itemLines(base, moved, null),
    ...personLines(base, { root, moved, after: null }),
    {
      ...base,
      kind: 'scale.clear',
      collection: root,
      before: scale.map((one) => one.id),
      after: scale.map(({ id, code }) => ({ id, code })),
      count: countOf(moved),
    },
  ];
}

/** The mark of an operation undone after its lines may have been written (R1-5). */
export const undoneLine = (
  base: AuditBase,
  change: { readonly root: string; readonly target?: string },
): LevelAuditEntry => ({
  ...base,
  kind: 'scale.undone',
  collection: change.root,
  ...(change.target && { target: change.target }),
});
