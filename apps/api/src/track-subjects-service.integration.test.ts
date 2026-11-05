import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  itemOf,
  proposalDb,
  evenSegments,
  StubLlm,
  HANG,
  BrokenStream,
  type StubReply,
} from '../test/track-proposal-fixtures.js';
import { SqliteTrackSubjectStore } from './adapters/sqlite/sqlite-track-subject-store.js';
import type { MediaActor } from './modules/media/index.js';
import {
  SubjectProposalService,
  TrackSubjectService,
} from './modules/track-subjects/index.js';

const OWNER: MediaActor = {
  principal: 'owner',
  isMaster: true,
  canUpload: true,
  seesTracks: true,
  canSee: () => true,
};
const HELPER: MediaActor = { ...OWNER, isMaster: false, principal: 'helper' };

const CONCEPTS = ['Cabala', 'Ritmo', 'Alquimia'];
const FOUR_HOURS_MS = 14_400_000;

/** One track row per 50 s of the recording, each cut into its own media row. */
function insertTracks(
  ctx: ReturnType<typeof proposalDb>,
  count: number,
): string[] {
  const now = new Date().toISOString();
  const ids = Array.from({ length: count }, () => randomUUID());
  ctx.db
    .prepare(
      `INSERT INTO media_edits (media_id, version, status, step, updated_at)
       VALUES (?, 3, 'approved', 4, ?)`,
    )
    .run(ctx.mediaId, now);
  ids.forEach((id, index) => {
    ctx.db
      .prepare(
        `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
           upload_bytes, status, created_at, updated_at, parent_media_id, parent_start_ms,
           parent_end_ms, track_ordinal)
         VALUES (?, 'hermetismo', ?, 'outros-autores', 'owner', 't.m4a', 10, 'ready', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Faixa ${index + 1}`,
        now,
        now,
        ctx.mediaId,
        index * 50_000,
        (index + 1) * 50_000,
        index + 1,
      );
    ctx.db
      .prepare(
        `INSERT INTO media_tracks (id, media_id, ordinal, start_ms, end_ms, kind, title, source,
           approved_by, approved_at, derived_media_id, cut_status)
         VALUES (?, ?, ?, ?, ?, 'qa', ?, 'manual', 'owner', ?, ?, 'published')`,
      )
      .run(
        randomUUID(),
        ctx.mediaId,
        index + 1,
        index * 50_000,
        (index + 1) * 50_000,
        `Faixa ${index + 1}`,
        now,
        id,
      );
  });
  return ids;
}

const replyFor = (
  faixas: readonly {
    faixa: number;
    assuntos?: readonly string[];
    novos?: readonly string[];
    resumo?: string;
  }[],
) => JSON.stringify({ faixas });

