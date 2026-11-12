import type { LevelPreview, LevelPreviewRequest } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { StoredLevel } from './level-directory.js';
import {
  clearImpact,
  impactOf,
  removalTargets,
  type ScaleImpact,
} from './level-impact.js';
import type { InvitePresetLevels } from './preset-levels.js';
import { assertWholeScale, type CountedHoldings } from './scale-holdings.js';
import { scaleVersion } from './scale-version.js';

/** What a preview is made from: the scale as it is, what it holds, the profiles. */
export interface PreviewInput {
  readonly root: string;
  readonly scale: readonly StoredLevel[];
  readonly held: CountedHoldings;
  readonly presets: InvitePresetLevels;
}

export function levelIn(
  scale: readonly StoredLevel[],
  id: string,
): StoredLevel {
  const level = scale.find((one) => one.id === id);
  if (!level) throw new AppError('NOT_FOUND', 'Unknown level');
  return level;
}

/** A removal's impact; the only level's is that of every level taken away (BR-4). */
function removalImpact(input: PreviewInput, level: string): ScaleImpact {
  const ids = input.scale.map((one) => one.id);
  if (ids.length === 1) return clearImpact(ids, input.held);
  const targets = removalTargets(ids, level);
  return impactOf(
    {
      before: ids,
      after: ids.filter((id) => id !== level),
      removal: {
        level,
        moveContentTo: targets.moveContentTo ?? level,
        movePeopleTo: targets.movePeopleTo ?? level,
      },
    },
    input.held,
  );
}

/** What the level holds (whoever holds no level of the scale counts at the lowest, R1-1). */
function removalOf(input: PreviewInput, level: StoredLevel) {
  const { scale, held } = input;
  const ids = scale.map((one) => one.id);
  const lowest = ids[0] === level.id ? held.implicit : 0;
  return {
    level: { id: level.id, code: level.code },
    documents: held.documents[level.id] ?? 0,
    media: held.media[level.id] ?? 0,
    people: (held.people[level.id] ?? 0) + lowest,
    ...removalTargets(ids, level.id),
    last: scale.length === 1,
  };
}

/** FR-2: counts only, never a title or a name (BR-3). */
export function previewOf(
  input: PreviewInput,
  request: LevelPreviewRequest,
): LevelPreview {
  const { root, scale, held, presets } = input;
  const ids = scale.map((one) => one.id);
  const version = scaleVersion(scale);
  if ('order' in request) {
    assertWholeScale(ids, request.order);
    const impact = impactOf({ before: ids, after: request.order }, held);
    return { version, ...impact, removal: null, profiles: 0 };
  }
  if ('all' in request) {
    const profiles = presets
      .list()
      .filter((one) => ids.some((id) => one.levels?.[root] === id)).length;
    return { version, ...clearImpact(ids, held), removal: null, profiles };
  }
  const level = levelIn(scale, request.remove);
  const profiles = presets
    .list()
    .filter((one) => one.levels?.[root] === level.id).length;
  return {
    version,
    ...removalImpact(input, level.id),
    removal: removalOf(input, level),
    profiles,
  };
}
