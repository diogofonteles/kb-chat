import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { timingProblems } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  BrokenStream,
  HANG,
  StubLlm,
  evenSegments,
  insertManualTrack,
  itemOf,
  proposalDb,
  wholeWindow,
  windowIds,
  type SegmentSpec,
  type StubReply,
} from '../test/track-proposal-fixtures.js';
import { SqliteMediaEditStore } from './adapters/sqlite/sqlite-media-edit-store.js';
import { TrackEditService } from './modules/media-edit/track-edit-service.js';
import {
  ProposalService,
  roseEstimateOf,
} from './modules/track-proposals/index.js';
import { callCeiling } from './modules/track-proposals/proposal-plan.js';
import type { MediaActor } from './modules/media/index.js';

const OWNER: MediaActor = {
  principal: 'owner',
  isMaster: true,
  canUpload: true,
  canSee: () => true,
  levelsIn: () => null,
};
const EDITOR: MediaActor = { ...OWNER, principal: 'ana', isMaster: false };
const NOW = new Date('2026-11-03T15:00:00Z');

interface Setup {
  readonly segments?: readonly SegmentSpec[];
  readonly voices?: readonly (number | null)[] | null;
  readonly replies?: StubReply[];
  readonly caps?: { runUsd: number; monthlyUsd: number };
  readonly author?: string | null;
  readonly price?: { input: number; output: number };
}

function setup(options: Setup = {}) {
  const db = proposalDb(options.segments ?? evenSegments(30));
  const llm = new StubLlm(options.replies ?? [], options.price);
  const errors: unknown[] = [];
  const service = new ProposalService({
    store: db.store,
    ledger: db.ledger,
    transcripts: db.transcripts,
    findMedia: (_actor, id) => itemOf(id, options.author ?? null),
    contextOf: () => ({
      collection: 'Hermetismo',
      knownNames: ['Mestre Gabriel'],
    }),
    segmentVoices: () => options.voices ?? null,
    llm: () => llm,
    caps: options.caps ?? { runUsd: 0.25, monthlyUsd: 10 },
    now: () => NOW,
    onRunError: (error) => errors.push(error),
  });
  return { ...db, llm, service, errors };
}

type Ctx = ReturnType<typeof setup>;

async function runToEnd(
  ctx: Ctx,
  actor: MediaActor = OWNER,
  terms: { acceptedUsd?: number } = {},
) {
  const run = await ctx.service.start(actor, ctx.mediaId, terms);
  await ctx.service.idle();
  return ctx.service.getRun(actor, ctx.mediaId, run.id);
}

/** A call's worst case, exactly: no input price and 3,000 tokens out at US$ 0.075. */
const DEAR_CALL_USD = 0.075;
const DEAR_PRICE = { input: 0, output: DEAR_CALL_USD / 3_000 };

/**
 * Three windows of US$ 0.075 at most each (US$ 0.225 in all, within the US$ 0.25 cap), the
 * provider billing every call its worst case. A value accepted above the cap (the guided
 * send's 1.25x, KBC-112 BR-6) is what lets the cap be the limit a run meets.
 */
function dear(replies: StubReply[]) {
  const ctx = setup({
    segments: evenSegments(130),
    replies,
    price: DEAR_PRICE,
  });
  ctx.llm.costPerCall = DEAR_CALL_USD;
  return ctx;
}
const ABOVE_CAP = { acceptedUsd: 0.3 };
/** One window's run (about US$ 0.0032) with room to ask it twice. */
const ROOM_FOR_A_RETRY = { acceptedUsd: 0.01 };

const monthUsed = (ctx: Ctx) =>
  ctx.ledger.usedSince(new Date('2026-11-01T03:00:00Z'));

/** 5 questions of 2 segments each (10 s per segment), asked by voice 2, answered by 1. */
const INTERVIEW: StubReply = () =>
  JSON.stringify({
    faixas: [1, 7, 13, 19, 25].map((first, index) => ({
      primeiro_id: first,
      ultimo_id: first + 5,
      tipo: 'pergunta_resposta',
      quem_pergunta: 'Voz 2',
      quem_responde: 'Voz 1',
      titulo: `Pergunta ${index + 1}`,
      continua_faixa_anterior: false,
    })),
    vozes: [
      {
        voz: 'Voz 1',
        nome: 'Mestre Gabriel',
        plateia: false,
        motivo: 'é o autor do áudio e responde 5 de 5 perguntas',
      },
      {
        voz: 'Voz 2',
        nome: null,
        plateia: true,
        motivo: 'pergunta da plateia',
      },
    ],
  });

const interviewVoices = () =>
  Array.from({ length: 30 }, (_, index) => (index % 6 === 0 ? 2 : 1));

