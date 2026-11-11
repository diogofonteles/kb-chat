import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EditTrack } from '@kb-chat/contracts';
import {
  StubLlm,
  evenSegments,
  itemOf,
  proposalDb,
} from '../test/track-proposal-fixtures.js';
import { SqliteMediaEditStore } from './adapters/sqlite/sqlite-media-edit-store.js';
import type { MediaActor } from './modules/media/index.js';
import { ProposalService } from './modules/track-proposals/index.js';
import { TrackEditService } from './modules/media-edit/index.js';

const OWNER: MediaActor = {
  principal: 'owner',
  isMaster: true,
  canUpload: true,
  canSee: () => true,
  levelsIn: () => null,
};

const manual = (startMs: number, endMs: number): EditTrack => ({
  id: randomUUID(),
  source: 'manual',
  startMs,
  endMs,
  kind: 'qa',
  title: 'Da pessoa',
  askerVoice: null,
  answererVoice: null,
  askerSpeakerId: null,
  answererSpeakerId: null,
});

const reply = (titles: readonly string[]) => () =>
  JSON.stringify({
    faixas: titles.map((titulo, index) => ({
      primeiro_id: index * 5 + 1,
      ultimo_id: index * 5 + 5,
      tipo: 'pergunta_resposta',
      quem_pergunta: null,
      quem_responde: null,
      titulo,
      continua_faixa_anterior: false,
    })),
    vozes: [],
  });

const LONG_RECORDING_MS = 7_200_000;

function setup(titles: readonly string[] = ['Primeira', 'Segunda']) {
  const db = proposalDb(evenSegments(30));
  const llm = new StubLlm([reply(titles)]);
  const findMedia = (_actor: MediaActor, id: string) => ({
    ...itemOf(id, null),
    durationMs: LONG_RECORDING_MS,
  });
  const proposals = new ProposalService({
    store: db.store,
    ledger: db.ledger,
    transcripts: db.transcripts,
    findMedia,
    contextOf: () => ({ collection: 'Hermetismo', knownNames: [] }),
    segmentVoices: () => null,
    llm: () => llm,
    caps: { runUsd: 0.25, monthlyUsd: 10 },
  });
  const edits = new TrackEditService({
    plans: { get: () => null },
    edits: new SqliteMediaEditStore(db.db),
    drafts: db.store,
    transcripts: db.transcripts,
    speakers: { list: () => [] },
    rootOf: (topic) => topic,
    findMedia,
  });
  const call = (expectedVersion: number) => ({
    actor: OWNER,
    mediaId: db.mediaId,
    expectedVersion,
  });
  const propose = async () => {
    await proposals.start(OWNER, db.mediaId);
    await proposals.idle();
  };
  return { ...db, edits, proposals, call, propose, llm };
}

