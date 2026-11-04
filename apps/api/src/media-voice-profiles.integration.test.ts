import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Me,
  VoiceProfileList,
  VoiceProfileReport,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { REVOCATION_LIST_HEADER } from './adapters/media/fs-voice-revocation-list.js';
import { MAX_JOB_ATTEMPTS } from './modules/media/index.js';
import { closeApp } from '../test/ai-app-harness.js';
import {
  leaseDiarization,
  requestVoices,
} from '../test/diarization-harness.js';
import { member, startMedia, type Media } from '../test/media-harness.js';
import { asTranscriber } from '../test/transcription-harness.js';
import {
  ANSWERS,
  ECAPA,
  PROFILES,
  aConsent,
  aSpeaker,
  decide,
  grantVoiceProfiles,
  leaseKinds,
  leasePrintJob,
  namedRecording,
  pairVoicePrinter,
  profilesForJob,
  readyProfile,
  sendPrint,
  separate,
  suggestionsOf,
  syntheticPrint,
  transcribedIn,
} from '../test/voice-profile-harness.js';

afterEach(closeApp);

const PRINTS = 'voice-prints';
const printFiles = (media: Media): string[] => {
  try {
    return readdirSync(join(media.mediaDir, PRINTS));
  } catch {
    return [];
  }
};
const match = (profileId: string, similarity: number) => ({
  voice: ANSWERS.voice,
  profileId,
  similarity,
});

async function granted() {
  const media = await startMedia();
  await grantVoiceProfiles(media);
  const { token } = await pairVoicePrinter(media);
  return { media, token };
}

const profiles = async (media: Media) =>
  (await media.owner('GET', PROFILES)).json<VoiceProfileList>().items;

const report = async (media: Media) =>
  (
    await media.owner('GET', '/api/v1/voice-profiles/report')
  ).json<VoiceProfileReport>().items;

describe('The permission (KBC-071 AC-7, ADR 0032)', () => {
  it('is off for a master until it is granted to that master by name', async () => {
    const media = await startMedia();
    const me = (await media.owner('GET', '/api/v1/me')).json<Me>();
    expect(me.role).toBe('master');
    expect(me.features).not.toContain('media-voice-profiles');
    expect((await media.owner('GET', PROFILES)).statusCode).toBe(403);
    await grantVoiceProfiles(media);
    expect((await media.owner('GET', PROFILES)).statusCode).toBe(200);
  });

  it('AC-7: `media-edit` without it is 403, on every route', async () => {
    const media = await startMedia();
    const { call } = await member(media, {
      email: 'edita@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit'],
    });
    for (const [method, url] of [
      ['GET', PROFILES],
      ['POST', PROFILES],
      ['GET', '/api/v1/voice-profiles/report'],
    ] as const)
      expect((await call(method, url, {})).statusCode).toBe(403);
  });

  it("does nothing in a member's list: it needs the master role too", async () => {
    const media = await startMedia();
    const { call } = await member(media, {
      email: 'edita@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit', 'media-voice-profiles'],
    });
    expect((await call('GET', PROFILES)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/me')).json<Me>().features).not.toContain(
      'media-voice-profiles',
    );
  });
});