function setup(
  input: {
    tracks?: number;
    replies?: StubReply[];
    concepts?: string[];
    monthlyUsd?: number;
    runUsd?: number;
    noLlm?: boolean;
  } = {},
) {
  const ctx = proposalDb(evenSegments(30));
  const tracks = insertTracks(ctx, input.tracks ?? 3);
  const store = new SqliteTrackSubjectStore(ctx.db);
  const concepts = { names: input.concepts ?? CONCEPTS };
  const llm = new StubLlm(input.replies ?? []);
  const findMedia = (_actor: MediaActor, id: string) => ({
    ...itemOf(id, null),
    durationMs: FOUR_HOURS_MS,
  });
  const media = {
    getMedia: (id: string) => {
      const row = ctx.db
        .prepare(
          `SELECT id, topic, title, parent_media_id, parent_start_ms, parent_end_ms,
             track_ordinal, archived_at FROM media WHERE id = ?`,
        )
        .get(id);
      if (!row) return null;
      return {
        id: String(row['id']),
        topic: String(row['topic']),
        title: String(row['title']),
        status: 'ready' as const,
        archivedAt:
          row['archived_at'] === null ? null : String(row['archived_at']),
        track:
          row['parent_media_id'] === null
            ? null
            : {
                parentId: String(row['parent_media_id']),
                startMs: Number(row['parent_start_ms']),
                endMs: Number(row['parent_end_ms']),
                ordinal: Number(row['track_ordinal']),
                version: 0,
                fileVersion: 1,
              },
      };
    },
  };
  const titles = {
    tracksOf: (parentId: string) =>
      ctx.db
        .prepare(
          `SELECT ordinal, title, start_ms, end_ms, derived_media_id FROM media_tracks
           WHERE media_id = ? AND derived_media_id IS NOT NULL ORDER BY ordinal`,
        )
        .all(parentId)
        .map((row) => ({
          ordinal: Number(row['ordinal']),
          title: String(row['title']),
          startMs: Number(row['start_ms']),
          endMs: Number(row['end_ms']),
          mediaId: String(row['derived_media_id']),
        })),
  };
  const subjects = new TrackSubjectService({
    store,
    media,
    items: titles,
    findMedia,
    rootOf: (topic) => topic,
    conceptsOf: () => concepts.names,
    directory: { about: () => ({ subjects: [], summary: null }) },
  });
  const proposals = new SubjectProposalService({
    store,
    ledger: ctx.ledger,
    subjects,
    items: titles,
    edits: {
      edit: (id) => {
        const row = ctx.db
          .prepare('SELECT version, status FROM media_edits WHERE media_id = ?')
          .get(id);
        return row
          ? {
              version: Number(row['version']),
              status:
                String(row['status']) === 'approved' ? 'approved' : 'draft',
            }
          : null;
      },
    },
    transcripts: ctx.transcripts,
    findMedia,
    llm: () => (input.noLlm ? null : llm),
    caps: { runUsd: input.runUsd ?? 0.25, monthlyUsd: input.monthlyUsd ?? 10 },
  });
  const suggest = async () => {
    const run = await proposals.start(OWNER, ctx.mediaId);
    await proposals.idle();
    return store.run(run.id);
  };
  return {
    ...ctx,
    tracks,
    subjects,
    proposals,
    llm,
    concepts,
    suggest,
    trackStore: store,
  };
}

const spend = (ctx: ReturnType<typeof setup>) =>
  ctx.db.prepare('SELECT kind, status, spent_usd FROM media_spend').all();

describe('Free subjects of a collection (KBC-069 FR-1)', () => {
  it('lists the catalog concepts and the free subjects, and refuses a repeat without accent or capitals (AC-4)', () => {
    const ctx = setup();
    const created = ctx.subjects.createFree(OWNER, 'hermetismo', 'Burracheira');
    expect(ctx.subjects.collection('hermetismo')).toEqual({
      concepts: CONCEPTS,
      free: [created],
    });
    for (const repeat of ['burracheira', 'BURRACHEIRA ', 'Burrachéira'])
      expect(() =>
        ctx.subjects.createFree(OWNER, 'hermetismo', repeat),
      ).toThrow(
        expect.objectContaining({
          code: 'MEDIA_CONFLICT',
          details: expect.objectContaining({ reason: 'duplicate-subject' }),
        }),
      );
  });

  it('refuses a free subject that repeats a concept of the collection', () => {
    const ctx = setup();
    expect(() =>
      ctx.subjects.createFree(OWNER, 'hermetismo', 'cabalá'),
    ).toThrow(expect.objectContaining({ code: 'MEDIA_CONFLICT' }));
  });
});

