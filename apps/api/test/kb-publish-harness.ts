/**
 * Track documents through the Mac (KBC-099, ADR 0035), driven through the real routes: a
 * transcriber marked "Publica no acervo" leases kb-publish jobs, and a fake Mac writes the
 * documents into the test's vault copy and plays kb (fixed facets, no model, no spend).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  KbPublishJob,
  MediaItem,
  PairedTranscriber,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import type { Media } from './media-harness.js';
import { asTranscriber, pair } from './transcription-harness.js';
import {
  approve,
  finishCuts,
  libraryEntry,
  transcribed,
  type Bounds,
  type Spoken,
  type World,
} from './track-items-harness.js';

/** Pairs a transcriber and marks it "Publica no acervo" (and nothing else, unless asked). */
export async function publisherMac(
  media: Media,
  kinds: readonly string[] = ['kb-publish'],
): Promise<PairedTranscriber> {
  const paired = await pair(media, 'Mac do acervo');
  const marked = await media.owner(
    'PATCH',
    `/api/v1/media/transcribers/${paired.transcriber.id}`,
    { kinds },
  );
  expect(marked.statusCode, marked.body).toBe(200);
  return paired;
}

export const leaseAs = (
  media: Media,
  token: string,
  kinds: readonly string[] = ['kb-publish'],
) =>
  asTranscriber(media, token, {
    method: 'POST',
    url: '/api/v1/media-worker/jobs/lease',
    payload: { worker: 'mac', kinds },
  });

export async function leaseKb(
  media: Media,
  token: string,
): Promise<KbPublishJob> {
  const leased = await leaseAs(media, token);
  expect(leased.statusCode, leased.body).toBe(200);
  const job = leased.json<KbPublishJob>();
  expect(job.kind).toBe('kb-publish');
  return job;
}

/** What kb adds to a document it classified: the facets the fake kb always gives. */
export const FAKE_FACETS = {
  genre: 'talk_or_interview',
  depth: 2,
  relevance: 'core',
  concepts: ['Ritmo'],
  summary: 'Uma faixa sobre o ritmo.',
};

/** Writes the job's documents into the vault, as the Mac does, with the fake kb's facets. */
export async function writeAsMac(
  vault: string,
  job: KbPublishJob,
): Promise<void> {
  for (const item of job.items) {
    const file = join(vault, job.topic, item.path);
    await mkdir(dirname(file), { recursive: true });
    const classified = item.markdown.replace(
      /^---\n/,
      `---\ngenre: ${FAKE_FACETS.genre}\ndepth: ${FAKE_FACETS.depth}\nrelevance: ${FAKE_FACETS.relevance}\nconcepts:\n  - "[[Ritmo]]"\nsummary: ${FAKE_FACETS.summary}\n`,
    );
    await writeFile(file, classified, 'utf8');
  }
}

export const kbResult = (
  media: Media,
  { token, job }: { token: string; job: KbPublishJob },
  overrides: { leaseId?: string; spendUsd?: number; ok?: boolean } = {},
) =>
  asTranscriber(media, token, {
    method: 'POST',
    url: `/api/v1/media-worker/jobs/${job.id}/kb-result`,
    payload: {
      worker: 'mac',
      leaseId: overrides.leaseId ?? job.leaseId,
      documents: job.items.map((item) => ({
        path: item.path,
        ok: overrides.ok ?? true,
        ...(overrides.ok === false
          ? { error: 'kb link: exit 1' }
          : { facets: FAKE_FACETS }),
        spendUsd: overrides.spendUsd ?? 0.0005,
      })),
    },
  });

/** A read-only look at the media database, for what no route shows yet (KBC-100). */
export function mediaDb(media: Media): DatabaseSync {
  return new DatabaseSync(join(media.mediaDir, 'media.db'), { readOnly: true });
}

export const SPEECH: readonly Spoken[] = [
  { at: 75, text: 'Pergunta sobre o ritmo' },
  { at: 113, text: 'O ritmo é a lei do pêndulo que tudo governa' },
  { at: 180, text: 'Tudo flui para fora e para dentro' },
  { at: 400, text: 'Outra pergunta sobre a polaridade' },
];

export const TRACKS: readonly Bounds[] = [
  { startMs: 72_000, endMs: 300_000, title: 'O que é o ritmo?' },
  { startMs: 300_000, endMs: 560_000, title: 'E a polaridade?' },
];

/** A recording of `hermetismo` with two approved tracks, cut and published. */
export async function publishedTracks(
  world: World,
): Promise<{ recording: MediaItem; tracks: readonly MediaItem[] }> {
  const recording = await transcribed(world, SPEECH, {
    title: 'Palestra de 12/03/2017',
  });
  await approve(world.media, recording.id, TRACKS);
  await finishCuts(world.media);
  const entry = await libraryEntry(world.media.owner, recording.id);
  return { recording, tracks: entry?.tracks ?? [] };
}