describe('The draft and the AI proposals (KBC-066 with KBC-067)', () => {
  it('shows a proposal as the draft, and listeners nothing, before anyone approves', async () => {
    const ctx = setup();
    await ctx.propose();
    const edit = ctx.edits.get(OWNER, ctx.mediaId);
    expect(edit.started).toBe(true);
    expect(edit.tracks.map((track) => track.source)).toEqual(['ai', 'ai']);
    expect(edit.run?.status).toBe('done');
    expect(ctx.edits.tracks(OWNER, ctx.mediaId)).toEqual({ tracks: [] });
  });

  it('refuses a save that read the draft before a proposal changed it', async () => {
    const ctx = setup();
    await ctx.propose();
    const { version } = ctx.edits.get(OWNER, ctx.mediaId);
    expect(() =>
      ctx.edits.save(ctx.call(version - 1), { tracks: [], step: 3 }),
    ).toThrow(expect.objectContaining({ code: 'EDIT_STALE' }));
  });

  it('keeps moved proposals through a new run and replaces only untouched ones (BR-6)', async () => {
    const ctx = setup();
    await ctx.propose();
    const edit = ctx.edits.get(OWNER, ctx.mediaId);
    const [first, second] = edit.tracks;
    if (!first || !second) throw new Error('two proposals expected');
    const moved = { ...first, endMs: first.endMs - 1_000 };
    ctx.edits.save(ctx.call(edit.version), {
      step: 3,
      tracks: [moved, second].map((track) => ({
        id: track.id,
        source: track.source,
        startMs: track.startMs,
        endMs: track.endMs,
        kind: track.kind,
        title: track.title,
        askerVoice: track.askerVoice,
        answererVoice: track.answererVoice,
        askerSpeakerId: track.askerSpeakerId,
        answererSpeakerId: track.answererSpeakerId,
      })),
    });
    const after = ctx.edits.get(OWNER, ctx.mediaId);
    expect(after.tracks.map((track) => track.edited)).toEqual([true, false]);
    expect(ctx.store.keptRanges(ctx.mediaId)).toEqual([
      { startMs: first.startMs, endMs: moved.endMs },
    ]);
  });

  it('stops being a proposal once approved (KBC-067 AC-11)', async () => {
    const ctx = setup();
    await ctx.propose();
    const { version } = ctx.edits.get(OWNER, ctx.mediaId);
    ctx.edits.approve(ctx.call(version));
    const after = ctx.edits.get(OWNER, ctx.mediaId);
    expect(after.tracks.every((track) => track.edited)).toBe(true);
    expect(ctx.edits.tracks(OWNER, ctx.mediaId).tracks).toHaveLength(2);
  });

  it('refuses to save or approve while a proposal writes the draft', async () => {
    const ctx = setup();
    const started = ctx.proposals.start(OWNER, ctx.mediaId);
    await started;
    const { version } = ctx.edits.get(OWNER, ctx.mediaId);
    expect(() =>
      ctx.edits.save(ctx.call(version), { tracks: [], step: 3 }),
    ).toThrow(expect.objectContaining({ code: 'MEDIA_CONFLICT' }));
    await ctx.proposals.idle();
  });

  it('says the transcript changed for a draft born from a proposal (BR-10)', async () => {
    const ctx = setup();
    await ctx.propose();
    expect(ctx.edits.get(OWNER, ctx.mediaId).transcriptChanged).toBe(false);
    ctx.db
      .prepare('UPDATE transcripts SET version = 2 WHERE media_id = ?')
      .run(ctx.mediaId);
    expect(ctx.edits.get(OWNER, ctx.mediaId).transcriptChanged).toBe(true);
  });

  it('keeps the base of a draft through a person`s save (BR-10)', async () => {
    const ctx = setup();
    await ctx.propose();
    ctx.db
      .prepare('UPDATE transcripts SET version = 2 WHERE media_id = ?')
      .run(ctx.mediaId);
    const { version, tracks } = ctx.edits.get(OWNER, ctx.mediaId);
    ctx.edits.save(ctx.call(version), {
      tracks: tracks.map((one) => ({ ...one, title: 'Mudei' })),
      step: 3,
    });
    expect(ctx.edits.get(OWNER, ctx.mediaId).transcriptChanged).toBe(true);
  });

  it('refuses a proposal over an approved edit: it would spend for nobody', async () => {
    const ctx = setup();
    await ctx.propose();
    const { version } = ctx.edits.get(OWNER, ctx.mediaId);
    ctx.edits.approve(ctx.call(version));
    await expect(ctx.proposals.start(OWNER, ctx.mediaId)).rejects.toMatchObject(
      { code: 'MEDIA_CONFLICT', details: { reason: 'approved' } },
    );
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('keeps a person`s track through a proposal', async () => {
    const ctx = setup(['Primeira']);
    const mine = manual(200_000, 210_000);
    ctx.edits.save(ctx.call(0), { tracks: [mine], step: 3 });
    await ctx.propose();
    const { tracks } = ctx.edits.get(OWNER, ctx.mediaId);
    expect(tracks.map((track) => track.source).sort()).toEqual([
      'ai',
      'manual',
    ]);
  });

  it('saves 200 tracks in at most 300 ms, all of them changed (NFR-3)', () => {
    const ctx = setup();
    const tracks = Array.from({ length: 200 }, (_, index) =>
      manual(index * 30_000, (index + 1) * 30_000),
    );
    ctx.edits.save(ctx.call(0), { tracks, step: 3 });
    const retitled = tracks.map((track) => ({ ...track, title: 'Outro' }));
    const started = performance.now();
    ctx.edits.save(ctx.call(1), { tracks: retitled, step: 3 });
    expect(performance.now() - started).toBeLessThan(300);
    expect(ctx.edits.get(OWNER, ctx.mediaId).tracks).toHaveLength(200);
  });
});
