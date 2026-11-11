import { rawChunkResultSchema, type RawChunkResult } from '@kb-chat/contracts';
import { z } from 'zod';

const finite = z.number().refine(Number.isFinite);

/** Groq's `verbose_json` with word and segment timestamps (the fields the API keeps). */
const groqVerboseSchema = z.looseObject({
  text: z.string().optional(),
  segments: z
    .array(z.looseObject({ start: finite, end: finite, text: z.string() }))
    .default([]),
  words: z
    .array(z.looseObject({ word: z.string(), start: finite, end: finite }))
    .default([]),
});

/**
 * Groq's answer in the Mac's shape (ADR 0023 §4): each word inside the segment its start
 * falls in (the last one that started before it), so the same derivation times the words.
 * Throws on an answer that is not Groq's verbose JSON.
 */
export function chunkResultOf(body: unknown): RawChunkResult {
  const { words, segments, ...rest } = groqVerboseSchema.parse(body);
  const placed = segments.map((segment) => ({
    ...segment,
    words: [] as (typeof words)[number][],
  }));
  for (const word of words) {
    const owner =
      placed.findLast((segment) => segment.start <= word.start + 0.001) ??
      placed[0];
    owner?.words.push(word);
  }
  return rawChunkResultSchema.parse({ ...rest, segments: placed });
}
