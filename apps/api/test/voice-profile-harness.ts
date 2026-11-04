/**
 * Voice profiles under test (KBC-071): the owner granted by name, a transcriber marked for
 * prints, and synthetic vectors. No print here comes from a recording (BR-1).
 */
import type {
  CollectionSpeaker,
  DiarizeJob,
  MediaSpeakers,
  Person,
  Transcriber,
  VoiceConsent,
  VoiceMatch,
  VoiceProfile,
  VoiceProfileJob,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import {
  CONVERSATION_TURNS,
  conversationRaw,
  leaseDiarization,
  requestVoices,
  sendTurns,
  speakersOf,
  turnsOf,
} from './diarization-harness.js';
import type { Media } from './media-harness.js';
import {
  asTranscriber,
  leaseTranscription,
  pair,
  readyForTranscription,
  sendTranscript,
} from './transcription-harness.js';

const ALL_KINDS = ['transcribe', 'diarize', 'voice-profile'] as const;
export const PROFILES = '/api/v1/topics/hermetismo/voice-profiles';
export const SPEAKERS = '/api/v1/topics/hermetismo/speakers';
export const ECAPA = 'speechbrain/spkrec-ecapa-voxceleb';

/** A unit vector made up from `seed`: no voice ever produced it. */
export function syntheticPrint(seed: number, size = 192): number[] {
  const raw = Array.from({ length: size }, (_, index) =>
    Math.sin(seed * 12.9898 + index * 78.233),
  );
  const norm = Math.hypot(...raw);
  return raw.map((value) => value / norm);
}

export const aConsent = (overrides: Partial<VoiceConsent> = {}) => ({
  subject: 'living',
  grantedBy: 'Gabriel da Costa',
  grantedByRole: null,
  grantedOn: '2026-10-01',
  method: 'signed-paper',
  purpose: 'suggest-names-when-editing',
  textVersion: 1,
  evidence: { kind: 'text', text: 'Autorizo o uso da minha voz para sugerir.' },
  ...overrides,
});

/** Grants the feature to the owner by name: being a master does not give it (ADR 0032). */
export async function grantVoiceProfiles(media: Media): Promise<void> {
  const people = await media.owner('GET', '/api/v1/people');
  const owner = people
    .json<{ items: Person[] }>()
    .items.find((one) => one.email === 'owner@example.com');
  if (!owner) throw new Error('no owner');
  const granted = await media.owner('PATCH', `/api/v1/people/${owner.id}`, {
    features: [...owner.features, 'media-voice-profiles'],
  });
  expect(granted.statusCode, granted.body).toBe(200);
}

export async function pairVoicePrinter(
  media: Media,
  kinds: readonly string[] = ALL_KINDS,
): Promise<{ token: string; transcriber: Transcriber }> {
  const paired = await pair(media, `Mac ${kinds.join('+')}`);
  const marked = await media.owner(
    'PATCH',
    `/api/v1/media/transcribers/${paired.transcriber.id}`,
    { kinds },
  );
  expect(marked.statusCode, marked.body).toBe(200);
  return { token: paired.token, transcriber: marked.json<Transcriber>() };
}

export async function aSpeaker(
  media: Media,
  name: string,
  speakers = SPEAKERS,
): Promise<CollectionSpeaker> {
  const created = await media.owner('POST', speakers, { name });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<CollectionSpeaker>();
}

export async function transcribedIn(
  media: Media,
  input: { token: string; topic?: string },
): Promise<string> {
  const item = await readyForTranscription(media, input.topic);
  const job = await leaseTranscription(media, input.token);
  const sent = await sendTranscript(media, {
    token: input.token,
    job,
    raw: conversationRaw(),
  });
  expect(sent.statusCode, sent.body).toBe(204);
  return item.id;
}

/** Separates the voices of a recording, with what the Mac found by voice. */
export async function separate(
  media: Media,
  input: {
    token: string;
    mediaId: string;
    matches?: readonly VoiceMatch[];
  },
): Promise<DiarizeJob> {
  expect((await requestVoices(media, input.mediaId)).statusCode).toBe(202);
  const job = await leaseDiarization(media, input.token);
  const sent = await sendTurns(media, {
    token: input.token,
    job,
    body: {
      ...turnsOf(job, CONVERSATION_TURNS),
      voiceMatches: input.matches ?? [],
    },
  });
  expect(sent.statusCode, sent.body).toBe(204);
  return job;
}

export const nameVoice = (
  media: Media,
  target: { mediaId: string; voice: number; speakerId: string },
) =>
  media.owner('PUT', `/api/v1/media/${target.mediaId}/voices/${target.voice}`, {
    version: 1,
    speakerId: target.speakerId,
    audience: false,
  });

/** The one who answers in the conversation: voice 2, 41 s of speech. */
export const ANSWERS = { voice: 'SPEAKER_01', number: 2 } as const;

/** A recording whose answering voice a person named; its id. */
export async function namedRecording(
  media: Media,
  input: { token: string; speakerId: string },
): Promise<string> {
  const mediaId = await transcribedIn(media, input);
  await separate(media, { token: input.token, mediaId });
  const named = await nameVoice(media, {
    mediaId,
    voice: ANSWERS.number,
    speakerId: input.speakerId,
  });
  expect(named.statusCode, named.body).toBe(200);
  return mediaId;
}

export const leaseKinds = (
  media: Media,
  input: { token: string; kinds: readonly string[] },
) =>
  asTranscriber(media, input.token, {
    method: 'POST',
    url: '/api/v1/media-worker/jobs/lease',
    payload: { worker: 'mac', kinds: input.kinds },
  });

export async function leasePrintJob(
  media: Media,
  token: string,
): Promise<VoiceProfileJob> {
  const leased = await leaseKinds(media, { token, kinds: ['voice-profile'] });
  expect(leased.statusCode, leased.body).toBe(200);
  return leased.json<VoiceProfileJob>();
}

export const sendPrint = (
  media: Media,
  input: { token: string; job: { id: string; leaseId: string }; seed: number },
) =>
  asTranscriber(media, input.token, {
    method: 'POST',
    url: `/api/v1/media-worker/jobs/${input.job.id}/voice-print`,
    payload: {
      worker: 'mac',
      leaseId: input.job.leaseId,
      model: ECAPA,
      embedding: syntheticPrint(input.seed),
    },
  });

export const profilesForJob = (
  media: Media,
  input: { token: string; job: DiarizeJob },
) =>
  asTranscriber(media, input.token, {
    method: 'GET',
    url: `/api/v1/media-worker/jobs/${input.job.id}/voice-profiles?leaseId=${input.job.leaseId}`,
  });

/** A speaker with a consent, a source voice and its print stored. */
export async function readyProfile(
  media: Media,
  input: { token: string; name: string; seed?: number },
): Promise<{ profile: VoiceProfile; speaker: CollectionSpeaker }> {
  const speaker = await aSpeaker(media, input.name);
  const mediaId = await namedRecording(media, {
    token: input.token,
    speakerId: speaker.id,
  });
  const created = await media.owner('POST', PROFILES, {
    speakerId: speaker.id,
    sources: [{ mediaId, voice: ANSWERS.number }],
    consent: aConsent(),
  });
  expect(created.statusCode, created.body).toBe(201);
  const job = await leasePrintJob(media, input.token);
  const sent = await sendPrint(media, {
    token: input.token,
    job,
    seed: input.seed ?? 1,
  });
  expect(sent.statusCode, sent.body).toBe(204);
  return { profile: created.json<VoiceProfile>(), speaker };
}

export const suggestionsOf = async (
  media: Media,
  mediaId: string,
): Promise<MediaSpeakers['voiceSuggestions']> =>
  (await speakersOf(media, mediaId)).voiceSuggestions;

export const decide = (
  media: Media,
  input: { mediaId: string; voice: number; decision: 'accept' | 'refuse' },
) =>
  media.owner(
    'POST',
    `/api/v1/media/${input.mediaId}/voices/${input.voice}/suggestion`,
    { version: 1, decision: input.decision },
  );