describe('Registering a profile (KBC-071 FR-1, FR-2, BR-1)', () => {
  it('AC-1: without a consent it is 422 and nothing is stored', async () => {
    const { media, token } = await granted();
    const speaker = await aSpeaker(media, 'Mestre Gabriel');
    const mediaId = await namedRecording(media, {
      token,
      speakerId: speaker.id,
    });
    const body = {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
    };
    const refused = await media.owner('POST', PROFILES, body);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('CONSENT_REQUIRED');
    expect(await profiles(media)).toEqual([]);
    expect(await report(media)).toEqual([]);
    expect(
      (await leaseKinds(media, { token, kinds: ['voice-profile'] })).statusCode,
    ).toBe(204);
  });

  it.each([
    ['another purpose', { purpose: 'marketing' }],
    ['a date to come', { grantedOn: '2999-01-01' }],
    ['no proof', { evidence: { kind: 'text', text: '' } }],
    ['a deceased person with nobody answering', { subject: 'deceased' }],
  ])('AC-1: %s is 422', async (_, overrides) => {
    const { media, token } = await granted();
    const speaker = await aSpeaker(media, 'Mestre Gabriel');
    const mediaId = await namedRecording(media, {
      token,
      speakerId: speaker.id,
    });
    const refused = await media.owner('POST', PROFILES, {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
      consent: aConsent(overrides as object),
    });
    expect(refused.statusCode).toBe(422);
  });

  it('takes only a voice a person named as that speaker', async () => {
    const { media, token } = await granted();
    const speaker = await aSpeaker(media, 'Mestre Gabriel');
    const other = await aSpeaker(media, 'Outra pessoa');
    const mediaId = await namedRecording(media, {
      token,
      speakerId: speaker.id,
    });
    const refused = await media.owner('POST', PROFILES, {
      speakerId: other.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
      consent: aConsent(),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details).toEqual({ field: 'sources' });
  });

  it('refuses a voice with too little speech for a print', async () => {
    const { media, token } = await granted();
    const speaker = await aSpeaker(media, 'Quem pergunta');
    const mediaId = await transcribedIn(media, { token });
    await separate(media, { token, mediaId });
    await media.owner('PUT', `/api/v1/media/${mediaId}/voices/3`, {
      version: 1,
      speakerId: speaker.id,
      audience: false,
    });
    const refused = await media.owner('POST', PROFILES, {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: 3 }],
      consent: aConsent(),
    });
    expect(refused.statusCode).toBe(400);
  });

  it('a speaker has one profile; a deceased person needs who answers for the work', async () => {
    const { media, token } = await granted();
    const speaker = await aSpeaker(media, 'Mestre Gabriel');
    const mediaId = await namedRecording(media, {
      token,
      speakerId: speaker.id,
    });
    const body = {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
      consent: aConsent({
        subject: 'deceased',
        grantedBy: 'Instituição',
        grantedByRole: 'Presidente',
      }),
    };
    expect((await media.owner('POST', PROFILES, body)).statusCode).toBe(201);
    expect((await media.owner('POST', PROFILES, body)).statusCode).toBe(409);
  });

  it('FR-2: the print goes only to a transcriber marked for it, and is stored sealed', async () => {
    const media = await startMedia();
    await grantVoiceProfiles(media);
    const { token: plain } = await pairVoicePrinter(media, [
      'transcribe',
      'diarize',
    ]);
    const speaker = await aSpeaker(media, 'Mestre Gabriel');
    const mediaId = await namedRecording(media, {
      token: plain,
      speakerId: speaker.id,
    });
    await media.owner('POST', PROFILES, {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
      consent: aConsent(),
    });
    expect((await profiles(media))[0]?.status).toBe('calculating');
    const refused = await leaseKinds(media, {
      token: plain,
      kinds: ['voice-profile'],
    });
    expect(refused.statusCode).toBe(403);

    const { token } = await pairVoicePrinter(media);
    const job = await leasePrintJob(media, token);
    expect(job.sources).toHaveLength(1);
    const [source] = job.sources;
    expect(source?.spans[0]).toEqual({ startMs: 5200, endMs: 15300 });
    const audio = await asTranscriber(media, token, {
      method: 'GET',
      url: `${source?.audioPath}?leaseId=${job.leaseId}`,
    });
    expect(audio.statusCode).toBe(200);
    const stranger = await asTranscriber(media, token, {
      method: 'GET',
      url: `/api/v1/media-worker/jobs/${job.id}/audio/22222222-2222-4222-8222-222222222222?leaseId=${job.leaseId}`,
    });
    expect(stranger.statusCode).toBe(404);

    expect((await sendPrint(media, { token, job, seed: 7 })).statusCode).toBe(
      204,
    );
    expect((await profiles(media))[0]?.status).toBe('ready');
    const [file] = printFiles(media);
    const path = join(media.mediaDir, PRINTS, file ?? '');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk.startsWith('enc:v1:')).toBe(true);
    expect(onDisk).not.toContain(String(syntheticPrint(7)[0]));
    const database = readFileSync(join(media.mediaDir, 'media.db'));
    expect(database.includes(onDisk.slice(0, 40))).toBe(false);
  });

  it('a job given up asks to calculate again', async () => {
    const { media, token } = await granted();
    const speaker = await aSpeaker(media, 'Mestre Gabriel');
    const mediaId = await namedRecording(media, {
      token,
      speakerId: speaker.id,
    });
    await media.owner('POST', PROFILES, {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
      consent: aConsent(),
    });
    for (let attempt = 0; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
      const job = await leasePrintJob(media, token);
      const failed = await asTranscriber(media, token, {
        method: 'POST',
        url: `/api/v1/media-worker/jobs/${job.id}/fail`,
        payload: {
          worker: 'mac',
          leaseId: job.leaseId,
          failure: 'conversion-failed',
          detail: 'x',
        },
      });
      expect(failed.statusCode).toBe(204);
    }
    const [profile] = await profiles(media);
    expect(profile?.status).toBe('failed');
    const again = await media.owner(
      'POST',
      `/api/v1/voice-profiles/${profile?.id}/recalculate`,
      {},
    );
    expect(again.statusCode, again.body).toBe(200);
    expect((await profiles(media))[0]?.status).toBe('calculating');
  });
});

