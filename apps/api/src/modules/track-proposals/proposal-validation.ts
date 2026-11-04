import {
  MIN_TRACK_MS,
  PROPOSED_TITLE_MAX,
  type TrackKind,
  type VoiceSuggestion,
} from '@kb-chat/contracts';
import { z } from 'zod';
import type {
  KeptRange,
  ProposedTrack,
  TrackExtension,
} from '../../ports/track-proposal-store.js';
import { voiceOfLabel, type PromptSegment } from './windows.js';

/**
 * Checks what the model answered for one window (KBC-067 FR-2, ADR 0029 §4): an unreadable
 * answer asks the window again; a bad track is dropped on its own (unknown ids, overlap, a
 * person's track crossed, shorter than 5 s); a title too long or a name nobody said is
 * refused (BR-4, BR-5).
 */

const replySchema = z.looseObject({
  faixas: z.array(z.unknown()).min(1),
  vozes: z.array(z.unknown()).default([]),
});
export type WindowReply = z.infer<typeof replySchema>;

const KIND_OF: Record<'pergunta_resposta' | 'exposicao', TrackKind> = {
  pergunta_resposta: 'qa',
  exposicao: 'talk',
};

const rawTrackSchema = z.looseObject({
  primeiro_id: z.number().int(),
  ultimo_id: z.number().int(),
  tipo: z.enum(['pergunta_resposta', 'exposicao']),
  quem_pergunta: z.unknown().optional(),
  quem_responde: z.unknown().optional(),
  titulo: z.unknown().optional(),
  continua_faixa_anterior: z.boolean().optional(),
});
type RawTrack = z.infer<typeof rawTrackSchema>;

const rawVoiceSchema = z.looseObject({
  voz: z.unknown(),
  nome: z.string().nullish(),
  plateia: z.boolean().optional(),
  motivo: z.string(),
});

export type ParsedReply =
  | { readonly ok: true; readonly reply: WindowReply }
  | { readonly ok: false; readonly error: string };

/** The JSON object in the answer, without a reasoning block or code fences around it. */
export function jsonOf(text: string): unknown {
  const bare = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = bare.indexOf('{');
  const end = bare.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('sem JSON na resposta');
  return JSON.parse(bare.slice(start, end + 1));
}

