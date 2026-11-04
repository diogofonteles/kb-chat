import { setTimeout as sleep } from 'node:timers/promises';
import type { MediaPreparation, TranscriptSpeakers } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  HANG,
  StubLlm,
  evenSegments,
  itemOf,
  proposalDb,
  wholeWindow,
  type StubReply,
} from '../test/track-proposal-fixtures.js';
import { SqlitePreparationStore } from './adapters/sqlite/sqlite-preparation-store.js';
import type { PlanActor } from './modules/media/index.js';
import { PreparationService } from './modules/preparation/index.js';
import { ProposalService } from './modules/track-proposals/index.js';

const OWNER: PlanActor = {
  principal: 'owner',
  isMaster: true,
  canUpload: true,
  canSee: () => true,
  canEdit: true,
  canPropose: true,
};

const SPEAKERS: TranscriptSpeakers = {
  version: 1,
  createdAt: '2026-11-04T12:00:00.000Z',
  transcriptVersion: 1,
  staleTranscript: false,
  requestedVoices: null,
  voiceCount: 0,
  voices: [],
  turns: [],
  labels: [],
  merged: [],
  namesPending: false,
};

/** A model whose price takes this long, call by call: the price out of the cache. */
class SlowPriceLlm extends StubLlm {
  readonly delaysMs: number[] = [];

  override async price() {
    await sleep(this.delaysMs.shift() ?? 0);
    return this.priceList;
  }
}

/** One recording with an AI plan, over the real stores and the real proposal service. */
function setup(replies: StubReply[]) {
  const db = proposalDb(evenSegments(30));
  const llm = new SlowPriceLlm(replies);
  const plans = new SqlitePreparationStore(db.db);
  let clock = Date.parse('2026-11-04T12:00:00Z');
  const now = () => new Date((clock += 1000));
  const proposals = new ProposalService({
    store: db.store,
    ledger: db.ledger,
    transcripts: db.transcripts,
    findMedia: (_actor, id) => itemOf(id, null),
    contextOf: () => ({ collection: 'Hermetismo', knownNames: [] }),
    segmentVoices: () => null,
    llm: () => llm,
    caps: { runUsd: 0.25, monthlyUsd: 10 },
    now,
  });
  const service = new PreparationService({
    plans,
    followable: () => null,
    transcripts: db.transcripts,
    separation: {
      status: () => 'done',
      voicesOn: () => ({ speakers: SPEAKERS }),
      request: () => false,
    },
    edits: { edit: () => null },
    drafts: db.store,
    findMedia: (_actor, id) => itemOf(id, null),
    retryConversion: () => undefined,
    speakerNames: () => new Map(),
    proposals,
    actorOf: async () => OWNER,
    presence: () => ({ transcriber: 'on', offSince: null }),
    now,
  });
  plans.save({
    mediaId: db.mediaId,
    principal: 'owner',
    plan: {
      transcribe: false,
      speakers: false,
      tracks: 'ai',
      subjects: false,
      acceptedUsd: 0.05,
    },
    finished: false,
    now: now(),
  });
  return { ...db, llm, plans, proposals, service };
}

type Ctx = ReturnType<typeof setup>;

const tracksOf = (view: MediaPreparation) =>
  view.stages.find(({ stage }) => stage === 'tracks');

/** The plan took the paid stage and it failed: "Tentar de novo" is on the screen. */
async function failedOnce(ctx: Ctx): Promise<void> {
  await ctx.service.advance(ctx.mediaId);
  await ctx.proposals.idle();
  const view = await ctx.service.view(OWNER, ctx.mediaId);
  expect(tracksOf(view)).toMatchObject({ state: 'failed', canRetry: true });
}

const retry = (ctx: Ctx) =>
  ctx.service.retry(OWNER, ctx.mediaId, { stage: 'tracks' });

const outcomes = (results: readonly PromiseSettledResult<unknown>[]) =>
  results.map(({ status }) => status).sort();

describe('two clicks on "Tentar de novo" with the price out of the cache (BUG-10)', () => {
  it('starts one analysis and leaves it standing while it runs', async () => {
    const ctx = setup([new Error('HTTP 503'), HANG]);
    await failedOnce(ctx);
    ctx.llm.delaysMs.push(5, 5, 5, 5);
    const results = await Promise.allSettled([retry(ctx), retry(ctx)]);
    expect(outcomes(results)).toEqual(['fulfilled', 'rejected']);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'MEDIA_CONFLICT' },
    });
    expect(ctx.plans.get(ctx.mediaId)?.proposalStop).toBeNull();
    const view = await ctx.service.view(OWNER, ctx.mediaId);
    expect(tracksOf(view)?.state).toBe('running');
    expect(ctx.llm.calls).toHaveLength(2);
    await ctx.proposals.stop();
  });

  it('does not pay again for an analysis that ended during the second click', async () => {
    const ctx = setup([new Error('HTTP 503'), wholeWindow()]);
    await failedOnce(ctx);
    ctx.llm.delaysMs.push(0, 40);
    const results = await Promise.allSettled([retry(ctx), retry(ctx)]);
    await ctx.proposals.idle();
    expect(outcomes(results)).toEqual(['fulfilled', 'rejected']);
    expect(ctx.llm.calls).toHaveLength(2);
    const view = await ctx.service.view(OWNER, ctx.mediaId);
    expect(tracksOf(view)?.state).toBe('done');
    expect(view.next).toBe('validate');
  });
});

describe('the plan meets an analysis started on the tracks screen (BUG-10)', () => {
  it('follows it instead of stopping over it', async () => {
    const ctx = setup([HANG]);
    await ctx.proposals.start(OWNER, ctx.mediaId);
    await ctx.service.advance(ctx.mediaId);
    expect(ctx.plans.get(ctx.mediaId)?.proposalStop).toBeNull();
    const view = await ctx.service.view(OWNER, ctx.mediaId);
    expect(tracksOf(view)?.state).toBe('running');
    await ctx.proposals.stop();
  });
});
