import type { APIRequestContext } from '@playwright/test';
import { CSRF, expect } from './fixtures.js';
import { uniqueTag, uploadReady } from './media-helpers.js';

// The E2E server stores the transcript and the turns through the real paths (E2E-only
// routes), as a transcriber would (KBC-064, KBC-065).

/** What the Mac sends for a voice close to a profile (KBC-071): never a print. */
export interface VoiceMatch {
  readonly voice: string;
  readonly profileId: string;
  readonly similarity: number;
}

type Line = readonly [start: number, end: number, text: string];

/** A minute of interview: A asks, B answers, A asks, B answers, C (audience) asks, B. */
const LINES: readonly Line[] = [
  [0, 5, 'Mestre, o senhor está lembrado daquele dia?'],
  [5.5, 15, 'Eu lembro sim, foi numa sessão em mil novecentos e sessenta.'],
  [15.5, 22, 'E como foi que o senhor chegou lá?'],
  [22.5, 40, 'Cheguei pela mão de um amigo que trabalhava na construção.'],
  [40.5, 45, 'Uma pergunta da plateia sobre o vegetal.'],
  [45.5, 59, 'Respondo com alegria: o vegetal é a nossa comunhão.'],
];

export const TURNS = [
  { start: 0, end: 5.2, voice: 'SPEAKER_02' },
  { start: 5.2, end: 15.3, voice: 'SPEAKER_01' },
  { start: 15.3, end: 22.2, voice: 'SPEAKER_02' },
  { start: 22.2, end: 40.3, voice: 'SPEAKER_01' },
  { start: 40.3, end: 45.3, voice: 'SPEAKER_03' },
  { start: 45.3, end: 59, voice: 'SPEAKER_01' },
];

const rawOf = (lines: readonly Line[]) => ({
  chunks: [
    {
      offset: 0,
      end: 60,
      result: {
        segments: lines.map(([start, end, text]) => ({
          start,
          end,
          text: ` ${text}`,
          avg_logprob: -0.2,
          compression_ratio: 1.3,
          no_speech_prob: 0.01,
          words: text.split(' ').map((word, index, all) => ({
            word: ` ${word}`,
            start: start + ((end - start) * index) / all.length,
            end: start + ((end - start) * (index + 1)) / all.length,
            probability: 0.95,
          })),
        })),
      },
    },
  ],
});

/** The minute of interview stored as this audio's transcript, as a transcriber would. */
export async function seedTranscript(
  owner: APIRequestContext,
  mediaId: string,
): Promise<void> {
  const seeded = await owner.post(`/api/e2e/media/${mediaId}/transcript`, {
    data: { raw: rawOf(LINES) },
    headers: CSRF,
  });
  expect(seeded.status(), await seeded.text()).toBe(204);
}

/** A ready audio of a minute with its transcript: what "Separar vozes" works on. */
export async function transcribedAudio(
  owner: APIRequestContext,
  topic?: string,
) {
  const media = await uploadReady(owner, {
    title: `Entrevista ${uniqueTag()}`,
    seconds: 60,
    ...(topic ? { topic } : {}),
  });
  await seedTranscript(owner, media.id);
  return media;
}

interface SeparationAnswer {
  readonly turns?: typeof TURNS;
  readonly voiceMatches?: readonly VoiceMatch[];
}

/** Asks for a separation and answers it with `turns`, as the Mac would. */
export async function separateVoices(
  owner: APIRequestContext,
  mediaId: string,
  { turns = TURNS, voiceMatches = [] }: SeparationAnswer = {},
): Promise<void> {
  const asked = await owner.post(`/api/v1/media/${mediaId}/diarize`, {
    data: {},
    headers: CSRF,
  });
  expect(asked.status(), await asked.text()).toBe(202);
  const done = await owner.post(`/api/e2e/media/${mediaId}/diarization`, {
    data: { turns, voiceMatches },
    headers: CSRF,
  });
  expect(done.status(), await done.text()).toBe(204);
}