/** Reads one window's answer; the error (in pt-BR) goes back to the model on the retry. */
export function parseWindowReply(text: string): ParsedReply {
  let json: unknown;
  try {
    json = jsonOf(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'ilegível';
    return { ok: false, error: `JSON inválido: ${reason}` };
  }
  const parsed = replySchema.safeParse(json);
  return parsed.success
    ? { ok: true, reply: parsed.data }
    : { ok: false, error: 'o campo "faixas" falta ou está vazio' };
}

/** Lowercase, without accents and repeated spaces: "Mestre  Gabriel" ~ "mestre gabriel". */
export const normalized = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The words of a text, normalized and separated by one space, punctuation dropped: names
 * are compared word by word, so "Ana" is not found inside "banana" (AC-9).
 */
export const wordsOf = (text: string): string =>
  normalized(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** A title of 1 to 80 characters, or none for the person to write (BR-4, AC-9). */
export function titleOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.replace(/\s+/g, ' ').trim();
  return title.length > 0 && title.length <= PROPOSED_TITLE_MAX ? title : null;
}

const crosses = (range: KeptRange, kept: readonly KeptRange[]): boolean =>
  kept.some((one) => range.startMs < one.endMs && one.startMs < range.endMs);

/** The run's last saved track, which a window's first track may continue. */
export interface LastTrack {
  readonly lastSegment: number;
  readonly startMs: number;
}

export interface TrackRules {
  readonly window: readonly PromptSegment[];
  readonly last: LastTrack | null;
  readonly kept: readonly KeptRange[];
  /** The voices of the recording: a label naming another is no voice. */
  readonly voices: ReadonlySet<number>;
}

export interface AcceptedTracks {
  readonly extendLast: TrackExtension | null;
  readonly tracks: readonly ProposedTrack[];
  readonly discarded: number;
}

interface Bounds {
  readonly first: PromptSegment;
  readonly last: PromptSegment;
}

function boundsOf(raw: RawTrack, rules: TrackRules): Bounds | null {
  const first = rules.window.find((one) => one.id === raw.primeiro_id);
  const last = rules.window.find((one) => one.id === raw.ultimo_id);
  return first && last && first.id <= last.id ? { first, last } : null;
}

function voiceIn(label: unknown, voices: ReadonlySet<number>): number | null {
  const voice = voiceOfLabel(label);
  return voice !== null && voices.has(voice) ? voice : null;
}

function toTrack(
  raw: RawTrack,
  bounds: Bounds,
  voices: ReadonlySet<number>,
): ProposedTrack {
  return {
    firstSegment: bounds.first.id,
    lastSegment: bounds.last.id,
    startMs: bounds.first.startMs,
    endMs: bounds.last.endMs,
    kind: KIND_OF[raw.tipo],
    title: titleOf(raw.titulo),
    askerVoice:
      raw.tipo === 'exposicao' ? null : voiceIn(raw.quem_pergunta, voices),
    answererVoice: voiceIn(raw.quem_responde, voices),
  };
}

/** A continuation joins the run's last track when it starts right after it. */
function continuationOf(
  raw: RawTrack,
  bounds: Bounds,
  rules: TrackRules,
): TrackExtension | null {
  const last = rules.last;
  if (!raw.continua_faixa_anterior || !last) return null;
  if (bounds.first.id !== last.lastSegment + 1) return null;
  const joined = { startMs: last.startMs, endMs: bounds.last.endMs };
  if (crosses(joined, rules.kept)) return null;
  return { lastSegment: bounds.last.id, endMs: bounds.last.endMs };
}

function isAcceptable(
  bounds: Bounds,
  after: number,
  rules: TrackRules,
): boolean {
  const range = { startMs: bounds.first.startMs, endMs: bounds.last.endMs };
  return (
    bounds.first.id > after &&
    range.endMs - range.startMs >= MIN_TRACK_MS &&
    !crosses(range, rules.kept)
  );
}

/** The tracks of a window that pass the rules, in order, each after the one before. */
export function acceptTracks(
  raws: readonly unknown[],
  rules: TrackRules,
): AcceptedTracks {
  const tracks: ProposedTrack[] = [];
  let extendLast: TrackExtension | null = null;
  let after = rules.last?.lastSegment ?? 0;
  for (const [index, value] of raws.entries()) {
    const raw = rawTrackSchema.safeParse(value);
    const bounds = raw.success ? boundsOf(raw.data, rules) : null;
    if (!raw.success || !bounds) continue;
    const extension =
      index === 0 ? continuationOf(raw.data, bounds, rules) : null;
    if (extension) {
      extendLast = extension;
      after = extension.lastSegment;
    } else if (isAcceptable(bounds, after, rules)) {
      tracks.push(toTrack(raw.data, bounds, rules.voices));
      after = bounds.last.id;
    }
  }
  const kept = tracks.length + (extendLast ? 1 : 0);
  return { extendLast, tracks, discarded: raws.length - kept };
}

/** What a voice name must be backed by: the speech itself or the collection's names. */
export interface NameEvidence {
  readonly voices: ReadonlySet<number>;
  /** The whole transcript as `wordsOf` gives it. */
  readonly spoken: string;
  readonly knownNames: readonly string[];
}

function justifiedName(
  name: string | null | undefined,
  evidence: NameEvidence,
): string | null {
  const trimmed = name?.trim() ?? '';
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  const wanted = wordsOf(trimmed);
  if (wanted.length === 0) return null;
  const known = evidence.knownNames.some((one) => wordsOf(one) === wanted);
  const said = ` ${evidence.spoken} `.includes(` ${wanted} `);
  return known || said ? trimmed : null;
}

function suggestionOf(
  value: unknown,
  evidence: NameEvidence,
): VoiceSuggestion | null {
  const raw = rawVoiceSchema.safeParse(value);
  if (!raw.success) return null;
  const voice = voiceIn(raw.data.voz, evidence.voices);
  const reason = raw.data.motivo.trim().slice(0, 300);
  const audience = raw.data.plateia === true;
  const name = audience ? null : justifiedName(raw.data.nome, evidence);
  if (voice === null || reason.length === 0) return null;
  return audience || name ? { voice, name, audience, reason } : null;
}

/** Names suggested for the voices, one per voice: never for the audience, never invented. */
export function acceptVoices(
  raws: readonly unknown[],
  evidence: NameEvidence,
): VoiceSuggestion[] {
  const byVoice = new Map<number, VoiceSuggestion>();
  for (const value of raws) {
    const suggestion = suggestionOf(value, evidence);
    if (suggestion && !byVoice.has(suggestion.voice))
      byVoice.set(suggestion.voice, suggestion);
  }
  return [...byVoice.values()];
}