describe('ProposalService: estimate (KBC-067 BR-3, FR-1)', () => {
  it('estimates a run within the caps and shows the month only to masters', async () => {
    const ctx = setup();
    const estimate = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(estimate).toMatchObject({
      windows: 1,
      model: 'stub/model',
      allowed: true,
      refusal: null,
      runCapUsd: 0.25,
      month: { spentUsd: 0, capUsd: 10 },
    });
    expect(estimate.estimateUsd).toBeGreaterThan(0);
    expect(estimate.estimateUsd).toBeLessThan(0.01);
    expect((await ctx.service.estimate(EDITOR, ctx.mediaId)).month).toBeNull();
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('says the monthly cap would be crossed and refuses to run (AC-3)', async () => {
    // AC-3 literally: US$ 9.99 spent this month and an estimate of US$ 0.02.
    const ctx = setup({ price: { input: 0, output: 0.02 / 3_000 } });
    ctx.ledger.reserve({
      id: 'earlier',
      kind: 'track-proposal',
      mediaId: ctx.mediaId,
      principal: 'owner',
      usd: 9.99,
      capUsd: 10,
      since: new Date(0),
      now: NOW,
    });
    const estimate = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(estimate.estimateUsd).toBeCloseTo(0.02, 6);
    expect(estimate).toMatchObject({
      allowed: false,
      refusal: 'monthly-cap',
      month: { spentUsd: 9.99, capUsd: 10 },
    });
    await expect(ctx.service.start(OWNER, ctx.mediaId)).rejects.toMatchObject({
      code: 'MEDIA_SPEND_CAP',
      details: { cap: 'monthly-cap' },
    });
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('refuses a run whose estimate passes the run cap', async () => {
    const ctx = setup({ caps: { runUsd: 0.000001, monthlyUsd: 10 } });
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      allowed: false,
      refusal: 'run-cap',
    });
    await expect(ctx.service.start(OWNER, ctx.mediaId)).rejects.toMatchObject({
      code: 'MEDIA_SPEND_CAP',
      details: { cap: 'run-cap' },
    });
    expect(monthUsed(ctx)).toBe(0);
  });

  it('needs a transcript and a connected AI', async () => {
    const empty = setup({ segments: [] });
    await expect(
      empty.service.estimate(OWNER, empty.mediaId),
    ).rejects.toMatchObject({ code: 'MEDIA_NOT_READY' });
    const ctx = setup();
    const offline = new ProposalService({
      ...ctxDeps(ctx),
      llm: () => null,
    });
    await expect(offline.estimate(OWNER, ctx.mediaId)).rejects.toMatchObject({
      code: 'LLM_NOT_CONFIGURED',
    });
  });

  it('says the provider is unavailable when the price cannot be read', async () => {
    const ctx = setup();
    ctx.llm.price = async () => {
      throw new Error('offline');
    };
    await expect(
      ctx.service.estimate(OWNER, ctx.mediaId),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

function ctxDeps(ctx: Ctx) {
  return {
    store: ctx.store,
    ledger: ctx.ledger,
    transcripts: ctx.transcripts,
    findMedia: (_actor: MediaActor, id: string) => itemOf(id, null),
    contextOf: () => ({ collection: 'Hermetismo', knownNames: [] }),
    segmentVoices: () => null,
    llm: () => ctx.llm,
    caps: { runUsd: 0.25, monthlyUsd: 10 },
    now: () => NOW,
  };
}

describe('ProposalService: a run (KBC-067 FR-2, FR-3)', () => {
  it('writes the proposed tracks with voices and names, and settles the real cost (AC-1, AC-2)', async () => {
    const ctx = setup({
      voices: interviewVoices(),
      replies: [INTERVIEW],
      author: 'Mestre Gabriel',
    });
    const run = await runToEnd(ctx);
    expect(run).toMatchObject({
      status: 'done',
      windowsDone: 1,
      tracks: 5,
      spentUsd: 0.001,
      failure: null,
    });
    const draft = ctx.service.draft(OWNER, ctx.mediaId);
    expect(draft.run?.id).toBe(run.id);
    expect(draft.tracks).toHaveLength(5);
    expect(draft.tracks[0]).toMatchObject({
      source: 'ai',
      edited: false,
      firstSegment: 1,
      lastSegment: 6,
      startMs: 0,
      endMs: 60_000,
      kind: 'qa',
      title: 'Pergunta 1',
      askerVoice: 2,
      answererVoice: 1,
    });
    expect(draft.voices).toEqual([
      {
        voice: 1,
        name: 'Mestre Gabriel',
        audience: false,
        reason: 'é o autor do áudio e responde 5 de 5 perguntas',
      },
      { voice: 2, name: null, audience: true, reason: 'pergunta da plateia' },
    ]);
    expect(monthUsed(ctx)).toBeCloseTo(0.001, 6);
  });

  it('sends only the transcript text, in pt-BR, with segment ids and the voices (AC-10)', async () => {
    const ctx = setup({ voices: interviewVoices(), replies: [INTERVIEW] });
    await runToEnd(ctx);
    const [system, user] = ctx.llm.calls[0] ?? [];
    expect(system?.content).toContain('pergunta e resposta');
    expect(user?.content).toContain('[1] 00:00 Voz 2: fala número 1');
    expect(user?.content).toContain('Candidatos de corte: 2, 7, 8');
    expect(user?.content).toContain('Acervo: Hermetismo.');
    expect(user?.content).not.toMatch(/data:audio|base64|\.mp3|\.m4a/);
  });

  it('discards an overlapping track and asks again once for an unreadable window (AC-5)', async () => {
    const overlapping = JSON.stringify({
      faixas: [
        { primeiro_id: 1, ultimo_id: 10, tipo: 'exposicao', titulo: 'A' },
        { primeiro_id: 8, ultimo_id: 20, tipo: 'exposicao', titulo: 'B' },
        { primeiro_id: 21, ultimo_id: 30, tipo: 'exposicao', titulo: 'C' },
      ],
    });
    const ctx = setup({ replies: ['{"faixas": [', overlapping] });
    // Room for the window asked again: it counts against the value accepted (KBC-112).
    const run = await runToEnd(ctx, OWNER, ROOM_FOR_A_RETRY);
    expect(run).toMatchObject({ status: 'done', tracks: 2, spentUsd: 0.002 });
    expect(ctx.llm.calls).toHaveLength(2);
    expect(ctx.llm.calls[1]?.at(-1)?.content).toContain('JSON inválido');
    const titles = ctx.service
      .draft(OWNER, ctx.mediaId)
      .tracks.map((track) => track.title);
    expect(titles).toEqual(['A', 'C']);
  });

  it('fails as "invalid-output" when the window is unreadable twice, keeping the draft (FR-5)', async () => {
    const ctx = setup({ replies: [wholeWindow({ title: 'Antiga' })] });
    await runToEnd(ctx);
    ctx.llm.replies.push('nada', 'de novo nada');
    const run = await runToEnd(ctx, OWNER, ROOM_FOR_A_RETRY);
    expect(run).toMatchObject({ status: 'failed', failure: 'invalid-output' });
    const draft = ctx.service.draft(OWNER, ctx.mediaId);
    expect(draft.tracks.map((track) => track.title)).toEqual(['Antiga']);
  });

  it('fails as "provider", refunds what it did not spend and keeps the draft (AC-6)', async () => {
    const ctx = setup({ replies: [wholeWindow({ title: 'Antiga' })] });
    await runToEnd(ctx);
    const before = monthUsed(ctx);
    ctx.llm.replies.push(new Error('HTTP 503'));
    const run = await runToEnd(ctx);
    expect(run).toMatchObject({
      status: 'failed',
      failure: 'provider',
      spentUsd: 0,
    });
    expect(monthUsed(ctx)).toBeCloseTo(before, 9);
    expect(ctx.errors).toHaveLength(1);
    const draft = ctx.service.draft(OWNER, ctx.mediaId);
    expect(draft.run?.status).toBe('done');
    expect(draft.tracks.map((track) => track.title)).toEqual(['Antiga']);
  });

  it('stops a run that would cross its own cap', async () => {
    const ctx = dear([wholeWindow(), 'nada', wholeWindow(), wholeWindow()]);
    const run = await runToEnd(ctx, OWNER, ABOVE_CAP);
    // US$ 0.225 after the second window asked again; a third call would reach US$ 0.30.
    expect(run).toMatchObject({
      status: 'failed',
      failure: 'run-cap',
      windowsDone: 2,
    });
    expect(run.spentUsd).toBeCloseTo(0.225, 9);
    expect(ctx.llm.calls).toHaveLength(3);
  });

  it('prices a call from the list when the provider reports no cost', async () => {
    const ctx = setup({ replies: [wholeWindow()] });
    ctx.llm.costPerCall = null;
    const run = await runToEnd(ctx);
    // 100 input and 50 output tokens at US$ 1e-7 and 1e-6.
    expect(run.spentUsd).toBeCloseTo(100 * 1e-7 + 50 * 1e-6, 12);
  });

  it('refuses a second run while one is running', async () => {
    const ctx = setup({ replies: [HANG] });
    await ctx.service.start(OWNER, ctx.mediaId);
    await expect(ctx.service.start(OWNER, ctx.mediaId)).rejects.toMatchObject({
      code: 'MEDIA_CONFLICT',
    });
    await ctx.service.stop();
    expect(monthUsed(ctx)).toBe(0);
  });

  it('answers 404 for a run of another recording', async () => {
    const ctx = setup({ replies: [wholeWindow()] });
    const run = await runToEnd(ctx);
    expect(() => ctx.service.getRun(OWNER, randomUUID(), run.id)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});

describe('ProposalService: windows and the draft (KBC-067 FR-3, BR-6)', () => {
  it('joins a track continued across the seam without duplicating it (AC-8)', async () => {
    // 130 segments of 10 s: windows of 10 minutes hold 60, 60 and 10.
    const ctx = setup({
      segments: evenSegments(130),
      replies: [
        wholeWindow({ title: 'Primeira' }),
        wholeWindow({ continues: true }),
        wholeWindow({ title: 'Fim' }),
      ],
    });
    const run = await runToEnd(ctx);
    expect(run).toMatchObject({ windowsTotal: 3, windowsDone: 3, tracks: 2 });
    const tracks = ctx.service.draft(OWNER, ctx.mediaId).tracks;
    expect(tracks.map((t) => [t.firstSegment, t.lastSegment, t.title])).toEqual(
      [
        [1, 120, 'Primeira'],
        [121, 130, 'Fim'],
      ],
    );
    const second = ctx.llm.calls[1]?.at(-1)?.content ?? '';
    expect(second).toContain('- ids 1–60 (exposicao): Primeira');
    const third = ctx.llm.calls[2]?.at(-1)?.content ?? '';
    expect(third).toContain('A janela anterior não deixou faixas novas.');
    expect(windowIds(second)).toEqual({ first: 61, last: 120 });
  });

  it('writes no overlap from a transcript whose segments overlap (KBC-094)', async () => {
    const segments = evenSegments(30).map((segment, index) => ({
      ...segment,
      startMs: index === 0 ? segment.startMs : segment.startMs - 42,
    }));
    const ctx = setup({ segments, replies: [INTERVIEW] });
    await runToEnd(ctx);
    const { tracks } = ctx.service.draft(OWNER, ctx.mediaId);
    expect(tracks).toHaveLength(5);
    expect(timingProblems(tracks, null)).toEqual([]);
  });

  it('a new run replaces only the AI tracks and never crosses the person’s (AC-4)', async () => {
    const ctx = setup({ replies: [wholeWindow({ title: 'Primeira IA' })] });
    await runToEnd(ctx);
    insertManualTrack(ctx.db, {
      mediaId: ctx.mediaId,
      startMs: 100_000,
      endMs: 150_000,
      title: 'Da pessoa',
    });
    ctx.llm.replies.push(() =>
      JSON.stringify({
        faixas: [
          { primeiro_id: 1, ultimo_id: 10, tipo: 'exposicao', titulo: 'Nova' },
          {
            primeiro_id: 11,
            ultimo_id: 20,
            tipo: 'exposicao',
            titulo: 'Cruza',
          },
          { primeiro_id: 21, ultimo_id: 30, tipo: 'exposicao', titulo: 'Fim' },
        ],
      }),
    );
    await runToEnd(ctx);
    const tracks = ctx.service.draft(OWNER, ctx.mediaId).tracks;
    expect(tracks.map((t) => [t.source, t.title])).toEqual([
      ['ai', 'Nova'],
      ['manual', 'Da pessoa'],
      ['ai', 'Fim'],
    ]);
  });

  it('closes runs a restart left running and refunds them', async () => {
    const ctx = setup({ replies: [wholeWindow()] });
    const run = ctx.store.startRun({
      id: randomUUID(),
      mediaId: ctx.mediaId,
      transcriptId: ctx.transcriptId,
      principal: 'owner',
      model: 'stub/model',
      spendId: 'spend-1',
      windowsTotal: 1,
      estimateUsd: 0.01,
      limitUsd: 0.01,
      now: NOW,
      carriedUsd: 0,
      resumes: null,
    });
    ctx.ledger.reserve({
      id: 'spend-1',
      kind: 'track-proposal',
      mediaId: ctx.mediaId,
      principal: 'owner',
      usd: 0.01,
      capUsd: 10,
      since: new Date(0),
      now: NOW,
    });
    expect(ctx.service.recover()).toBe(1);
    expect(ctx.store.getRun(run?.id ?? '')).toMatchObject({
      status: 'failed',
      failure: 'interrupted',
    });
    expect(monthUsed(ctx)).toBe(0);
  });

  it('stops the runs in flight when the API closes', async () => {
    const ctx = setup({ replies: [HANG] });
    const run = await ctx.service.start(OWNER, ctx.mediaId);
    await ctx.service.stop();
    expect(ctx.service.getRun(OWNER, ctx.mediaId, run.id)).toMatchObject({
      status: 'failed',
      failure: 'interrupted',
    });
    expect(monthUsed(ctx)).toBe(0);
  });
});

describe('ProposalService: round-1 review fixes (KBC-067)', () => {
  const spendRows = (ctx: Ctx) =>
    ctx.db
      .prepare('SELECT status, spent_usd FROM media_spend ORDER BY created_at')
      .all()
      .map((row) => ({ ...row }));

  it('never names a voice once marked as the audience, even if a later window names it (BR-5)', async () => {
    const voices = (name: string | null, audience: boolean) => () =>
      JSON.stringify({
        faixas: [{ primeiro_id: 1, ultimo_id: 1, tipo: 'exposicao' }],
        vozes: [{ voz: 'Voz 2', nome: name, plateia: audience, motivo: 'x' }],
      });
    const ctx = setup({
      segments: evenSegments(130),
      voices: Array.from({ length: 130 }, () => 2),
      replies: [
        voices(null, true),
        voices('Mestre Gabriel', false),
        voices('Mestre Gabriel', false),
      ],
    });
    await runToEnd(ctx);
    expect(ctx.service.draft(OWNER, ctx.mediaId).voices).toEqual([
      { voice: 2, name: null, audience: true, reason: 'x' },
    ]);
  });

  it('settles the reservation with the real spend when the recording is deleted mid-run', async () => {
    const ctx = setup({ segments: evenSegments(130) });
    ctx.llm.replies.push(wholeWindow(), (user) => {
      ctx.db.prepare('DELETE FROM media WHERE id = ?').run(ctx.mediaId);
      return wholeWindow()(user);
    });
    await ctx.service.start(OWNER, ctx.mediaId);
    await ctx.service.idle();
    expect(spendRows(ctx)).toEqual([{ status: 'refunded', spent_usd: 0.002 }]);
    expect(monthUsed(ctx)).toBeCloseTo(0.002, 9);
  });

  it('refunds at start a reservation a crash left open, keeping its spend', async () => {
    const ctx = setup();
    ctx.ledger.reserve({
      id: 'orphan',
      kind: 'track-proposal',
      mediaId: ctx.mediaId,
      principal: 'owner',
      usd: 0.2,
      capUsd: 10,
      since: new Date(0),
      now: NOW,
    });
    ctx.db
      .prepare("UPDATE media_spend SET spent_usd = 0.003 WHERE id = 'orphan'")
      .run();
    expect(monthUsed(ctx)).toBeCloseTo(0.2, 9);
    expect(ctx.service.recover()).toBe(1);
    expect(spendRows(ctx)).toEqual([{ status: 'refunded', spent_usd: 0.003 }]);
    expect(monthUsed(ctx)).toBeCloseTo(0.003, 9);
  });

  it('counts a call that broke mid-answer at its list price', async () => {
    const ctx = setup({ replies: [new BrokenStream('{"faixas": [')] });
    const run = await runToEnd(ctx);
    expect(run.failure).toBe('provider');
    expect(run.spentUsd).toBeGreaterThan(0);
    expect(monthUsed(ctx)).toBeCloseTo(run.spentUsd, 12);
  });

  it('does not count a call that failed before writing anything', async () => {
    const ctx = setup({ replies: [new Error('HTTP 503')] });
    expect((await runToEnd(ctx)).spentUsd).toBe(0);
  });
});

describe('ProposalService: a run that stopped part way (KBC-072 AC-11, BR-6)', () => {
  const THREE_WINDOWS = evenSegments(130);
  const spendRows = (ctx: Ctx) =>
    ctx.db
      .prepare('SELECT status, spent_usd FROM media_spend ORDER BY rowid')
      .all()
      .map((row) => ({ ...row }));
  const titles = (ctx: Ctx) =>
    ctx.service.draft(OWNER, ctx.mediaId).tracks.map(({ title }) => title);
  const failedInTheMiddle = () =>
    setup({
      segments: THREE_WINDOWS,
      replies: [wholeWindow(), new Error('HTTP 503')],
    });
  /** A run the API left running, one window written. */
  function leftRunning(ctx: Ctx, windowsDone: number) {
    const runId = randomUUID();
    ctx.ledger.reserve({
      id: 'spend-1',
      kind: 'track-proposal',
      mediaId: ctx.mediaId,
      principal: 'owner',
      usd: 0.01,
      capUsd: 10,
      since: new Date(0),
      now: NOW,
    });
    ctx.store.startRun({
      id: runId,
      mediaId: ctx.mediaId,
      transcriptId: ctx.transcriptId,
      principal: 'owner',
      model: 'stub/model',
      spendId: 'spend-1',
      windowsTotal: 3,
      estimateUsd: 0.01,
      limitUsd: 0.01,
      now: NOW,
      carriedUsd: 0,
      resumes: null,
    });
    for (let window = 0; window < windowsDone; window++)
      ctx.store.saveWindow({
        runId,
        extendLast: null,
        tracks: [
          {
            firstSegment: window * 60 + 1,
            lastSegment: window * 60 + 60,
            startMs: window * 600_000,
            endMs: (window + 1) * 600_000,
            kind: 'talk',
            title: `Salva ${window + 1}`,
            askerVoice: null,
            answererVoice: null,
          },
        ],
        voices: [],
        spentUsd: 0.001 * (window + 1),
      });
    return runId;
  }

  it('keeps the windows that finished when a later one fails', async () => {
    const ctx = failedInTheMiddle();
    const failed = await runToEnd(ctx);
    expect(failed).toMatchObject({
      status: 'failed',
      failure: 'provider',
      windowsDone: 1,
      tracks: 1,
      spentUsd: 0.001,
    });
    expect(ctx.service.draft(OWNER, ctx.mediaId)).toMatchObject({
      run: { id: failed.id },
      lastFailure: 'provider',
      tracks: [{ title: 'Janela 1', source: 'ai' }],
    });
    expect(spendRows(ctx)).toEqual([{ status: 'refunded', spent_usd: 0.001 }]);
  });

  it('asks and charges only the missing windows on the next start', async () => {
    const ctx = failedInTheMiddle();
    await runToEnd(ctx);
    const whole = ctx.llm.calls.length;
    ctx.llm.replies.push(wholeWindow(), wholeWindow());
    const done = await runToEnd(ctx);
    expect(ctx.llm.calls).toHaveLength(whole + 2);
    const asked = ctx.llm.calls
      .slice(whole)
      .map((call) => windowIds(String(call.at(-1)?.content)).first);
    expect(asked[0]).toBeGreaterThan(1);
    expect(done).toMatchObject({
      status: 'done',
      windowsDone: 3,
      windowsTotal: 3,
      tracks: 3,
    });
    expect(done.spentUsd).toBeCloseTo(0.003, 9);
    expect(titles(ctx)).toHaveLength(3);
    expect(titles(ctx)[0]).toBe('Janela 1');
    expect(ctx.service.draft(OWNER, ctx.mediaId).lastFailure).toBeNull();
    expect(monthUsed(ctx)).toBeCloseTo(0.003, 9);
    expect(spendRows(ctx)).toEqual([
      { status: 'refunded', spent_usd: 0.001 },
      { status: 'settled', spent_usd: 0.002 },
    ]);
  });

  it('estimates only what is missing', async () => {
    const ctx = failedInTheMiddle();
    const first = await ctx.service.estimate(OWNER, ctx.mediaId);
    await runToEnd(ctx);
    const rest = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(rest.estimateUsd).toBeLessThan(first.estimateUsd);
    expect(rest.estimateUsd).toBeGreaterThan(0);
    expect(rest.windows).toBe(2);
    ctx.llm.replies.push(new Error('HTTP 503'));
    const again = await runToEnd(ctx);
    expect(again.estimateUsd).toBe(rest.estimateUsd);
  });

  it('gives a resumed window what the windows before it left', async () => {
    const ctx = failedInTheMiddle();
    await runToEnd(ctx);
    ctx.llm.replies.push(wholeWindow({ continues: true }), wholeWindow());
    const done = await runToEnd(ctx);
    expect(String(ctx.llm.calls.at(-2)?.at(-1)?.content)).toContain('Janela 1');
    expect(done.tracks).toBe(2);
    const [first] = ctx.service.draft(OWNER, ctx.mediaId).tracks;
    expect(first?.lastSegment).toBeGreaterThan(60);
  });

  it('keeps going over more than one failure, each paying its part', async () => {
    const ctx = failedInTheMiddle();
    await runToEnd(ctx);
    ctx.llm.replies.push(wholeWindow(), new Error('HTTP 503'));
    const second = await runToEnd(ctx);
    expect(second).toMatchObject({ windowsDone: 2, tracks: 2 });
    expect(second.spentUsd).toBeCloseTo(0.002, 9);
    ctx.llm.replies.push(wholeWindow());
    const done = await runToEnd(ctx);
    expect(done).toMatchObject({ status: 'done', windowsDone: 3, tracks: 3 });
    expect(done.spentUsd).toBeCloseTo(0.003, 9);
    expect(ctx.llm.calls.length).toBe(5);
  });

  it('holds the run cap over the whole analysis, not each attempt', async () => {
    const ctx = dear([wholeWindow(), new Error('HTTP 503')]);
    await runToEnd(ctx, OWNER, ABOVE_CAP);
    ctx.llm.replies.push('ilegível', wholeWindow(), wholeWindow());
    const second = await runToEnd(ctx, OWNER, ABOVE_CAP);
    // US$ 0.075 carried leaves US$ 0.175: the window asked again fits, the last does not.
    expect(second).toMatchObject({
      status: 'failed',
      failure: 'run-cap',
      windowsDone: 2,
    });
    expect(second.spentUsd).toBeCloseTo(0.225, 9);
    expect(monthUsed(ctx)).toBeCloseTo(0.225, 9);
  });

  it('holds the run cap over attempts that finished no window', async () => {
    const ctx = dear(['ilegível', 'ilegível']);
    const first = await runToEnd(ctx, OWNER, ABOVE_CAP);
    expect(first).toMatchObject({ failure: 'invalid-output', windowsDone: 0 });
    expect(first.spentUsd).toBeCloseTo(0.15, 9);
    await expect(
      ctx.service.start(OWNER, ctx.mediaId, ABOVE_CAP),
    ).rejects.toMatchObject({
      code: 'MEDIA_SPEND_CAP',
      details: { cap: 'run-cap' },
    });
    expect(ctx.llm.calls).toHaveLength(2);
    expect(monthUsed(ctx)).toBeCloseTo(0.15, 9);
  });

  it('refuses, in the estimate and at the start, an analysis past its cap (BUG-9)', async () => {
    const ctx = dear([wholeWindow(), 'ilegível', 'ilegível']);
    await runToEnd(ctx, OWNER, ABOVE_CAP);
    const calls = ctx.llm.calls.length;
    const estimate = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(estimate).toMatchObject({ allowed: false, refusal: 'run-cap' });
    await expect(ctx.service.start(OWNER, ctx.mediaId)).rejects.toMatchObject({
      code: 'MEDIA_SPEND_CAP',
      details: { cap: 'run-cap' },
    });
    expect(ctx.llm.calls).toHaveLength(calls);
  });

  it('carries the spend of a failure whose windows no longer match the plan', async () => {
    const ctx = failedInTheMiddle();
    await runToEnd(ctx);
    ctx.db
      .prepare(
        'UPDATE media_proposal_runs SET windows_total = 9, spent_usd = 0.2',
      )
      .run();
    ctx.llm.replies.push(new Error('HTTP 503'));
    const second = await runToEnd(ctx);
    expect(second).toMatchObject({ windowsDone: 0, tracks: 0 });
    expect(second.spentUsd).toBeCloseTo(0.2, 9);
  });

  it('two starts at once run one analysis and reserve once (BUG-10)', async () => {
    const ctx = setup({ segments: THREE_WINDOWS, replies: [HANG] });
    const price = ctx.llm.price.bind(ctx.llm);
    ctx.llm.price = async () => {
      await sleep(5);
      return price();
    };
    const results = await Promise.allSettled([
      ctx.service.start(OWNER, ctx.mediaId),
      ctx.service.start(OWNER, ctx.mediaId),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(spendRows(ctx)).toHaveLength(1);
    await ctx.service.stop();
  });

  it('a start that saw an older run pays nothing once a newer one ended (BUG-10)', async () => {
    const ctx = setup({ replies: [wholeWindow()] });
    const seen = ctx.service.newestRunId(ctx.mediaId);
    await runToEnd(ctx);
    await expect(
      ctx.service.start(OWNER, ctx.mediaId, { seenRunId: seen }),
    ).rejects.toMatchObject({ code: 'MEDIA_CONFLICT' });
    expect(ctx.llm.calls).toHaveLength(1);
    expect(spendRows(ctx)).toHaveLength(1);
  });

  it('starts over when the transcript changed since the failure', async () => {
    const ctx = failedInTheMiddle();
    await runToEnd(ctx);
    expect(ctx.store.failedAttempt(ctx.mediaId, randomUUID())).toBeNull();
    expect(
      ctx.store.failedAttempt(ctx.mediaId, ctx.transcriptId),
    ).toMatchObject({ windowsDone: 1 });
  });

  it('leaves a finished proposal in place when a new run fails part way (KBC-067 AC-6)', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        wholeWindow({ title: 'Antiga' }),
        wholeWindow({ title: 'Antiga' }),
        wholeWindow({ title: 'Antiga' }),
        wholeWindow({ title: 'Nova' }),
        new Error('HTTP 503'),
      ],
    });
    const done = await runToEnd(ctx);
    await runToEnd(ctx);
    expect(ctx.service.draft(OWNER, ctx.mediaId)).toMatchObject({
      run: { id: done.id },
      lastFailure: 'provider',
    });
    expect(titles(ctx)).toEqual(['Antiga', 'Antiga', 'Antiga']);
    ctx.llm.replies.push(wholeWindow({ title: 'Nova' }));
    ctx.llm.replies.push(wholeWindow({ title: 'Nova' }));
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Nova', 'Nova', 'Nova']);
    expect(ctx.llm.calls).toHaveLength(7);
  });

  it('approves what the person sees: a failed run out of sight goes (KBC-094)', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        wholeWindow({ title: 'Antiga' }),
        wholeWindow({ title: 'Antiga' }),
        wholeWindow({ title: 'Antiga' }),
        wholeWindow({ title: 'Oculta' }),
        new Error('HTTP 503'),
      ],
    });
    await runToEnd(ctx);
    await runToEnd(ctx);
    const edits = new SqliteMediaEditStore(ctx.db);
    const service = new TrackEditService({
      edits,
      drafts: ctx.store,
      transcripts: ctx.transcripts,
      speakers: { list: () => [] },
      plans: { get: () => null },
      rootOf: (topic) => topic,
      findMedia: (_actor, id) => ({ ...itemOf(id, null), durationMs: null }),
      now: () => NOW,
    });
    service.approve({
      actor: OWNER,
      mediaId: ctx.mediaId,
      expectedVersion: edits.edit(ctx.mediaId)?.version ?? 0,
    });
    expect(edits.approved(ctx.mediaId).map(({ title }) => title)).toEqual([
      'Antiga',
      'Antiga',
      'Antiga',
    ]);
    const { tracks } = ctx.store.draft(ctx.mediaId);
    expect(tracks.map(({ title }) => title)).toEqual([
      'Antiga',
      'Antiga',
      'Antiga',
    ]);
    expect(timingProblems(tracks, null)).toEqual([]);
  });

  it('a restart keeps the windows done and runs nothing until someone asks', async () => {
    const ctx = setup({ segments: THREE_WINDOWS });
    leftRunning(ctx, 1);
    expect(ctx.service.recover()).toBe(1);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(titles(ctx)).toEqual(['Salva 1']);
    expect(ctx.service.draft(OWNER, ctx.mediaId).lastFailure).toBe(
      'interrupted',
    );
    expect(monthUsed(ctx)).toBeCloseTo(0.001, 9);
    ctx.llm.replies.push(wholeWindow(), wholeWindow());
    const done = await runToEnd(ctx);
    expect(ctx.llm.calls).toHaveLength(2);
    expect(done).toMatchObject({ status: 'done', tracks: 3 });
    expect(monthUsed(ctx)).toBeCloseTo(0.003, 9);
  });

  it('a restart after the last window ends the run as done', async () => {
    const ctx = setup({ segments: THREE_WINDOWS });
    const runId = leftRunning(ctx, 3);
    ctx.service.recover();
    expect(ctx.store.getRun(runId)).toMatchObject({
      status: 'done',
      failure: null,
    });
    expect(ctx.service.draft(OWNER, ctx.mediaId).lastFailure).toBeNull();
    expect(spendRows(ctx)).toEqual([{ status: 'settled', spent_usd: 0.003 }]);
  });

  it('an API closing mid-run keeps the windows done', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [wholeWindow(), HANG],
    });
    await ctx.service.start(OWNER, ctx.mediaId);
    await vi.waitFor(() => expect(ctx.llm.calls).toHaveLength(2));
    await ctx.service.stop();
    expect(titles(ctx)).toEqual(['Janela 1']);
  });
});

describe('ProposalService: a retry loses no track (KBC-097)', () => {
  const THREE_WINDOWS = evenSegments(130);
  /** A window read fine, whose only track points outside it: nothing to write. */
  const NOTHING_USABLE: StubReply = () =>
    JSON.stringify({
      faixas: [{ primeiro_id: 9_999, ultimo_id: 9_999, tipo: 'exposicao' }],
    });
  const titles = (ctx: Ctx) =>
    ctx.service.draft(OWNER, ctx.mediaId).tracks.map(({ title }) => title);
  const spendCount = (ctx: Ctx) =>
    ctx.db.prepare('SELECT count(*) AS n FROM media_spend').get()?.['n'];

  interface Change {
    readonly index: number;
    readonly title?: string;
    readonly endMs?: number;
    /** The person deletes that track instead. */
    readonly drop?: boolean;
  }

  function editing(ctx: Ctx) {
    const edits = new SqliteMediaEditStore(ctx.db);
    const service = new TrackEditService({
      edits,
      drafts: ctx.store,
      transcripts: ctx.transcripts,
      speakers: { list: () => [] },
      plans: { get: () => null },
      rootOf: (topic) => topic,
      findMedia: (_actor, id) => ({ ...itemOf(id, null), durationMs: null }),
      now: () => NOW,
    });
    const call = () => ({
      actor: OWNER,
      mediaId: ctx.mediaId,
      expectedVersion: edits.edit(ctx.mediaId)?.version ?? 0,
    });
    /** A save of the visible draft, as the editor sends it, with one track changed. */
    const save = (change?: Change) =>
      service.save(call(), {
        step: 3,
        tracks: ctx.store
          .draft(ctx.mediaId)
          .tracks.filter(
            (_, index) => !(change?.drop && index === change.index),
          )
          .map((track, index) => ({
            id: track.id,
            source: track.source,
            startMs: track.startMs,
            endMs:
              index === change?.index
                ? (change.endMs ?? track.endMs)
                : track.endMs,
            kind: track.kind,
            title:
              index === change?.index
                ? (change.title ?? track.title)
                : track.title,
            askerVoice: track.askerVoice,
            answererVoice: track.answererVoice,
            askerSpeakerId: track.askerSpeakerId,
            answererSpeakerId: track.answererSpeakerId,
          })),
      });
    const reopen = () => service.reopen(call());
    return { save, approve: () => service.approve(call()), reopen };
  }

  /** A finished proposal, then a run that failed after its first window. */
  async function failedOverAProposal() {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        wholeWindow({ title: 'Antiga 1' }),
        wholeWindow({ title: 'Antiga 2' }),
        wholeWindow({ title: 'Antiga 3' }),
        wholeWindow({ title: 'Oculta' }),
        new Error('HTTP 503'),
      ],
    });
    await runToEnd(ctx);
    await runToEnd(ctx);
    return ctx;
  }

  /** The plan stops fitting the failed run, as with a transcript cut in other windows. */
  const unfit = (ctx: Ctx) =>
    ctx.db
      .prepare(
        `UPDATE media_proposal_runs SET windows_total = 99 WHERE status = 'failed'`,
      )
      .run();

  it('a save then a retry keeps the paid windows and pays only what is missing (KBC-094 N-1)', async () => {
    const ctx = await failedOverAProposal();
    editing(ctx).save({ index: 2, title: 'Dela' });
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      windows: 2,
      restarts: false,
    });
    const before = ctx.llm.calls.length;
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 2' }),
      wholeWindow({ title: 'Nova 3' }),
    );
    await runToEnd(ctx);
    expect(ctx.llm.calls).toHaveLength(before + 2);
    const { tracks } = ctx.store.draft(ctx.mediaId);
    expect(tracks.map(({ title }) => title)).toEqual([
      'Oculta',
      'Nova 2',
      'Dela',
    ]);
    expect(timingProblems(tracks, null)).toEqual([]);
  });

  it('a save over all that is on screen keeps the windows a failed run paid for (QA BUG-1)', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        NOTHING_USABLE,
        NOTHING_USABLE,
        () =>
          JSON.stringify({
            faixas: [
              {
                primeiro_id: 121,
                ultimo_id: 130,
                tipo: 'exposicao',
                titulo: 'Só',
              },
            ],
          }),
        wholeWindow({ title: 'Paga 1' }),
        wholeWindow({ title: 'Paga 2' }),
        new Error('HTTP 503'),
      ],
    });
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Só']);
    editing(ctx).save({ index: 0, title: 'Editada' });
    expect((await runToEnd(ctx)).windowsDone).toBe(2);
    expect(titles(ctx)).toEqual(['Editada']);
    editing(ctx).save({ index: 0, title: 'Editada de novo' });
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      windows: 1,
      restarts: false,
    });
    const before = ctx.llm.calls.length;
    ctx.llm.replies.push(wholeWindow({ title: 'Nova' }));
    await runToEnd(ctx);
    expect(
      ctx.llm.calls
        .slice(before)
        .map((call) => windowIds(String(call.at(-1)?.content)).first),
    ).toEqual([121]);
    const { tracks } = ctx.store.draft(ctx.mediaId);
    expect(tracks.map(({ title }) => title)).toEqual([
      'Paga 1',
      'Paga 2',
      'Editada de novo',
    ]);
    expect(timingProblems(tracks, null)).toEqual([]);
  });

  it('a carried track that crosses what the person kept since gives way, keeping its free stretch', async () => {
    const ctx = await failedOverAProposal();
    editing(ctx).save({ index: 0, title: 'Curta', endMs: 300_000 });
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 2' }),
      wholeWindow({ title: 'Nova 3' }),
    );
    await runToEnd(ctx);
    const { tracks } = ctx.store.draft(ctx.mediaId);
    expect(tracks.map(({ title }) => title)).toEqual([
      'Curta',
      'Oculta',
      'Nova 2',
      'Nova 3',
    ]);
    // Cut, it no longer spans the segments it was proposed over.
    expect(tracks[1]).toMatchObject({
      startMs: 300_000,
      endMs: 600_000,
      firstSegment: null,
      lastSegment: null,
      edited: false,
    });
    expect(timingProblems(tracks, null)).toEqual([]);
  });

  it('keeps the paid windows without a save: it pays only what is missing', async () => {
    const ctx = await failedOverAProposal();
    const before = ctx.llm.calls.length;
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 2' }),
      wholeWindow({ title: 'Nova 3' }),
    );
    await runToEnd(ctx);
    expect(ctx.llm.calls).toHaveLength(before + 2);
    expect(titles(ctx)).toEqual(['Oculta', 'Nova 2', 'Nova 3']);
  });

  it('a window that wrote no track pays nothing twice and takes nothing away', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        wholeWindow({ title: 'Antiga 1' }),
        wholeWindow({ title: 'Antiga 2' }),
        wholeWindow({ title: 'Antiga 3' }),
        NOTHING_USABLE,
        new Error('HTTP 503'),
      ],
    });
    await runToEnd(ctx);
    await runToEnd(ctx);
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      windows: 2,
      restarts: false,
    });
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 2' }),
      wholeWindow({ title: 'Nova 3' }),
    );
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Nova 2', 'Nova 3']);
  });

  it('a track mostly out of a new one’s reach keeps its stretch, in the seam too', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        wholeWindow({ title: 'Longa' }),
        wholeWindow({ continues: true }),
        wholeWindow({ title: 'Antiga 3' }),
        NOTHING_USABLE,
        () =>
          JSON.stringify({
            faixas: [
              {
                primeiro_id: 61,
                ultimo_id: 70,
                tipo: 'exposicao',
                titulo: 'Beira',
              },
            ],
          }),
        NOTHING_USABLE,
      ],
    });
    await runToEnd(ctx);
    const long = ctx.store.draft(ctx.mediaId).tracks[0];
    await runToEnd(ctx);
    const { tracks } = ctx.store.draft(ctx.mediaId);
    expect(tracks.map(({ title }) => title)).toEqual([
      'Longa',
      'Beira',
      'Antiga 3',
    ]);
    expect(tracks[0]?.startMs).toBe(long?.startMs);
    expect(tracks[0]?.endMs).toBe(tracks[1]?.startMs);
    // The segments it was proposed over are no longer its own: a next window is not told so.
    expect(tracks[0]).toMatchObject({ firstSegment: null, lastSegment: null });
    expect(timingProblems(tracks, null)).toEqual([]);
  });

  it('after an approval that dropped a failed run, a retry asks its windows again', async () => {
    const ctx = await failedOverAProposal();
    const editor = editing(ctx);
    editor.approve();
    await editor.reopen();
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      windows: 3,
    });
    ctx.llm.replies.push(wholeWindow(), wholeWindow(), wholeWindow());
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Antiga 3']);
  });

  it('a person’s deletion of a failed run they saw stands, and pays nothing twice', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [wholeWindow({ title: 'Vista' }), new Error('HTTP 503')],
    });
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Vista']);
    editing(ctx).save({ index: 0, drop: true });
    expect(titles(ctx)).toEqual([]);
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      windows: 2,
      restarts: false,
    });
    const before = ctx.llm.calls.length;
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 2' }),
      wholeWindow({ title: 'Nova 3' }),
    );
    await runToEnd(ctx);
    expect(
      ctx.llm.calls
        .slice(before)
        .map((call) => windowIds(String(call.at(-1)?.content)).first),
    ).toEqual([61, 121]);
    expect(titles(ctx)).toEqual(['Nova 2', 'Nova 3']);
  });

  it('what a new run does not replace stays: a window with no track, or a run with none', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        wholeWindow({ title: 'Antiga 1' }),
        wholeWindow({ title: 'Antiga 2' }),
        wholeWindow({ title: 'Antiga 3' }),
        NOTHING_USABLE,
        wholeWindow({ title: 'Nova 2' }),
        NOTHING_USABLE,
      ],
    });
    await runToEnd(ctx);
    const second = await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Nova 2', 'Antiga 3']);
    expect(ctx.store.draft(ctx.mediaId).run?.id).toBe(second.id);
    ctx.llm.replies.push(NOTHING_USABLE, NOTHING_USABLE, NOTHING_USABLE);
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Nova 2', 'Antiga 3']);
  });

  it('the names of the tracks that stay stay on offer', async () => {
    const named: StubReply = (user) =>
      JSON.stringify({
        ...(JSON.parse(wholeWindow({ title: 'Antiga' })(user)) as object),
        vozes: [
          {
            voz: 'Voz 1',
            nome: 'Mestre Gabriel',
            plateia: false,
            motivo: 'o autor',
          },
        ],
      });
    const ctx = setup({
      segments: THREE_WINDOWS,
      voices: THREE_WINDOWS.map(() => 1),
      replies: [
        named,
        named,
        named,
        NOTHING_USABLE,
        NOTHING_USABLE,
        NOTHING_USABLE,
      ],
    });
    await runToEnd(ctx);
    await runToEnd(ctx);
    expect(ctx.store.draft(ctx.mediaId).voices).toHaveLength(1);
  });

  it('a failed run out of sight never surfaces when a later one ends', async () => {
    const ctx = await failedOverAProposal();
    unfit(ctx);
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 1' }),
      wholeWindow({ title: 'Nova 2' }),
      NOTHING_USABLE,
    );
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Nova 1', 'Nova 2', 'Antiga 3']);
    expect(ctx.store.draft(ctx.mediaId).tracks).toHaveLength(3);
    expect(
      ctx.db
        .prepare(
          'SELECT count(*) AS n FROM media_draft_tracks WHERE media_id = ?',
        )
        .get(ctx.mediaId)?.['n'],
    ).toBe(3);
  });

  it('a failed run that takes the screen keeps the tracks before it as proposals a resume may replace (QA R2-1)', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        wholeWindow({ title: 'Vista 1' }),
        wholeWindow({ title: 'Vista 2' }),
        new Error('HTTP 503'),
      ],
    });
    await runToEnd(ctx);
    unfit(ctx);
    ctx.llm.replies.push(NOTHING_USABLE, new Error('HTTP 503'));
    await runToEnd(ctx);
    const proposed = (ctx: Ctx) =>
      ctx.store
        .draft(ctx.mediaId)
        .tracks.map(({ title, edited }) => ({ title, edited }));
    // Nobody changed them: they stay proposals.
    expect(proposed(ctx)).toEqual([
      { title: 'Vista 1', edited: false },
      { title: 'Vista 2', edited: false },
    ]);
    ctx.db.prepare('UPDATE media_proposal_runs SET windows_total = 3').run();
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 2' }),
      wholeWindow({ title: 'Nova 3' }),
    );
    await runToEnd(ctx);
    // The window paid again writes its track in place of the old proposal.
    expect(proposed(ctx)).toEqual([
      { title: 'Vista 1', edited: false },
      { title: 'Nova 2', edited: false },
      { title: 'Nova 3', edited: false },
    ]);
    expect(timingProblems(ctx.store.draft(ctx.mediaId).tracks, null)).toEqual(
      [],
    );
  });

  /** A reply of one track over segments `first` to `last`. */
  const span =
    (first: number, last: number, extra: object = {}) =>
    () =>
      JSON.stringify({
        faixas: [
          {
            primeiro_id: first,
            ultimo_id: last,
            tipo: 'exposicao',
            ...extra,
          },
        ],
      });

  /**
   * Two failed runs over four windows: the newest wrote W1 (window 1) and carries T3
   * (1 590 000 to 1 800 000 ms, window 3) from the one before; a retry resumes at window 2.
   */
  async function carriedAhead() {
    const ctx = setup({
      segments: evenSegments(190),
      replies: [
        wholeWindow({ title: 'T1' }),
        NOTHING_USABLE,
        span(160, 180, { titulo: 'T3' }),
        new Error('HTTP 503'),
      ],
    });
    await runToEnd(ctx);
    unfit(ctx);
    ctx.llm.replies.push(wholeWindow({ title: 'W1' }), new Error('HTTP 503'));
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['W1', 'T3']);
    return ctx;
  }

  const spans = (ctx: Ctx) =>
    ctx.store
      .draft(ctx.mediaId)
      .tracks.map(({ title, startMs, endMs, firstSegment }) => ({
        title,
        startMs,
        endMs,
        firstSegment,
      }));

  it('a continuation stretches the track it continues, never a kept one further on (review #1)', async () => {
    const ctx = await carriedAhead();
    const before = ctx.llm.calls.length;
    ctx.llm.replies.push(
      span(61, 120, { titulo: 'N2' }),
      span(121, 150, { continua_faixa_anterior: true }),
      span(181, 190, { titulo: 'N4' }),
    );
    const run = await runToEnd(ctx);
    expect(run.failure).toBeNull();
    expect(ctx.llm.calls).toHaveLength(before + 3);
    const { tracks } = ctx.store.draft(ctx.mediaId);
    expect(
      tracks.map(({ title, startMs, endMs }) => ({ title, startMs, endMs })),
    ).toEqual([
      { title: 'W1', startMs: 0, endMs: 600_000 },
      { title: 'N2', startMs: 600_000, endMs: 1_500_000 },
      { title: 'T3', startMs: 1_590_000, endMs: 1_800_000 },
      { title: 'N4', startMs: 1_800_000, endMs: 1_900_000 },
    ]);
    expect(timingProblems(tracks, null)).toEqual([]);
  });

  it('a new track that crosses part of a carried proposal leaves it the rest (review round 2)', async () => {
    const ctx = await carriedAhead();
    ctx.llm.replies.push(
      span(61, 120, { titulo: 'N2' }),
      span(121, 165, { titulo: 'N3' }),
      span(181, 190, { titulo: 'N4' }),
    );
    expect((await runToEnd(ctx)).failure).toBeNull();
    expect(spans(ctx)).toEqual([
      { title: 'W1', startMs: 0, endMs: 600_000, firstSegment: 1 },
      { title: 'N2', startMs: 600_000, endMs: 1_200_000, firstSegment: 61 },
      { title: 'N3', startMs: 1_200_000, endMs: 1_650_000, firstSegment: 121 },
      { title: 'T3', startMs: 1_650_000, endMs: 1_800_000, firstSegment: null },
      { title: 'N4', startMs: 1_800_000, endMs: 1_900_000, firstSegment: 181 },
    ]);
    expect(timingProblems(ctx.store.draft(ctx.mediaId).tracks, null)).toEqual(
      [],
    );
  });

  it('a continuation that runs into a carried proposal leaves it the rest (review round 2)', async () => {
    const ctx = await carriedAhead();
    ctx.llm.replies.push(
      span(61, 120, { titulo: 'N2' }),
      span(121, 162, { continua_faixa_anterior: true }),
      span(181, 190, { titulo: 'N4' }),
    );
    expect((await runToEnd(ctx)).failure).toBeNull();
    expect(spans(ctx)).toEqual([
      { title: 'W1', startMs: 0, endMs: 600_000, firstSegment: 1 },
      { title: 'N2', startMs: 600_000, endMs: 1_620_000, firstSegment: 61 },
      { title: 'T3', startMs: 1_620_000, endMs: 1_800_000, firstSegment: null },
      { title: 'N4', startMs: 1_800_000, endMs: 1_900_000, firstSegment: 181 },
    ]);
    expect(timingProblems(ctx.store.draft(ctx.mediaId).tracks, null)).toEqual(
      [],
    );
  });

  it('a continuation of a track gone meanwhile is not taken as written (review round 2)', async () => {
    const ctx = setup({ segments: THREE_WINDOWS });
    const gone: StubReply = () => {
      // The track window 1 wrote leaves before window 2 continues it.
      ctx.db.prepare("DELETE FROM media_draft_tracks WHERE title = 'A'").run();
      return span(61, 120, { continua_faixa_anterior: true })();
    };
    ctx.llm.replies.push(
      wholeWindow({ title: 'A' }),
      gone,
      span(121, 130, { continua_faixa_anterior: true, titulo: 'C' }),
    );
    expect((await runToEnd(ctx)).failure).toBeNull();
    // Window 3 cannot continue what is not there: its track stands on its own.
    expect(titles(ctx)).toEqual(['C']);
  });

  it('says it starts over, at the value it says, when the plan no longer fits', async () => {
    const ctx = await failedOverAProposal();
    const resume = await ctx.service.estimate(OWNER, ctx.mediaId);
    unfit(ctx);
    const restart = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(restart).toMatchObject({ windows: 3, restarts: true });
    expect(restart.estimateUsd).toBeGreaterThan(resume.estimateUsd);
  });

  it('refuses a cost above the one agreed, reserving and asking nothing', async () => {
    const ctx = await failedOverAProposal();
    const agreed = await ctx.service.estimate(OWNER, ctx.mediaId);
    unfit(ctx);
    const calls = ctx.llm.calls.length;
    const reservations = spendCount(ctx);
    const refused = await ctx.service
      .start(OWNER, ctx.mediaId, { acceptedUsd: agreed.estimateUsd })
      .catch((err: unknown) => err);
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(roseEstimateOf(refused)).toBe(estimateUsd);
    expect(ctx.llm.calls).toHaveLength(calls);
    expect(spendCount(ctx)).toBe(reservations);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Antiga 3']);
  });

  it('runs at the cost agreed', async () => {
    const ctx = await failedOverAProposal();
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    ctx.llm.replies.push(wholeWindow(), wholeWindow());
    const run = await ctx.service.start(OWNER, ctx.mediaId, {
      acceptedUsd: estimateUsd,
    });
    await ctx.service.idle();
    expect(ctx.service.getRun(OWNER, ctx.mediaId, run.id).status).toBe('done');
  });

  it('a restart past the run cap is refused and leaves everything in place', async () => {
    const ctx = await failedOverAProposal();
    unfit(ctx);
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    const capped = new ProposalService({
      store: ctx.store,
      ledger: ctx.ledger,
      transcripts: ctx.transcripts,
      findMedia: (_actor, id) => itemOf(id, null),
      contextOf: () => ({ collection: 'Hermetismo', knownNames: [] }),
      segmentVoices: () => null,
      llm: () => ctx.llm,
      caps: { runUsd: estimateUsd / 2, monthlyUsd: 10 },
      now: () => NOW,
    });
    expect(await capped.estimate(OWNER, ctx.mediaId)).toMatchObject({
      allowed: false,
      refusal: 'run-cap',
      restarts: true,
    });
    const calls = ctx.llm.calls.length;
    await expect(capped.start(OWNER, ctx.mediaId)).rejects.toMatchObject({
      code: 'MEDIA_SPEND_CAP',
    });
    expect(ctx.llm.calls).toHaveLength(calls);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Antiga 3']);
  });

  it('two presses on a retry after a save run once and reserve once', async () => {
    const ctx = await failedOverAProposal();
    editing(ctx).save({ index: 2, title: 'Dela' });
    const reservations = Number(spendCount(ctx));
    const before = ctx.llm.calls.length;
    ctx.llm.replies.push(wholeWindow(), wholeWindow());
    const presses = await Promise.allSettled([
      ctx.service.start(OWNER, ctx.mediaId),
      ctx.service.start(OWNER, ctx.mediaId),
    ]);
    await ctx.service.idle();
    expect(presses.map(({ status }) => status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(ctx.llm.calls).toHaveLength(before + 2);
    expect(spendCount(ctx)).toBe(reservations + 1);
    expect(titles(ctx)).toHaveLength(3);
  });

  it('a reload changes nothing about a retry: the database decides', async () => {
    const ctx = await failedOverAProposal();
    editing(ctx).save({ index: 2, title: 'Dela' });
    const seen = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(
      new SqliteMediaEditStore(ctx.db).edit(ctx.mediaId)?.version,
    ).toBeGreaterThan(0);
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toEqual(seen);
    expect(ctx.service.draft(OWNER, ctx.mediaId).lastFailure).toBe('provider');
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Dela']);
  });
});

