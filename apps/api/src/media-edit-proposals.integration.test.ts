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
import { MediaEditService } from './modules/media-edit/index.js';

const OWNER: MediaActor = {
  principal: 'owner',
  isMaster: true,
  canSee: () => true,
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

function setup(titles: readonly string[] = ['Primeira', 'Segunda']) {
  const db = proposalDb(evenSegments(30));
  const llm = new StubLlm([reply(titles)]);
  const findMedia = (_actor: MediaActor, id: string) => itemOf(id, null);
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
  const edits = new MediaEditService({
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
  return { ...db, edits, proposals, call, propose };
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
});
