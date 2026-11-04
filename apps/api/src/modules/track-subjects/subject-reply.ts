import {
  MAX_TRACK_SUBJECTS,
  SUBJECT_NAME_MAX,
  TRACK_SUMMARY_MAX,
  subjectKey,
} from '@kb-chat/contracts';
import { z } from 'zod';
import type { LinkTarget } from '../../ports/track-subject-store.js';
import { jsonOf } from '../track-proposals/index.js';

const trackReplySchema = z.looseObject({
  faixa: z.number().int().positive(),
  assuntos: z.array(z.unknown()).catch([]),
  novos: z.array(z.unknown()).catch([]),
  resumo: z.unknown().optional(),
});
const replySchema = z.looseObject({ faixas: z.array(z.unknown()) });

export interface TrackReply {
  readonly faixa: number;
  readonly assuntos: readonly unknown[];
  readonly novos: readonly unknown[];
  readonly resumo?: unknown;
}

/** The reply's tracks; null for one that cannot be read. A bad track alone is skipped. */
export function parseSubjectReply(answer: string): TrackReply[] | null {
  let json: unknown;
  try {
    json = jsonOf(answer);
  } catch {
    return null;
  }
  const reply = replySchema.safeParse(json);
  if (!reply.success) return null;
  return reply.data.faixas.flatMap((one) => {
    const track = trackReplySchema.safeParse(one);
    return track.success ? [track.data] : [];
  });
}

/** What exists in the collection, by the key a name compares in. */
export interface KnownSubjects {
  readonly concepts: ReadonlyMap<string, string>;
  readonly free: ReadonlyMap<string, string>;
}

const nameOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= SUBJECT_NAME_MAX && !/[\r\n\t]/.test(name)
    ? name
    : null;
};

function existing(known: KnownSubjects, name: string): LinkTarget | null {
  const key = subjectKey(name);
  const concept = known.concepts.get(key);
  if (concept !== undefined) return { kind: 'concept', name: concept };
  const free = known.free.get(key);
  return free === undefined ? null : { kind: 'free', id: free };
}

const keyOf = (target: LinkTarget): string =>
  target.kind === 'free' ? `free:${target.id}` : subjectKey(target.name);

/**
 * BR-2: only what exists, or what the model marked as new; a name it invented in `assuntos`
 * is dropped, and a "new" one that exists is the existing one. Up to `room` chips.
 */
export function acceptSubjects(
  reply: Pick<TrackReply, 'assuntos' | 'novos'>,
  context: { readonly known: KnownSubjects; readonly room: number },
): LinkTarget[] {
  const { known, room } = context;
  const named = reply.assuntos.flatMap((value) => {
    const name = nameOf(value);
    const target = name === null ? null : existing(known, name);
    return target ? [target] : [];
  });
  const marked = reply.novos.flatMap((value): LinkTarget[] => {
    const name = nameOf(value);
    if (name === null) return [];
    return [existing(known, name) ?? { kind: 'new', name }];
  });
  const seen = new Set<string>();
  const unique = [...named, ...marked].filter((one) => {
    const key = keyOf(one);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, Math.min(room, MAX_TRACK_SUBJECTS));
}

export const acceptSummary = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const summary = value.trim();
  return summary && summary.length <= TRACK_SUMMARY_MAX ? summary : null;
};