describe('Suggesting a name by voice (KBC-071 FR-3)', () => {
  it('AC-2: a close voice reads "parece ser", and becomes a name only when accepted', async () => {
    const { media, token } = await granted();
    const { profile, speaker } = await readyProfile(media, {
      token,
      name: 'Mestre Gabriel',
    });
    const mediaId = await transcribedIn(media, { token });
    await separate(media, {
      token,
      mediaId,
      matches: [match(profile.id, 0.55)],
    });
    expect(await suggestionsOf(media, mediaId)).toEqual([
      {
        voice: ANSWERS.number,
        speakerId: speaker.id,
        name: 'Mestre Gabriel',
        level: 'high',
      },
    ]);
    const before = await media.owner(
      'GET',
      `/api/v1/media/${mediaId}/speakers`,
    );
    expect(before.json().diarization.labels[1].kind).toBe('unnamed');

    const accepted = await decide(media, {
      mediaId,
      voice: ANSWERS.number,
      decision: 'accept',
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().diarization.labels[1].name).toBe('Mestre Gabriel');
    expect(accepted.json().voiceSuggestions).toEqual([]);
  });

  it('refusing leaves the voice unnamed and asks no more', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    const mediaId = await transcribedIn(media, { token });
    await separate(media, {
      token,
      mediaId,
      matches: [match(profile.id, 0.45)],
    });
    expect((await suggestionsOf(media, mediaId))[0]?.level).toBe('medium');
    const refused = await decide(media, {
      mediaId,
      voice: ANSWERS.number,
      decision: 'refuse',
    });
    expect(refused.json().diarization.labels[1].kind).toBe('unnamed');
    expect(refused.json().voiceSuggestions).toEqual([]);
    const repeated = await decide(media, {
      mediaId,
      voice: ANSWERS.number,
      decision: 'accept',
    });
    expect(repeated.statusCode).toBe(404);
  });

  it('AC-4: a voice under the threshold gets no suggestion', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    const mediaId = await transcribedIn(media, { token });
    await separate(media, {
      token,
      mediaId,
      matches: [match(profile.id, 0.399)],
    });
    expect(await suggestionsOf(media, mediaId)).toEqual([]);
    expect((await report(media))[0]?.suggestions.made).toBe(0);
  });

  it('AC-5: a profile is not sent for, nor kept from, another collection', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    const elsewhere = await transcribedIn(media, { token, topic: 'alquimia' });
    expect((await requestVoices(media, elsewhere)).statusCode).toBe(202);
    const job = await leaseDiarization(media, token);
    const sent = await profilesForJob(media, { token, job });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().profiles).toEqual([]);
    await asTranscriber(media, token, {
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/diarization`,
      payload: {
        worker: 'mac',
        leaseId: job.leaseId,
        engine: 'senko',
        model: 'm',
        parametersVersion: 'p',
        parameters: {},
        requestedVoices: null,
        elapsedMs: 1,
        raw: { turns: [{ start: 0, end: 5, voice: ANSWERS.voice }] },
        voiceMatches: [match(profile.id, 0.9)],
      },
    });
    expect(await suggestionsOf(media, elsewhere)).toEqual([]);
  });

  it("sends the prints of the job's collection during its lease, and only to a marked token", async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    const mediaId = await transcribedIn(media, { token });
    expect((await requestVoices(media, mediaId)).statusCode).toBe(202);
    const job = await leaseDiarization(media, token);
    const sent = await profilesForJob(media, { token, job });
    expect(sent.json().profiles).toEqual([
      { id: profile.id, model: ECAPA, embedding: syntheticPrint(1) },
    ]);
    const { token: unmarked } = await pairVoicePrinter(media, ['diarize']);
    expect(
      (await profilesForJob(media, { token: unmarked, job })).statusCode,
    ).toBe(404);
  });
});

describe('Revoking (KBC-071 FR-4, BR-2)', () => {
  it('AC-3, NFR-2: the print, the profile and the pending suggestions go at once; confirmed names stay', async () => {
    const { media, token } = await granted();
    const { profile, speaker } = await readyProfile(media, {
      token,
      name: 'Gabriel',
    });
    const recordings: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const mediaId = await transcribedIn(media, { token });
      await separate(media, {
        token,
        mediaId,
        matches: [match(profile.id, 0.6)],
      });
      recordings.push(mediaId);
    }
    for (const mediaId of recordings.slice(0, 2))
      await decide(media, {
        mediaId,
        voice: ANSWERS.number,
        decision: 'accept',
      });
    expect(printFiles(media)).toHaveLength(1);

    const started = performance.now();
    const revoked = await media.owner(
      'DELETE',
      `/api/v1/voice-profiles/${profile.id}`,
    );
    expect(performance.now() - started).toBeLessThan(60_000);
    expect(revoked.statusCode).toBe(204);

    expect(printFiles(media)).toEqual([]);
    expect(await profiles(media)).toEqual([]);
    for (const mediaId of recordings.slice(2))
      expect(await suggestionsOf(media, mediaId)).toEqual([]);
    for (const mediaId of recordings.slice(0, 2)) {
      const read = await media.owner(
        'GET',
        `/api/v1/media/${mediaId}/speakers`,
      );
      expect(read.json().diarization.labels[1].speakerId).toBe(speaker.id);
    }
    const again = await media.owner(
      'DELETE',
      `/api/v1/voice-profiles/${profile.id}`,
    );
    expect(again.statusCode).toBe(404);
  });

  it('a print arriving after the revocation is dropped', async () => {
    const { media, token } = await granted();
    const speaker = await aSpeaker(media, 'Gabriel');
    const mediaId = await namedRecording(media, {
      token,
      speakerId: speaker.id,
    });
    const created = await media.owner('POST', PROFILES, {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
      consent: aConsent(),
    });
    const job = await leasePrintJob(media, token);
    await media.owner('DELETE', `/api/v1/voice-profiles/${created.json().id}`);
    expect((await sendPrint(media, { token, job, seed: 2 })).statusCode).toBe(
      409,
    );
    expect(printFiles(media)).toEqual([]);
  });

  it('a match for a profile revoked during the job is dropped', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    await media.owner('DELETE', `/api/v1/voice-profiles/${profile.id}`);
    const mediaId = await transcribedIn(media, { token });
    await separate(media, {
      token,
      mediaId,
      matches: [match(profile.id, 0.9)],
    });
    expect(await suggestionsOf(media, mediaId)).toEqual([]);
  });
});

describe('A backup from before a revocation (KBC-071 BR-1, BR-2, ADR 0032)', () => {
  const REVOCATIONS = 'voice-revocations.list';

  function snapshotDatabase(media: Media): string {
    const copy = join(media.started.state, 'before-revocation.db');
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    db.exec(`VACUUM INTO '${copy}'`);
    db.close();
    return copy;
  }

  async function restoreAndRestart(media: Media, copy: string): Promise<Media> {
    await closeApp();
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(join(media.mediaDir, `media.db${suffix}`), { force: true });
    copyFileSync(copy, join(media.mediaDir, 'media.db'));
    return startMedia({ state: media.started.state });
  }

  async function revokedThenRestored() {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    const copy = snapshotDatabase(media);
    await media.owner('DELETE', `/api/v1/voice-profiles/${profile.id}`);
    const restored = await restoreAndRestart(media, copy);
    // Another run has another token key, and the old pairing keeps its name.
    const { token: renewed } = await pairVoicePrinter(restored, [
      'diarize',
      'transcribe',
      'voice-profile',
    ]);
    return { token: renewed, profile, restored };
  }

  it('does not bring the consent back, and no print can be queued', async () => {
    const { restored, token, profile } = await revokedThenRestored();
    const [consent] = await report(restored);
    expect(consent?.revokedAt).not.toBeNull();
    expect(consent?.revokedBy).toBe('lista de revogações');
    expect(await profiles(restored)).toEqual([]);
    const again = await restored.owner(
      'POST',
      `/api/v1/voice-profiles/${profile.id}/recalculate`,
      {},
    );
    expect(again.statusCode).toBe(404);
    expect(
      (await leaseKinds(restored, { token, kinds: ['voice-profile'] }))
        .statusCode,
    ).toBe(204);
    expect(
      restored.started.logs.some((line) =>
        line.includes('voice prints reconciled'),
      ),
    ).toBe(true);
  });

  it('a new consent after the revocation is a new profile, and it works', async () => {
    const { restored, token, profile } = await revokedThenRestored();
    const { profile: next } = await readyProfile(restored, {
      token,
      name: 'Gabriel de novo',
      seed: 5,
    });
    expect(next.id).not.toBe(profile.id);
    expect((await profiles(restored)).map(({ status }) => status)).toEqual([
      'ready',
    ]);
  });

  it('refuses to queue or store a print of an id on the list, whatever the database says', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    const speaker = await aSpeaker(media, 'Outra voz');
    const mediaId = await namedRecording(media, {
      token,
      speakerId: speaker.id,
    });
    const pending = await media.owner('POST', PROFILES, {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
      consent: aConsent(),
    });
    const job = await leasePrintJob(media, token);
    const list = join(media.mediaDir, REVOCATIONS);
    appendFileSync(list, `\n${profile.id}\n${pending.json().id}\n`);
    const again = await media.owner(
      'POST',
      `/api/v1/voice-profiles/${profile.id}/recalculate`,
      {},
    );
    expect(again.statusCode).toBe(409);
    expect((await sendPrint(media, { token, job, seed: 3 })).statusCode).toBe(
      409,
    );
    expect(printFiles(media)).toEqual([`${profile.id}.sealed`]);
  });

  it('with the list lost alongside the disk, says so and makes no print', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    await closeApp();
    rmSync(join(media.mediaDir, REVOCATIONS));
    rmSync(join(media.mediaDir, PRINTS), { recursive: true });
    const restarted = await startMedia({ state: media.started.state });
    expect(
      restarted.started.logs.some((line) =>
        line.includes('voice revocation list is lost'),
      ),
    ).toBe(true);
    const again = await restarted.owner(
      'POST',
      `/api/v1/voice-profiles/${profile.id}/recalculate`,
      {},
    );
    expect(again.statusCode).toBe(409);
    await restarted.owner('DELETE', `/api/v1/voice-profiles/${profile.id}`);
    expect(await profiles(restarted)).toEqual([]);
  });

  it('checked by the owner, the lost list works again', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    await closeApp();
    rmSync(join(media.mediaDir, REVOCATIONS));
    const restarted = await startMedia({ state: media.started.state });
    appendFileSync(
      join(media.mediaDir, REVOCATIONS),
      `${REVOCATION_LIST_HEADER}\n`,
    );
    const again = await restarted.owner(
      'POST',
      `/api/v1/voice-profiles/${profile.id}/recalculate`,
      {},
    );
    expect(again.statusCode).toBe(200);
  });

  it('a crash after the list wrote the revocation is finished by the next start', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    await closeApp();
    appendFileSync(join(media.mediaDir, REVOCATIONS), `\n${profile.id}\n`);
    const restarted = await startMedia({ state: media.started.state });
    expect(await profiles(restarted)).toEqual([]);
    expect(printFiles(restarted)).toEqual([]);
  });

  it('a write a crash left unfinished goes when the API starts', async () => {
    const { media, token } = await granted();
    await readyProfile(media, { token, name: 'Gabriel' });
    await closeApp();
    const lost = `${randomUUID()}.tmp`;
    writeFileSync(join(media.mediaDir, PRINTS, lost), 'half a sealed print');
    const restarted = await startMedia({ state: media.started.state });
    expect(printFiles(restarted)).not.toContain(lost);
  });

  it('a revocation puts its id on the list, and nothing else about the person', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    await media.owner('DELETE', `/api/v1/voice-profiles/${profile.id}`);
    const lines = readFileSync(join(media.mediaDir, REVOCATIONS), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines).toEqual([REVOCATION_LIST_HEADER, profile.id]);
  });
});

describe('Nothing leaves for the browser or the log (KBC-071 AC-6, BR-5)', () => {
  it('AC-6: no response to a person, and no log line, has a print', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    const mediaId = await transcribedIn(media, { token });
    await separate(media, {
      token,
      mediaId,
      matches: [match(profile.id, 0.6)],
    });
    const piece = String(syntheticPrint(1)[0]).slice(0, 10);
    const reads = [
      PROFILES,
      '/api/v1/voice-profiles/report',
      `/api/v1/media/${mediaId}/speakers`,
      `/api/v1/media/${mediaId}/transcript`,
    ];
    for (const url of reads) {
      const read = await media.owner('GET', url);
      expect(read.statusCode, url).toBe(200);
      expect(read.body).not.toContain('embedding');
      expect(read.body).not.toContain(piece);
      expect(read.body).not.toContain('similarity');
    }
    const logs = media.started.logs.join('\n');
    expect(logs).not.toContain(piece);
  });

  it('a raw file keeps the turns only: matches are not written with them', async () => {
    const { media, token } = await granted();
    const { profile } = await readyProfile(media, { token, name: 'Gabriel' });
    const mediaId = await transcribedIn(media, { token });
    await separate(media, {
      token,
      mediaId,
      matches: [match(profile.id, 0.6)],
    });
    const raw = readdirSync(join(media.mediaDir, 'transcripts', mediaId), {
      recursive: true,
    })
      .map(String)
      .filter((name) => name.includes('diarization'));
    expect(raw.length).toBeGreaterThan(0);
    for (const name of raw)
      expect(
        readFileSync(
          join(media.mediaDir, 'transcripts', mediaId, name),
          'utf8',
        ),
      ).not.toContain(profile.id);
  });
});

describe('"Perfis e consentimentos" (KBC-071 FR-5)', () => {
  it('AC-8: shows each consent, the revocation with its date and the counts', async () => {
    const { media, token } = await granted();
    const first = await readyProfile(media, { token, name: 'Gabriel' });
    const mediaId = await transcribedIn(media, { token });
    await separate(media, {
      token,
      mediaId,
      matches: [match(first.profile.id, 0.6)],
    });
    await decide(media, { mediaId, voice: ANSWERS.number, decision: 'accept' });
    await media.owner('DELETE', `/api/v1/voice-profiles/${first.profile.id}`);

    const [entry] = await report(media);
    expect(entry).toMatchObject({
      speakerName: 'Gabriel',
      collection: 'hermetismo',
      grantedBy: 'Gabriel da Costa',
      method: 'signed-paper',
      purpose: 'suggest-names-when-editing',
      registeredBy: 'owner@example.com',
      revokedBy: 'owner@example.com',
      evidence: 'text',
      suggestions: { made: 1, accepted: 1, refused: 0 },
    });
    expect(entry?.revokedAt).toEqual(expect.any(String));
    const evidence = await media.owner(
      'GET',
      `/api/v1/voice-consents/${entry?.id}/evidence`,
    );
    expect(evidence.statusCode).toBe(200);
    expect(evidence.body).toContain('Autorizo o uso');
    expect(evidence.headers['content-disposition']).toContain('attachment');
  });

  it('keeps an attached document sealed and gives it back whole', async () => {
    const { media, token } = await granted();
    const speaker = await aSpeaker(media, 'Gabriel');
    const mediaId = await namedRecording(media, {
      token,
      speakerId: speaker.id,
    });
    const document = Buffer.from('%PDF-1.7 um documento assinado de teste');
    const created = await media.owner('POST', PROFILES, {
      speakerId: speaker.id,
      sources: [{ mediaId, voice: ANSWERS.number }],
      consent: aConsent({
        evidence: {
          kind: 'attachment',
          fileName: 'consentimento.pdf',
          mime: 'application/pdf',
          data: document.toString('base64'),
        },
      }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const [entry] = await report(media);
    expect(entry?.evidence).toBe('attachment');
    const read = await media.owner(
      'GET',
      `/api/v1/voice-consents/${entry?.id}/evidence`,
    );
    expect(read.headers['content-type']).toBe('application/pdf');
    expect(read.rawPayload.equals(document)).toBe(true);
  });
});
