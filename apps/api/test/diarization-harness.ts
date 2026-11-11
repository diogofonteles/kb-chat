/**
 * The voice separation protocol under test (KBC-064): a transcript of a short conversation
 * (an interviewer, the one who answers, a question from the audience), a transcriber that
 * separates voices, and the turns a fake Senko would send.
 */
import type {
  CompleteDiarizeRequest,
  DiarizeJob,
  MediaSpeakers,
  RawSpeakerTurn,
  RawTranscript,
  Transcriber,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import type { Media } from './media-harness.js';
import {
  asTranscriber,
  leaseTranscription,
  pair,
  readyForTranscription,
  sendTranscript,
} from './transcription-harness.js';

type Line = readonly [start: number, end: number, text: string];

/** Six segments, one minute: A asks, B answers, A asks, B answers, C asks, B answers. */
export const CONVERSATION: readonly Line[] = [
  [0, 5, 'Mestre, o senhor está lembrado daquele dia?'],
  [
    5.5,
    15,
    'Eu lembro sim, foi numa sessão em mil novecentos e sessenta e cinco.',
  ],
  [15.5, 22, 'E como foi que o senhor chegou lá?'],
  [
    22.5,
    40,
    'Cheguei pela mão de um amigo que trabalhava na construção da casa.',
  ],
  [40.5, 45, 'Uma pergunta da plateia sobre o vegetal.'],
  [45.5, 60, 'Respondo com alegria: o vegetal é a nossa comunhão.'],
];

/** Words spread evenly over each segment, as whisper's word timestamps would be. */
function wordsOf([start, end, text]: Line) {
  const words = text.split(' ');
  const step = (end - start) / words.length;
  return words.map((word, index) => ({
    word: ` ${word}`,
    start: start + index * step,
    end: start + (index + 1) * step,
    probability: 0.95,
  }));
}

/** The raw result of transcribing CONVERSATION (one chunk). */
export function conversationRaw(
  lines: readonly Line[] = CONVERSATION,
): RawTranscript {
  return {
    chunks: [
      {
        offset: 0,
        end: 60,
        result: {
          segments: lines.map((line) => ({
            start: line[0],
            end: line[1],
            text: ` ${line[2]}`,
            avg_logprob: -0.2,
            compression_ratio: 1.3,
            no_speech_prob: 0.01,
            words: wordsOf(line),
          })),
        },
      },
    ],
  };
}

/** Senko's names: the one who answers speaks most (SPEAKER_01), the interviewer first. */
export const CONVERSATION_TURNS: readonly RawSpeakerTurn[] = [
  { start: 0, end: 5.2, voice: 'SPEAKER_02' },
  { start: 5.2, end: 15.3, voice: 'SPEAKER_01' },
  { start: 15.3, end: 22.2, voice: 'SPEAKER_02' },
  { start: 22.2, end: 40.3, voice: 'SPEAKER_01' },
  { start: 40.3, end: 45.3, voice: 'SPEAKER_03' },
  { start: 45.3, end: 60, voice: 'SPEAKER_01' },
];

/** A transcriber paired and marked to separate voices too (FR-6). */
export async function pairDiarizer(
  media: Media,
  kinds: ('transcribe' | 'diarize')[] = ['transcribe', 'diarize'],
): Promise<{ token: string; transcriber: Transcriber }> {
  const paired = await pair(media, `Mac ${kinds.join('+')}`);
  const marked = await media.owner(
    'PATCH',
    `/api/v1/media/transcribers/${paired.transcriber.id}`,
    { kinds },
  );
  expect(marked.statusCode).toBe(200);
  return { token: paired.token, transcriber: marked.json<Transcriber>() };
}

/** A ready item transcribed with `raw` by the transcriber with `token`; its id. */
export async function transcribedItem(
  media: Media,
  token: string,
  raw: RawTranscript = conversationRaw(),
): Promise<string> {
  const item = await readyForTranscription(media);
  const job = await leaseTranscription(media, token);
  const sent = await sendTranscript(media, { token, job, raw });
  expect(sent.statusCode).toBe(204);
  return item.id;
}

export const requestVoices = (
  media: Media,
  mediaId: string,
  body: { voices?: number | null } = {},
) => media.owner('POST', `/api/v1/media/${mediaId}/diarize`, body);

export async function speakersOf(
  media: Media,
  mediaId: string,
): Promise<MediaSpeakers> {
  const read = await media.owner('GET', `/api/v1/media/${mediaId}/speakers`);
  expect(read.statusCode).toBe(200);
  return read.json<MediaSpeakers>();
}

export const lease = (
  media: Media,
  token: string,
  kinds: ('transcribe' | 'diarize')[] = ['transcribe', 'diarize'],
) =>
  asTranscriber(media, token, {
    method: 'POST',
    url: '/api/v1/media-worker/jobs/lease',
    payload: { worker: 'mac', kinds },
  });

export async function leaseDiarization(
  media: Media,
  token: string,
): Promise<DiarizeJob> {
  const leased = await lease(media, token);
  expect(leased.statusCode).toBe(200);
  const job = leased.json<DiarizeJob>();
  expect(job.kind).toBe('diarize');
  return job;
}

/** The body the Mac sends for a separation. */
export const turnsOf = (
  job: DiarizeJob,
  turns: readonly RawSpeakerTurn[] = CONVERSATION_TURNS,
): CompleteDiarizeRequest => ({
  worker: 'mac',
  leaseId: job.leaseId,
  engine: 'senko',
  model: 'senko 0.1.0 (1bcb090), pyannote-3.0 segmentation + CAM++ CoreML',
  parametersVersion: '2026-11-03.1',
  parameters: { exclusive: true, maxVoices: 10 },
  requestedVoices: job.voices,
  elapsedMs: 900,
  raw: { turns: [...turns] },
});

export const sendTurns = (
  media: Media,
  input: { token: string; job: DiarizeJob; body?: object },
) =>
  asTranscriber(media, input.token, {
    method: 'POST',
    url: `/api/v1/media-worker/jobs/${input.job.id}/diarization`,
    payload: input.body ?? turnsOf(input.job),
  });