describe('The subjects of a track (FR-2, BR-1, BR-3, BR-4)', () => {
  const call = (ctx: ReturnType<typeof setup>, version = 0) => ({
    actor: OWNER,
    mediaId: ctx.tracks[0] ?? '',
    expectedVersion: version,
  });

  it('saves concepts, free subjects and a summary, and refuses an older version', () => {
    const ctx = setup();
    const free = ctx.subjects.createFree(OWNER, 'hermetismo', 'Burracheira');
    const saved = ctx.subjects.save(call(ctx), {
      subjects: [
        { kind: 'concept', name: 'cabala' },
        { kind: 'free', id: free.id },
      ],
      summary: 'Uma resposta sobre a Cabala.',
    });
    expect(saved.version).toBe(1);
    expect(saved.summary).toBe('Uma resposta sobre a Cabala.');
    expect(saved.subjects).toEqual([
      { kind: 'concept', name: 'Cabala', id: null, missing: false },
      { kind: 'free', name: 'Burracheira', id: free.id, missing: false },
    ]);
    expect(() =>
      ctx.subjects.save(call(ctx), { subjects: [], summary: null }),
    ).toThrow(expect.objectContaining({ code: 'EDIT_STALE' }));
  });

  it('refuses a subject the collection does not have', () => {
    const ctx = setup();
    expect(() =>
      ctx.subjects.save(call(ctx), {
        subjects: [{ kind: 'concept', name: 'Inventado' }],
        summary: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() =>
      ctx.subjects.save(call(ctx), {
        subjects: [{ kind: 'free', id: randomUUID() }],
        summary: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('refuses a recording: subjects belong to tracks', () => {
    const ctx = setup();
    expect(() => ctx.subjects.read(OWNER, ctx.mediaId)).toThrow(
      expect.objectContaining({ code: 'MEDIA_CONFLICT' }),
    );
  });

  it('flags a concept gone from the catalog, keeps it through a save and unflags it on return (AC-5)', () => {
    const ctx = setup();
    ctx.subjects.save(call(ctx), {
      subjects: [{ kind: 'concept', name: 'Cabala' }],
      summary: null,
    });
    ctx.concepts.names = ['Ritmo'];
    const gone = ctx.subjects.read(OWNER, ctx.tracks[0] ?? '');
    expect(gone.subjects).toEqual([
      { kind: 'concept', name: 'Cabala', id: null, missing: true },
    ]);
    const kept = ctx.subjects.save(call(ctx, 1), {
      subjects: [
        { kind: 'concept', name: 'Cabala' },
        { kind: 'concept', name: 'Ritmo' },
      ],
      summary: null,
    });
    expect(kept.subjects.map((one) => one.missing)).toEqual([true, false]);
    ctx.concepts.names = CONCEPTS;
    expect(
      ctx.subjects.read(OWNER, ctx.tracks[0] ?? '').subjects[0]?.missing,
    ).toBe(false);
  });

  it('flags a free subject of another collection after the recording moved', () => {
    const ctx = setup();
    const free = ctx.subjects.createFree(OWNER, 'hermetismo', 'Burracheira');
    ctx.subjects.save(call(ctx), {
      subjects: [{ kind: 'free', id: free.id }],
      summary: null,
    });
    ctx.db.prepare(`UPDATE media SET topic = 'alquimia'`).run();
    expect(ctx.subjects.read(OWNER, ctx.tracks[0] ?? '').subjects[0]).toEqual({
      kind: 'free',
      name: 'Burracheira',
      id: free.id,
      missing: true,
    });
  });
});

describe('Suggesting subjects with the AI (FR-3, FR-4, BR-2, BR-3, BR-5)', () => {
  const allTracks = (count: number) =>
    replyFor(
      Array.from({ length: count }, (_, index) => ({
        faixa: index + 1,
        assuntos: ['Cabala', 'ritmo'],
        novos: ['Sete Raios'],
        resumo: `Resumo ${index + 1}.`,
      })),
    );

  it('gives each of 12 tracks 1 to 5 chips, known or marked new, in one model call (AC-1)', async () => {
    const ctx = setup({ tracks: 12, replies: [allTracks(12)] });
    const run = await ctx.suggest();
    expect(run?.status).toBe('done');
    expect(ctx.llm.calls).toHaveLength(1);
    const { tracks } = ctx.proposals.edit(OWNER, ctx.mediaId);
    expect(tracks).toHaveLength(12);
    for (const track of tracks) {
      expect(track.suggestions.map(({ kind, name }) => [kind, name])).toEqual([
        ['concept', 'Cabala'],
        ['concept', 'Ritmo'],
        ['new', 'Sete Raios'],
      ]);
      expect(track.subjects).toEqual([]);
      expect(track.summary).toBeNull();
    }
    expect(spend(ctx)).toEqual([
      expect.objectContaining({ kind: 'subject-proposal', status: 'settled' }),
    ]);
  });

  it('drops what is neither listed nor marked new, repeats and past five', async () => {
    const ctx = setup({
      tracks: 1,
      concepts: ['A', 'B', 'C', 'D', 'E', 'F'],
      replies: [
        replyFor([
          {
            faixa: 1,
            assuntos: ['Inventado', 'A', 'a', 'B', 'C', 'D', 'E', 'F'],
            novos: ['A', 'x'.repeat(200)],
          },
          { faixa: 9, assuntos: ['A'] },
        ]),
      ],
    });
    await ctx.suggest();
    const [track] = ctx.proposals.edit(OWNER, ctx.mediaId).tracks;
    expect(track?.suggestions.map((one) => one.name)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
  });

  it('counts nothing until accepted; a new subject exists only once accepted (AC-2, BR-2)', async () => {
    const ctx = setup({ tracks: 1, replies: [allTracks(1)] });
    await ctx.suggest();
    const mediaId = ctx.tracks[0] ?? '';
    const before = ctx.subjects.read(OWNER, mediaId);
    expect(ctx.trackStore.acceptedLinks('concept:cabala')).toEqual([]);
    expect(ctx.subjects.collection('hermetismo').free).toEqual([]);
    const [cabala, ritmo, novo] = before.suggestions;
    const after = ctx.subjects.decide(
      { actor: OWNER, mediaId, expectedVersion: before.version },
      {
        accept: [cabala?.id ?? '', novo?.id ?? ''],
        refuse: [ritmo?.id ?? ''],
        summary: 'accept',
      },
    );
    expect(after.subjects.map((one) => one.name)).toEqual([
      'Cabala',
      'Sete Raios',
    ]);
    expect(after.suggestions).toEqual([]);
    expect(after.summary).toBe('Resumo 1.');
    expect(after.suggestedSummary).toBeNull();
    expect(ctx.trackStore.acceptedLinks('concept:cabala')).toEqual([mediaId]);
    expect(
      ctx.subjects.collection('hermetismo').free.map((one) => one.name),
    ).toEqual(['Sete Raios']);
  });

  it('refuses a decision past the limit of five (BR-1)', async () => {
    const ctx = setup({
      tracks: 1,
      concepts: ['A', 'B', 'C', 'D', 'E', 'F'],
      replies: [replyFor([{ faixa: 1, assuntos: ['F'] }])],
    });
    await ctx.suggest();
    const mediaId = ctx.tracks[0] ?? '';
    const saved = ctx.subjects.save(
      { actor: OWNER, mediaId, expectedVersion: 0 },
      {
        subjects: ['A', 'B', 'C', 'D', 'E'].map((name) => ({
          kind: 'concept' as const,
          name,
        })),
        summary: null,
      },
    );
    expect(() =>
      ctx.subjects.decide(
        { actor: OWNER, mediaId, expectedVersion: saved.version },
        { accept: [saved.suggestions[0]?.id ?? ''], refuse: [], summary: null },
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('refuses a suggestion of another track', async () => {
    const ctx = setup({ tracks: 2, replies: [allTracks(2)] });
    await ctx.suggest();
    const [first, second] = ctx.proposals.edit(OWNER, ctx.mediaId).tracks;
    expect(() =>
      ctx.subjects.decide(
        { actor: OWNER, mediaId: first?.mediaId ?? '', expectedVersion: 0 },
        {
          accept: [second?.suggestions[0]?.id ?? ''],
          refuse: [],
          summary: null,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('never runs twice on one approval, and a new approval may run again', async () => {
    const ctx = setup({ tracks: 1, replies: [allTracks(1), allTracks(1)] });
    await ctx.suggest();
    expect(ctx.proposals.edit(OWNER, ctx.mediaId).canSuggest).toBe(false);
    await expect(ctx.proposals.start(OWNER, ctx.mediaId)).rejects.toMatchObject(
      {
        code: 'MEDIA_CONFLICT',
      },
    );
    expect(ctx.llm.calls).toHaveLength(1);
    ctx.db.prepare('UPDATE media_edits SET version = version + 2').run();
    expect(ctx.proposals.edit(OWNER, ctx.mediaId).canSuggest).toBe(true);
    await ctx.suggest();
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it('does not offer again what a person refused, and leaves what they accepted', async () => {
    const ctx = setup({ tracks: 1, replies: [allTracks(1), allTracks(1)] });
    await ctx.suggest();
    const mediaId = ctx.tracks[0] ?? '';
    const first = ctx.subjects.read(OWNER, mediaId);
    ctx.subjects.decide(
      { actor: OWNER, mediaId, expectedVersion: 0 },
      {
        accept: [first.suggestions[0]?.id ?? ''],
        refuse: [first.suggestions[1]?.id ?? ''],
        summary: null,
      },
    );
    ctx.db.prepare('UPDATE media_edits SET version = version + 2').run();
    await ctx.suggest();
    expect(
      ctx.subjects.read(OWNER, mediaId).suggestions.map((one) => one.name),
    ).toEqual(['Sete Raios']);
  });

  it('refuses before an edit is approved', async () => {
    const ctx = setup({ tracks: 1 });
    ctx.db.prepare(`UPDATE media_edits SET status = 'draft'`).run();
    await expect(
      ctx.proposals.estimate(OWNER, ctx.mediaId),
    ).rejects.toMatchObject({
      code: 'MEDIA_CONFLICT',
    });
  });

  it('says why the monthly cap stops it and does not call the model (AC-7)', async () => {
    const ctx = setup({ tracks: 1, monthlyUsd: 0 });
    const estimate = await ctx.proposals.estimate(OWNER, ctx.mediaId);
    expect(estimate).toMatchObject({ allowed: false, refusal: 'monthly-cap' });
    await expect(ctx.proposals.start(OWNER, ctx.mediaId)).rejects.toMatchObject(
      {
        code: 'MEDIA_SPEND_CAP',
      },
    );
    expect(ctx.llm.calls).toHaveLength(0);
    expect(spend(ctx)).toEqual([]);
  });

  it('shows the month only to a master', async () => {
    const ctx = setup({ tracks: 1 });
    expect(
      (await ctx.proposals.estimate(HELPER, ctx.mediaId)).month,
    ).toBeNull();
    expect(
      (await ctx.proposals.estimate(OWNER, ctx.mediaId)).month,
    ).not.toBeNull();
  });

  it('fails an unreadable answer without asking again, and gives the rest back', async () => {
    const ctx = setup({
      tracks: 1,
      replies: ['isto não é json', allTracks(1)],
    });
    const run = await ctx.suggest();
    expect(run).toMatchObject({ status: 'failed', failure: 'invalid-output' });
    expect(ctx.llm.calls).toHaveLength(1);
    expect(spend(ctx)).toEqual([
      expect.objectContaining({ status: 'refunded', spent_usd: 0.001 }),
    ]);
    expect(ctx.proposals.edit(OWNER, ctx.mediaId).canSuggest).toBe(true);
  });

  it('reads a fenced answer with reasoning and text around it (FR-3)', async () => {
    const body = replyFor([{ faixa: 1, assuntos: ['Cabala'] }]);
    const ctx = setup({
      tracks: 1,
      replies: [
        `<think>hmm {x}</think>Pronto:\n\`\`\`json\n${body}\n\`\`\`\nFim.`,
      ],
    });
    const run = await ctx.suggest();
    expect(run).toMatchObject({ status: 'done', failure: null });
    const [track] = ctx.proposals.edit(OWNER, ctx.mediaId).tracks;
    expect(track?.suggestions.map((one) => one.name)).toEqual(['Cabala']);
  });

  it.each([
    ['no tracks', replyFor([])],
    ['only tracks it cannot read', '{"faixas":[{"faixa":"um"},{"faixa":99}]}'],
    [
      'tracks with nothing usable',
      replyFor([{ faixa: 1, assuntos: ['Inventado'] }]),
    ],
  ])(
    'fails an answer with %s, so a person can try again (Q156)',
    async (_, reply) => {
      const ctx = setup({ tracks: 1, replies: [reply] });
      const run = await ctx.suggest();
      expect(run).toMatchObject({
        status: 'failed',
        failure: 'invalid-output',
      });
      expect(ctx.llm.calls).toHaveLength(1);
      expect(ctx.proposals.edit(OWNER, ctx.mediaId).canSuggest).toBe(true);
    },
  );

  it('ends as interrupted when the edit was reopened during the call, and can run after a new approval', async () => {
    const ctx = setup({ tracks: 1 });
    ctx.llm.replies.push(() => {
      ctx.db.prepare(`UPDATE media_edits SET status = 'draft'`).run();
      return replyFor([{ faixa: 1, assuntos: ['Cabala'] }]);
    });
    const run = await ctx.suggest();
    expect(run).toMatchObject({ status: 'failed', failure: 'interrupted' });
    ctx.db
      .prepare(`UPDATE media_edits SET status = 'approved', version = 5`)
      .run();
    expect(ctx.proposals.edit(OWNER, ctx.mediaId).canSuggest).toBe(true);
  });

  it('counts a stream that broke after it began', async () => {
    const ctx = setup({ tracks: 1, replies: [new BrokenStream('{"fai')] });
    const run = await ctx.suggest();
    expect(run).toMatchObject({ status: 'failed', failure: 'provider' });
    const [row] = spend(ctx);
    expect(Number(row?.['spent_usd'])).toBeGreaterThan(0);
  });

  it('refuses a second run while one goes on, and stopping ends it as interrupted', async () => {
    const ctx = setup({ tracks: 1, replies: [HANG] });
    const run = await ctx.proposals.start(OWNER, ctx.mediaId);
    await expect(ctx.proposals.start(OWNER, ctx.mediaId)).rejects.toMatchObject(
      {
        code: 'MEDIA_CONFLICT',
      },
    );
    await ctx.proposals.stop();
    expect(ctx.trackStore.run(run.id)).toMatchObject({
      status: 'failed',
      failure: 'interrupted',
    });
    expect(spend(ctx)).toEqual([
      expect.objectContaining({ status: 'refunded' }),
    ]);
  });

  it('closes on restart a run a crash left going', async () => {
    const ctx = setup({ tracks: 1 });
    ctx.trackStore.startRun({
      id: randomUUID(),
      mediaId: ctx.mediaId,
      editVersion: 3,
      principal: 'owner',
      model: 'm',
      spendId: randomUUID(),
      estimateUsd: 0.01,
      now: new Date(),
    });
    expect(ctx.proposals.recover()).toBe(1);
    expect(ctx.trackStore.latestRun(ctx.mediaId)).toMatchObject({
      status: 'failed',
      failure: 'interrupted',
    });
  });

  it('keeps each suggestion on its own track when another left during the call', async () => {
    const ctx = setup({ tracks: 2 });
    const [first, second] = ctx.tracks;
    ctx.llm.replies.push(() => {
      ctx.db.prepare('DELETE FROM media WHERE id = ?').run(first ?? '');
      return replyFor([
        { faixa: 1, assuntos: ['Cabala'] },
        { faixa: 2, assuntos: ['Ritmo'] },
      ]);
    });
    const run = await ctx.suggest();
    expect(run?.status).toBe('done');
    const { tracks } = ctx.proposals.edit(OWNER, ctx.mediaId);
    expect(tracks.map((one) => one.mediaId)).toEqual([second]);
    expect(tracks[0]?.suggestions.map((one) => one.name)).toEqual(['Ritmo']);
  });
});

describe('The spend of a suggestion (BR-5)', () => {
  it('estimates under the run cap and keeps the prompt within the speech budget on 200 tracks', async () => {
    const ctx = setup({ tracks: 200 });
    const estimate = await ctx.proposals.estimate(OWNER, ctx.mediaId);
    expect(estimate.estimateUsd).toBeGreaterThan(0);
    expect(estimate.windows).toBe(1);
  });

  it('refuses a run past the cap per run and spends nothing', async () => {
    const ctx = setup({ tracks: 1, runUsd: 0 });
    const estimate = await ctx.proposals.estimate(OWNER, ctx.mediaId);
    expect(estimate).toMatchObject({ allowed: false, refusal: 'run-cap' });
    await expect(ctx.proposals.start(OWNER, ctx.mediaId)).rejects.toMatchObject(
      { code: 'MEDIA_SPEND_CAP' },
    );
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('refuses without the app AI connected', async () => {
    const ctx = setup({ tracks: 1, noLlm: true });
    await expect(
      ctx.proposals.estimate(OWNER, ctx.mediaId),
    ).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
  });
});
