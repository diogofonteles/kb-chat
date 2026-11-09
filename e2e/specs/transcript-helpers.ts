import type { APIRequestContext } from '@playwright/test';
import { CSRF, expect } from './fixtures.js';

/** A line of speech at `at` seconds; its words are 0.3 s apart. */
export interface SpokenLine {
  readonly at: number;
  readonly text: string;
}

const WORD_SECONDS = 0.3;

/**
 * A raw whisper result (ADR 0023 §4) for `lines`: one chunk, word times, and scores that
 * give a normal transcript or, with `low`, one of low confidence (avg_logprob < -1).
 */
export function rawOf(
  lines: readonly SpokenLine[],
  options: { low?: boolean } = {},
) {
  const segments = lines.map((line) => {
    const words = line.text.split(' ').map((word, index) => ({
      word: ` ${word}`,
      start: line.at + index * WORD_SECONDS,
      end: line.at + index * WORD_SECONDS + WORD_SECONDS * 0.8,
      probability: 0.9,
    }));
    return {
      start: line.at,
      end: line.at + words.length * WORD_SECONDS,
      text: ` ${line.text}`,
      avg_logprob: options.low ? -1.6 : -0.2,
      compression_ratio: 1.3,
      no_speech_prob: 0.01,
      words,
    };
  });
  const end = segments.at(-1)?.end ?? 0;
  return { chunks: [{ offset: 0, end, result: { segments } }] };
}

/**
 * Stores a transcript for a ready media through the E2E server's real transcription path
 * (`/api/e2e/media/:id/transcript`), as a transcriber would.
 */
export async function seedTranscript(
  api: APIRequestContext,
  input: { id: string; raw: ReturnType<typeof rawOf>; learn?: boolean },
): Promise<void> {
  const stored = await api.post(`/api/e2e/media/${input.id}/transcript`, {
    data: { raw: input.raw, learn: input.learn ?? false },
    headers: CSRF,
  });
  expect(stored.status(), await stored.text()).toBe(204);
}
