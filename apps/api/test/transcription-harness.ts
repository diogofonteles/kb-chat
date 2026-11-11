/**
 * The transcription protocol under test (KBC-036): a master pairs a transcriber, and a fake
 * transcriber leases, downloads and answers a reduced raw result of the pilot.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CompleteTranscribeRequest,
  MediaItem,
  PairedTranscriber,
  RawTranscript,
  TranscribeJob,
  WorkerJob,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import { LOCAL } from './ai-app-harness.js';
import {
  CONVERTED,
  leaseJob,
  queuedItem,
  worker,
  type Media,
} from './media-harness.js';
import { pilotRaw } from './transcript-fixtures.js';

/** 16 bytes standing for the 16 kHz FLAC the VM worker makes. */
export const FLAC = Buffer.from('fLaC fake 16 kHz');

export async function pair(media: Media, name = 'Mac do dono') {
  const paired = await media.owner('POST', '/api/v1/media/transcribers', {
    name,
  });
  expect(paired.statusCode).toBe(201);
  return paired.json<PairedTranscriber>();
}

/** A request as the transcriber with `token`. */
export const asTranscriber = (
  media: Media,
  token: string,
  request: { method: 'GET' | 'POST'; url: string; payload?: object },
) =>
  media.started.app.inject({
    ...request,
    headers: { ...LOCAL, authorization: `Bearer ${token}` },
  });

export async function leaseTranscription(
  media: Media,
  token: string,
): Promise<TranscribeJob> {
  const leased = await asTranscriber(media, token, {
    method: 'POST',
    url: '/api/v1/media-worker/jobs/lease',
    payload: { worker: 'mac', kinds: ['transcribe'] },
  });
  expect(leased.statusCode).toBe(200);
  return leased.json<TranscribeJob>();
}

/** The body the Mac sends for a job: a raw result of the pilot by default. */
export const transcriptOf = (
  job: TranscribeJob,
  raw: RawTranscript = pilotRaw('clean-cd01-01'),
): CompleteTranscribeRequest => ({
  worker: 'mac',
  leaseId: job.leaseId,
  provider: 'mlx-whisper',
  model: 'mlx-community/whisper-large-v3-turbo',
  parametersVersion: '2026-10-28.1',
  parameters: { language: 'pt', vad: { threshold: 0.5 } },
  termsVersion: 1,
  vad: 'applied',
  speechRatio: 0.82,
  elapsedMs: 4_200,
  raw,
});

export const sendTranscript = (
  media: Media,
  input: { token: string; job: TranscribeJob; raw?: RawTranscript },
) =>
  asTranscriber(media, input.token, {
    method: 'POST',
    url: `/api/v1/media-worker/jobs/${input.job.id}/transcript`,
    payload: transcriptOf(input.job, input.raw),
  });

/** The VM worker converts with the transcriber's FLAC alongside (ADR 0022 §4). */
export async function convertWithFlac(
  media: Media,
  job: WorkerJob,
  durationMs = 180_000,
) {
  writeFileSync(join(media.mediaDir, job.targetPath), CONVERTED);
  if (!job.flacTargetPath) throw new Error('the job names no FLAC path');
  writeFileSync(join(media.mediaDir, job.flacTargetPath), FLAC);
  return worker(media, `/api/v1/media-worker/jobs/${job.id}/complete`, {
    worker: 'vm',
    leaseId: job.leaseId,
    durationMs,
    bytes: CONVERTED.length,
    flacBytes: FLAC.length,
  });
}

/** An item converted with its FLAC: ready, and waiting for the transcriber. */
export async function readyForTranscription(
  media: Media,
  topic?: string,
): Promise<MediaItem> {
  const item = await queuedItem(media, topic);
  const done = await convertWithFlac(media, await leaseJob(media));
  expect(done.statusCode).toBe(204);
  return item;
}