describe('ProposalService: never past the value accepted (KBC-112)', () => {
  const THREE_WINDOWS = evenSegments(130);
  const spendRows = (ctx: Ctx) =>
    ctx.db
      .prepare('SELECT status, spent_usd FROM media_spend ORDER BY rowid')
      .all()
      .map((row) => ({
        status: String(row['status']),
        spentUsd: Number(row['spent_usd']),
      }));
  const titles = (ctx: Ctx) =>
    ctx.service.draft(OWNER, ctx.mediaId).tracks.map(({ title }) => title);
  /** An answer that cannot be read, longer than the room the estimate keeps per window. */
  const LONG_UNREADABLE = 'x'.repeat(4_000);

  /**
   * QA BUG-2 of KBC-097: each call bills a third of the estimate and the second window is
   * asked again: before KBC-112 the run went on to 4/3 of the value accepted.
   */
  async function askedAgain() {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [LONG_UNREADABLE, wholeWindow(), wholeWindow()],
    });
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    ctx.llm.replies.unshift(wholeWindow());
    ctx.llm.costPerCall = estimateUsd / 3;
    return { ctx, estimateUsd };
  }

  it('asks a window again only when it fits, and closes within the value (AC-1)', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [wholeWindow(), 'ilegível', wholeWindow(), wholeWindow()],
    });
    ctx.llm.costPerCall = null;
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    const run = await runToEnd(ctx, OWNER, { acceptedUsd: estimateUsd });
    expect(run).toMatchObject({ status: 'done', windowsDone: 3 });
    expect(ctx.llm.calls).toHaveLength(4);
    expect(run.limitUsd).toBe(estimateUsd);
    expect(run.spentUsd).toBeLessThanOrEqual(estimateUsd);
    const [row] = spendRows(ctx);
    expect(row?.status).toBe('settled');
    expect(row?.spentUsd).toBeLessThanOrEqual(estimateUsd);
  });

  it('stops before a window asked again that does not fit, keeping what is done (AC-2, AC-11)', async () => {
    const { ctx, estimateUsd } = await askedAgain();
    const run = await runToEnd(ctx, OWNER, { acceptedUsd: estimateUsd });
    expect(run).toMatchObject({
      status: 'failed',
      failure: 'accepted-limit',
      windowsDone: 1,
      limitUsd: estimateUsd,
    });
    expect(ctx.llm.calls).toHaveLength(2);
    expect(titles(ctx)).toEqual(['Janela 1']);
    const draft = ctx.service.draft(OWNER, ctx.mediaId);
    expect(draft.lastFailure).toBe('accepted-limit');
    expect(draft.stopped).toEqual({
      limitUsd: estimateUsd,
      spentUsd: run.spentUsd,
      windowsDone: 1,
      windowsTotal: 3,
    });
    expect(run.spentUsd).toBeCloseTo((estimateUsd * 2) / 3, 12);
    // The house account's ledger: one entry, the unspent part of the reservation given back.
    expect(spendRows(ctx)).toEqual([
      { status: 'refunded', spentUsd: run.spentUsd },
    ]);
    expect(monthUsed(ctx)).toBeLessThanOrEqual(estimateUsd);
    expect(ctx.errors.map(String)).toEqual([
      'ProposalStop: proposal stopped: accepted-limit',
    ]);
  });

  it('a retry asks only the windows left, within its own new value (AC-3)', async () => {
    const { ctx } = await askedAgain();
    const first = await runToEnd(ctx, OWNER, {
      acceptedUsd: (await ctx.service.estimate(OWNER, ctx.mediaId)).estimateUsd,
    });
    const rest = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(rest.windows).toBe(2);
    ctx.llm.costPerCall = rest.estimateUsd / 4;
    ctx.llm.replies.splice(
      0,
      ctx.llm.replies.length,
      wholeWindow(),
      wholeWindow(),
    );
    const asked = ctx.llm.calls.length;
    const second = await runToEnd(ctx, OWNER, {
      acceptedUsd: rest.estimateUsd,
    });
    expect(second).toMatchObject({
      status: 'done',
      windowsDone: 3,
      limitUsd: rest.estimateUsd,
    });
    const firstIds = ctx.llm.calls
      .slice(asked)
      .map((call) => windowIds(String(call.at(-1)?.content)).first);
    expect(firstIds).toHaveLength(2);
    expect(Math.min(...firstIds)).toBeGreaterThan(1);
    const rows = spendRows(ctx);
    expect(rows[1]?.spentUsd).toBeLessThanOrEqual(rest.estimateUsd);
    expect(second.spentUsd).toBeCloseTo(
      first.spentUsd + (rows[1]?.spentUsd ?? 0),
      12,
    );
    expect(second.spentUsd).toBeLessThanOrEqual(0.25);
  });

  it('meets the run cap, not the value, when what the cap has left is less (AC-4)', async () => {
    const ctx = dear([wholeWindow(), new Error('HTTP 503')]);
    await runToEnd(ctx);
    ctx.llm.replies.push('ilegível', wholeWindow(), wholeWindow());
    // US$ 0.20 accepted, US$ 0.175 left of the cap: the cap is the limit.
    const second = await runToEnd(ctx, OWNER, { acceptedUsd: 0.2 });
    expect(second).toMatchObject({ failure: 'run-cap', windowsDone: 2 });
    expect(second.limitUsd).toBeCloseTo(0.175, 12);
    expect(spendRows(ctx)[1]?.spentUsd).toBeLessThanOrEqual(0.175);
  });

  it('a restart pays the windows again within the value accepted (AC-5)', async () => {
    const { ctx } = await askedAgain();
    await runToEnd(ctx, OWNER, {
      acceptedUsd: (await ctx.service.estimate(OWNER, ctx.mediaId)).estimateUsd,
    });
    ctx.db
      .prepare(
        `UPDATE media_proposal_runs SET windows_total = 99 WHERE status = 'failed'`,
      )
      .run();
    const whole = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(whole).toMatchObject({ restarts: true, windows: 3 });
    ctx.llm.replies.splice(
      0,
      ctx.llm.replies.length,
      wholeWindow(),
      LONG_UNREADABLE,
    );
    const asked = ctx.llm.calls.length;
    const again = await runToEnd(ctx, OWNER, {
      acceptedUsd: whole.estimateUsd,
    });
    expect(windowIds(String(ctx.llm.calls[asked]?.at(-1)?.content)).first).toBe(
      1,
    );
    expect(again).toMatchObject({ failure: 'accepted-limit' });
    expect(spendRows(ctx)[1]?.spentUsd).toBeLessThanOrEqual(whole.estimateUsd);
  });

  it('without a value sent, the estimate here is the limit (AC-10)', async () => {
    const { ctx, estimateUsd } = await askedAgain();
    const run = await runToEnd(ctx);
    expect(run).toMatchObject({
      failure: 'accepted-limit',
      windowsDone: 1,
      limitUsd: estimateUsd,
    });
    expect(spendRows(ctx)[0]?.spentUsd).toBeLessThanOrEqual(estimateUsd);
  });

  it('reserves the limit, not the estimate, in the media month (BR-9)', async () => {
    const ctx = setup({ segments: THREE_WINDOWS, replies: [HANG] });
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    await ctx.service.start(OWNER, ctx.mediaId, {
      acceptedUsd: estimateUsd * 1.25,
    });
    expect(monthUsed(ctx)).toBeCloseTo(estimateUsd * 1.25, 12);
    await ctx.service.stop();
  });

  it('an API that stops keeps the windows done, closes within the value and waits for a person (AC-12)', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [wholeWindow(), HANG],
    });
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    await ctx.service.start(OWNER, ctx.mediaId, { acceptedUsd: estimateUsd });
    await vi.waitFor(() => expect(ctx.llm.calls).toHaveLength(2));
    await ctx.service.stop();
    const after = new ProposalService(ctxDeps(ctx));
    after.recover();
    const draft = after.draft(OWNER, ctx.mediaId);
    expect(draft).toMatchObject({
      lastFailure: 'interrupted',
      tracks: [{ title: 'Janela 1' }],
    });
    const [row] = spendRows(ctx);
    expect(row?.status).toBe('refunded');
    expect(row?.spentUsd).toBeLessThanOrEqual(estimateUsd);
    await after.idle();
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it('of two presses at once, only one runs, at its own limit (AC-13)', async () => {
    const ctx = setup({ segments: THREE_WINDOWS, replies: [HANG] });
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    const results = await Promise.allSettled([
      ctx.service.start(OWNER, ctx.mediaId, { acceptedUsd: estimateUsd }),
      ctx.service.start(OWNER, ctx.mediaId, { acceptedUsd: estimateUsd * 2 }),
    ]);
    const started = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(started).toHaveLength(1);
    expect([estimateUsd, estimateUsd * 2]).toContain(started[0]?.limitUsd);
    expect(spendRows(ctx)).toHaveLength(1);
    expect(monthUsed(ctx)).toBeCloseTo(started[0]?.limitUsd ?? -1, 12);
    await ctx.service.stop();
  });

  it('a provider billing past a call worst case is logged and the ledger stays at the limit (FR-7)', async () => {
    const ctx = setup({ replies: [wholeWindow()] });
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    ctx.llm.costPerCall = estimateUsd * 3;
    const run = await runToEnd(ctx, OWNER, { acceptedUsd: estimateUsd });
    expect(run.status).toBe('done');
    expect(spendRows(ctx)).toEqual([
      { status: 'settled', spentUsd: estimateUsd },
    ]);
    expect(String(ctx.errors[0])).toMatch(/past its limit/);
  });

  it('a clean pass billed at its worst case, with long tracks before each window, fits the estimate (QA-1)', async () => {
    // Every window answers a track per two segments with a long title: the block of the
    // window before (about 30 tracks) is far past the room the estimate gives it unless the
    // prompt bounds it.
    const manyTracks: StubReply = (user) => {
      const { first, last } = windowIds(user);
      const faixas = [];
      for (let id = first; id <= last; id += 2)
        faixas.push({
          primeiro_id: id,
          ultimo_id: Math.min(id + 1, last),
          tipo: 'exposicao',
          quem_pergunta: null,
          quem_responde: null,
          titulo: `Um título longo de faixa ${id} sobre o tema da palestra e suas partes`,
          continua_faixa_anterior: false,
        });
      return JSON.stringify({ faixas });
    };
    const ctx = setup({
      segments: evenSegments(250),
      price: { input: 1e-6, output: 1e-6 },
    });
    const { estimateUsd, windows } = await ctx.service.estimate(
      OWNER,
      ctx.mediaId,
    );
    ctx.llm.replies.push(...Array.from({ length: windows }, () => manyTracks));
    ctx.llm.billOf = (messages) => callCeiling(messages, ctx.llm.priceList);
    const run = await runToEnd(ctx, OWNER, { acceptedUsd: estimateUsd });
    expect(windows).toBeGreaterThan(2);
    expect(run).toMatchObject({ status: 'done', failure: null });
    expect(ctx.llm.calls).toHaveLength(windows);
    expect(run.spentUsd).toBeLessThanOrEqual(estimateUsd);
  });

  it('no run ever closes past its limit: 200 synthetic runs (NFR-1)', async () => {
    let seed = 112;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(random() * items.length)] as T;
    const sixPlaces = (low: number, high: number) =>
      Math.round((low + random() * (high - low)) * 1e6) / 1e6 / 1e6;
    const reply = (): StubReply =>
      pick<StubReply>([
        wholeWindow(),
        wholeWindow(),
        'ilegível',
        LONG_UNREADABLE,
        new BrokenStream('{"faixas": ['),
        new Error('HTTP 503'),
      ]);
    const failures: (string | null)[] = [];
    for (let index = 0; index < 200; index++) {
      const ctx = setup({
        segments: evenSegments(pick([30, 70, 130])),
        replies: Array.from({ length: 8 }, reply),
        price: { input: sixPlaces(0.05, 2), output: sixPlaces(0.2, 8) },
      });
      const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
      ctx.llm.costPerCall = pick([null, (estimateUsd / 3) * random()]);
      const terms = pick([
        {},
        { acceptedUsd: estimateUsd },
        { acceptedUsd: estimateUsd * (1 + random() / 4) },
      ]);
      const run = await runToEnd(ctx, OWNER, terms);
      const limit = run.limitUsd ?? -1;
      expect(limit).toBeGreaterThanOrEqual(estimateUsd);
      for (const row of spendRows(ctx))
        expect(row.spentUsd).toBeLessThanOrEqual(limit);
      expect(run.spentUsd).toBeLessThanOrEqual(limit);
      // The bills drawn stay under a call's worst case, so the ledger's clamp (FR-7) never
      // acts: what holds the limit is the check before each call.
      expect(
        ctx.errors.map(String).filter((error) => /past its limit/.test(error)),
      ).toEqual([]);
      failures.push(run.failure);
    }
    // The draw reaches the limit often, not just runs that never come near it.
    expect(
      failures.filter((failure) => failure === 'accepted-limit').length,
    ).toBeGreaterThanOrEqual(10);
    expect(
      failures.filter((failure) => failure === null).length,
    ).toBeGreaterThanOrEqual(20);
    // 200 databases with every migration: seconds, not the default 5 s budget.
  }, 30_000);
});
