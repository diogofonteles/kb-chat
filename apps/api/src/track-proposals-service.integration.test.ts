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
  isEstimateRose,
} from './modules/track-proposals/index.js';
import type { MediaActor } from './modules/media/index.js';

const OWNER: MediaActor = {
  principal: 'owner',
  isMaster: true,
  canUpload: true,
  canSee: () => true,
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

async function runToEnd(ctx: Ctx, actor: MediaActor = OWNER) {
  const run = await ctx.service.start(actor, ctx.mediaId);
  await ctx.service.idle();
  return ctx.service.getRun(actor, ctx.mediaId, run.id);
}

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
    const run = await runToEnd(ctx);
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
    const run = await runToEnd(ctx);
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
    const ctx = setup({
      segments: evenSegments(130),
      replies: ['nada', 'nada'],
    });
    const estimate = await ctx.service.estimate(OWNER, ctx.mediaId);
    ctx.llm.costPerCall = estimate.estimateUsd * 1.4;
    const capped = new ProposalService({
      ...ctxDeps(ctx),
      caps: { runUsd: estimate.estimateUsd * 1.5, monthlyUsd: 10 },
    });
    const started = await capped.start(OWNER, ctx.mediaId);
    await capped.idle();
    expect(capped.getRun(OWNER, ctx.mediaId, started.id)).toMatchObject({
      status: 'failed',
      failure: 'run-cap',
    });
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('prices a call from the list when the provider reports no cost', async () => {
    const ctx = setup({ replies: [wholeWindow()] });
    ctx.llm.costPerCall = null;
    const run = await runToEnd(ctx);
    // 100 input and 50 output tokens at US$ 1e-7 and 2e-7.
    expect(run.spentUsd).toBeCloseTo(100 * 1e-7 + 50 * 2e-7, 12);
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
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [wholeWindow(), new Error('HTTP 503')],
    });
    ctx.llm.costPerCall = 0.2;
    await runToEnd(ctx);
    ctx.llm.replies.push(wholeWindow(), wholeWindow());
    const second = await runToEnd(ctx);
    expect(second).toMatchObject({
      status: 'failed',
      failure: 'run-cap',
      windowsDone: 2,
    });
    expect(second.spentUsd).toBeCloseTo(0.4, 9);
  });

  it('holds the run cap over attempts that finished no window', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: ['ilegível', 'ilegível', 'ilegível', 'ilegível'],
    });
    ctx.llm.costPerCall = 0.1;
    const first = await runToEnd(ctx);
    expect(first).toMatchObject({ failure: 'invalid-output', windowsDone: 0 });
    expect(first.spentUsd).toBeCloseTo(0.2, 9);
    const second = await runToEnd(ctx);
    expect(second).toMatchObject({ status: 'failed', failure: 'run-cap' });
    expect(second.spentUsd).toBeCloseTo(0.3, 9);
    expect(ctx.llm.calls).toHaveLength(3);
    expect(monthUsed(ctx)).toBeCloseTo(0.3, 9);
  });

  it('refuses, in the estimate and at the start, an analysis past its cap (BUG-9)', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [wholeWindow(), new Error('HTTP 503')],
    });
    ctx.llm.costPerCall = 0.2;
    await runToEnd(ctx);
    ctx.llm.replies.push(wholeWindow(), wholeWindow());
    await runToEnd(ctx);
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
    /** A save of the visible draft, as the editor sends it, with one track renamed. */
    const save = (rename?: {
      readonly index: number;
      readonly title: string;
    }) =>
      service.save(call(), {
        step: 3,
        tracks: ctx.store.draft(ctx.mediaId).tracks.map((track, index) => ({
          id: track.id,
          source: track.source,
          startMs: track.startMs,
          endMs: track.endMs,
          kind: track.kind,
          title: index === rename?.index ? rename.title : track.title,
          askerVoice: track.askerVoice,
          answererVoice: track.answererVoice,
          askerSpeakerId: track.askerSpeakerId,
          answererSpeakerId: track.answererSpeakerId,
        })),
      });
    return { save, approve: () => service.approve(call()), edits, service };
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

  const askedFrom = (ctx: Ctx, callsBefore: number) =>
    ctx.llm.calls
      .slice(callsBefore)
      .map((call) => windowIds(String(call.at(-1)?.content)).first);

  it('a save then a retry loses nothing: it starts over, at the value it says', async () => {
    const ctx = await failedOverAProposal();
    const resume = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(resume).toMatchObject({ windows: 2, restarts: false });
    editing(ctx).save({ index: 2, title: 'Dela' });

    const restart = await ctx.service.estimate(OWNER, ctx.mediaId);
    expect(restart).toMatchObject({ windows: 3, restarts: true });
    expect(restart.estimateUsd).toBeGreaterThan(resume.estimateUsd);

    const before = ctx.llm.calls.length;
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 1' }),
      wholeWindow({ title: 'Nova 2' }),
      wholeWindow({ title: 'Nova 3' }),
    );
    await runToEnd(ctx);
    expect(askedFrom(ctx, before)).toHaveLength(3);
    expect(askedFrom(ctx, before)[0]).toBe(1);
    const { tracks } = ctx.store.draft(ctx.mediaId);
    expect(tracks.map(({ title }) => title)).toEqual([
      'Nova 1',
      'Nova 2',
      'Dela',
    ]);
    expect(timingProblems(tracks, null)).toEqual([]);
  });

  it('a failed restart leaves on screen what the person had', async () => {
    const ctx = await failedOverAProposal();
    editing(ctx).save({ index: 2, title: 'Dela' });
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 1' }),
      new Error('HTTP 503'),
    );
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Dela']);
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

  it('after an approval a retry resumes: nothing can be lost, so nothing is paid twice', async () => {
    const ctx = await failedOverAProposal();
    const editor = editing(ctx);
    editor.approve();
    await editor.service.reopen({
      actor: OWNER,
      mediaId: ctx.mediaId,
      expectedVersion: editor.edits.edit(ctx.mediaId)?.version ?? 0,
    });
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      windows: 2,
      restarts: false,
    });
    ctx.llm.replies.push(wholeWindow(), wholeWindow());
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Antiga 3']);
  });

  it('a person’s deletion of a failed run they saw stands, and pays nothing twice', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [wholeWindow({ title: 'Vista' }), new Error('HTTP 503')],
    });
    await runToEnd(ctx);
    const editor = editing(ctx);
    editor.service.save(
      {
        actor: OWNER,
        mediaId: ctx.mediaId,
        expectedVersion: editor.edits.edit(ctx.mediaId)?.version ?? 0,
      },
      { step: 3, tracks: [] },
    );
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      windows: 2,
      restarts: false,
    });
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

  it('a failed run out of sight never surfaces when a later one ends', async () => {
    const ctx = await failedOverAProposal();
    const { db, mediaId } = ctx;
    // Its windows no longer fit: the next run starts over and the hidden tracks stay behind.
    db.prepare(
      `UPDATE media_proposal_runs SET windows_total = 99 WHERE status = 'failed'`,
    ).run();
    ctx.llm.replies.push(
      wholeWindow({ title: 'Nova 1' }),
      wholeWindow({ title: 'Nova 2' }),
      NOTHING_USABLE,
    );
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Nova 1', 'Nova 2', 'Antiga 3']);
    expect(
      db
        .prepare(
          'SELECT count(*) AS n FROM media_draft_tracks WHERE media_id = ?',
        )
        .get(mediaId)?.['n'],
    ).toBe(3);
  });

  it('a failed run that takes the screen keeps the tracks of the one before', async () => {
    const ctx = setup({
      segments: THREE_WINDOWS,
      replies: [
        wholeWindow({ title: 'Vista 1' }),
        wholeWindow({ title: 'Vista 2' }),
        new Error('HTTP 503'),
      ],
    });
    await runToEnd(ctx);
    ctx.db.prepare('UPDATE media_proposal_runs SET windows_total = 99').run();
    ctx.llm.replies.push(NOTHING_USABLE);
    ctx.llm.replies.push(new Error('HTTP 503'));
    await runToEnd(ctx);
    expect(titles(ctx)).toEqual(['Vista 1', 'Vista 2']);
  });

  it('refuses a cost above the one agreed, reserving and asking nothing', async () => {
    const ctx = await failedOverAProposal();
    const agreed = await ctx.service.estimate(OWNER, ctx.mediaId);
    editing(ctx).save({ index: 2, title: 'Dela' });
    const calls = ctx.llm.calls.length;
    const reservations = spendCount(ctx);
    const refused = await ctx.service
      .start(OWNER, ctx.mediaId, { acceptedUsd: agreed.estimateUsd })
      .catch((err: unknown) => err);
    expect(isEstimateRose(refused)).toBe(true);
    expect(refused).toMatchObject({
      details: {
        estimateUsd: (await ctx.service.estimate(OWNER, ctx.mediaId))
          .estimateUsd,
      },
    });
    expect(ctx.llm.calls).toHaveLength(calls);
    expect(spendCount(ctx)).toBe(reservations);
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Dela']);
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
    editing(ctx).save({ index: 2, title: 'Dela' });
    const { estimateUsd } = await ctx.service.estimate(OWNER, ctx.mediaId);
    const capped = {
      ...ctx,
      service: new ProposalService({
        store: ctx.store,
        ledger: ctx.ledger,
        transcripts: ctx.transcripts,
        findMedia: (_actor, id) => itemOf(id, null),
        contextOf: () => ({ collection: 'Hermetismo', knownNames: [] }),
        segmentVoices: () => null,
        llm: () => ctx.llm,
        caps: { runUsd: estimateUsd, monthlyUsd: 10 },
        now: () => NOW,
      }),
    };
    expect(await capped.service.estimate(OWNER, ctx.mediaId)).toMatchObject({
      allowed: false,
      refusal: 'run-cap',
      restarts: true,
    });
    await expect(
      capped.service.start(OWNER, ctx.mediaId),
    ).rejects.toMatchObject({
      code: 'MEDIA_SPEND_CAP',
    });
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Dela']);
  });

  it('two presses on a retry run once and reserve once', async () => {
    const ctx = await failedOverAProposal();
    editing(ctx).save({ index: 2, title: 'Dela' });
    const reservations = Number(spendCount(ctx));
    const before = ctx.llm.calls.length;
    ctx.llm.replies.push(wholeWindow(), wholeWindow(), wholeWindow());
    const presses = await Promise.allSettled([
      ctx.service.start(OWNER, ctx.mediaId),
      ctx.service.start(OWNER, ctx.mediaId),
    ]);
    await ctx.service.idle();
    expect(presses.map(({ status }) => status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(ctx.llm.calls).toHaveLength(before + 3);
    expect(spendCount(ctx)).toBe(reservations + 1);
    expect(titles(ctx)).toHaveLength(3);
  });

  it('a reload changes nothing about a retry: the database decides', async () => {
    const ctx = await failedOverAProposal();
    editing(ctx).save({ index: 2, title: 'Dela' });
    const seen = await ctx.service.estimate(OWNER, ctx.mediaId);
    const after = editing(ctx);
    expect(after.edits.edit(ctx.mediaId)?.version).toBeGreaterThan(0);
    expect(await ctx.service.estimate(OWNER, ctx.mediaId)).toEqual(seen);
    expect(ctx.service.draft(OWNER, ctx.mediaId).lastFailure).toBe('provider');
    expect(titles(ctx)).toEqual(['Antiga 1', 'Antiga 2', 'Dela']);
  });
});
