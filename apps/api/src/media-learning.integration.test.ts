/**
 * Learning from word corrections (KBC-113, ADR 0037): rules with context applied to new
 * versions, the learning's rows undone by anyone who corrects, learned terms in the list,
 * masters' switches. Through the real routes, the real media database and the fake Mac.
 */
import type {
  CorrectionHistory,
  GroqTranscribeJob,
  TermList,
  TranscriptCorrectionResult,
  TranscriptLearning,
  TranscriptionTerms,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import {
  correctionsUrl,
  dbExec,
  dbRows,
  historyOf,
  textOf,
  wordOf,
  wordsOf,
} from '../test/correction-harness.js';
import { member, worker } from '../test/media-harness.js';
import {
  asTranscriber,
  leaseTranscription,
  readyForTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';
import {
  rawOf,
  say,
  startWorld,
  transcribed,
  type Spoken,
  type World,
} from '../test/track-items-harness.js';

afterEach(closeApp);

const LEARNING = '/api/v1/media/learning';
const CORRECTOR = ['media', 'media-tracks', 'search', 'media-correct'];

/** "a Manta" (two words) corrected to "Atlântida", as "Incluir a próxima" sends it. */
async function fixManta(call: Call, id: string): Promise<string> {
  const first = await wordOf(call, id, 'a');
  const saved = await call('POST', correctionsUrl(id), {
    version: 1,
    position: first.position,
    count: 2,
    expected: ['a', 'Manta'],
    text: 'Atlântida',
  });
  expect(saved.statusCode, saved.body).toBe(201);
  return saved.json<TranscriptCorrectionResult>().correction?.id ?? '';
}

async function learningOf(call: Call): Promise<TranscriptLearning> {
  const read = await call('GET', LEARNING);
  expect(read.statusCode, read.body).toBe(200);
  return read.json<TranscriptLearning>();
}

async function transcribeAgain(world: World, id: string, speech: Spoken[]) {
  const asked = await world.media.owner(
    'POST',
    `/api/v1/media/${id}/transcription`,
    {},
  );
  expect(asked.statusCode, asked.body).toBeLessThan(300);
  await say(world, speech);
}

const learnedEntries = (history: CorrectionHistory) =>
  history.entries.filter((entry) => entry.items.some((item) => item.learned));

/** The masters' list grown to exactly `tokens` of the prompt (AC-11: "180 de 224"). */
async function listAt(call: Call, tokens: number): Promise<TermList> {
  const start = (await call('GET', '/api/v1/media/terms')).json<TermList>();
  const terms = [...start.terms];
  const measure = async (list: readonly string[]) =>
    (await call('POST', '/api/v1/media/terms/measure', { terms: list })).json<{
      tokens: number;
    }>().tokens;
  // Short words cost 2 or 3 tokens each: enough to land on any target.
  const fillers = [
    'sol',
    'mar',
    'luz',
    'paz',
    'rio',
    'mel',
    'lua',
    'dia',
    'voz',
  ]
    .flatMap((word) => [word, `${word}es`, `${word}inho`])
    .filter((word) => !terms.includes(word));
  for (const filler of fillers) {
    const now = await measure(terms);
    if (now >= tokens) break;
    if ((await measure([...terms, filler])) <= tokens) terms.push(filler);
  }
  const saved = await call('PUT', '/api/v1/media/terms', {
    baseVersion: start.version,
    terms,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return saved.json<TermList>();
}

const workerTerms = async (world: World) =>
  (
    await asTranscriber(world.media, world.token, {
      method: 'GET',
      url: '/api/v1/media-worker/terms',
    })
  ).json<TranscriptionTerms>();

describe('Learning from corrections (KBC-113)', () => {
  it('AC-1, AC-2, AC-3, AC-17: a correction becomes a rule with its context, applied only to new versions, marked and grouped', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const older = await transcribed(world, [
      { at: 10, text: 'veio com a Manta foi' },
    ]);
    const source = await transcribed(world, [
      { at: 10, text: 'disse com a Manta foi assim' },
    ]);

    await fixManta(owner, source.id);

    const learned = await learningOf(owner);
    expect(learned.rules).toEqual([
      expect.objectContaining({
        before: 'a Manta',
        after: 'Atlântida',
        contextBefore: 'com',
        contextAfter: 'foi',
        corrections: 1,
        recordings: 1,
        state: 'on',
        examples: [
          expect.objectContaining({
            mediaId: source.id,
            before: 'a Manta',
            after: 'Atlântida',
            startMs: 10_800,
          }),
        ],
      }),
    ]);
    // AC-3: what was transcribed before stays as it was.
    expect(await textOf(owner, older.id)).toEqual(['veio com a Manta foi']);

    const fresh = await transcribed(world, [
      { at: 10, text: 'e com a Manta veio' },
      { at: 30, text: 'na a Manta disse' },
    ]);

    expect(await textOf(owner, fresh.id)).toEqual([
      'e com Atlântida veio',
      'na a Manta disse',
    ]);
    const words = await wordsOf(owner, fresh.id);
    expect(words.revision).toBe(1);
    expect(words.learned).toEqual([
      expect.objectContaining({ position: 2, count: 2, before: 'a Manta' }),
    ]);
    const [entry] = learnedEntries(await historyOf(owner, fresh.id));
    expect(entry?.items).toEqual([
      expect.objectContaining({
        learned: true,
        before: ['a', 'Manta'],
        after: 'Atlântida',
        authorName: 'Aprendizado das correções',
        canUndo: true,
      }),
    ]);

    await transcribeAgain(world, older.id, [
      { at: 10, text: 'veio com a Manta foi' },
    ]);
    expect(await textOf(owner, older.id)).toEqual(['veio com Atlântida foi']);
  });

  it('AC-8, AC-9: a member who corrects undoes a learned word; the rule then stops until a master turns it on', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const source = await transcribed(world, [
      { at: 10, text: 'disse com a Manta foi' },
    ]);
    await fixManta(owner, source.id);
    const fresh = await transcribed(world, [{ at: 10, text: 'com a Manta' }]);
    const maria = await member(world.media, {
      email: 'maria@example.com',
      topics: ['hermetismo'],
      features: CORRECTOR,
    });
    const [entry] = learnedEntries(await historyOf(maria.call, fresh.id));
    const row = entry?.items[0];
    expect(row?.canUndo).toBe(true);

    const undone = await maria.call(
      'POST',
      `${correctionsUrl(fresh.id)}/${row?.id ?? ''}/undo`,
    );

    expect(undone.statusCode, undone.body).toBe(201);
    expect(await textOf(owner, fresh.id)).toEqual(['com a Manta']);
    const [rule] = (await learningOf(owner)).rules;
    expect(rule).toMatchObject({ state: 'auto-off', applied: 1, undone: 1 });
    const next = await transcribed(world, [{ at: 10, text: 'com a Manta' }]);
    expect(await textOf(owner, next.id)).toEqual(['com a Manta']);

    const on = await owner('PUT', `${LEARNING}/rules/${rule?.id ?? ''}`, {
      enabled: true,
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<TranscriptLearning>().rules[0]).toMatchObject({
      state: 'on',
      switchedBy: expect.any(String),
    });
    const after = await transcribed(world, [{ at: 10, text: 'com a Manta' }]);
    expect(await textOf(owner, after.id)).toEqual(['com Atlântida']);
  });

  it('review round 1: correcting over a learned word counts against its rule, teaches from what the transcriber said, and leaves no Desfazer on the learned row', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const source = await transcribed(world, [
      { at: 10, text: 'disse com a Manta foi' },
    ]);
    await fixManta(owner, source.id);
    const fresh = await transcribed(world, [
      { at: 10, text: 'e com a Manta foi' },
    ]);
    const maria = await member(world.media, {
      email: 'maria@example.com',
      topics: ['hermetismo'],
      features: CORRECTOR,
    });

    const over = await maria.call('POST', correctionsUrl(fresh.id), {
      version: 1,
      position: (await wordOf(owner, fresh.id, 'Atlântida')).position,
      count: 1,
      expected: ['Atlântida'],
      text: 'Amanta',
    });

    expect(over.statusCode, over.body).toBe(201);
    const { rules } = await learningOf(owner);
    expect(rules.find((rule) => rule.after === 'Atlântida')).toMatchObject({
      state: 'auto-off',
      applied: 1,
      undone: 1,
    });
    expect(rules.map((rule) => rule.before)).not.toContain('Atlântida');
    expect(rules.find((rule) => rule.after === 'Amanta')).toMatchObject({
      before: 'a Manta',
      state: 'on',
    });
    const [entry] = learnedEntries(await historyOf(owner, fresh.id));
    expect(entry?.items[0]).toMatchObject({ learned: true, canUndo: false });
    expect(entry?.canUndoGroup).toBe(false);
  });

  it('AC-10: undoing the person correction takes the rule and the term away', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const source = await transcribed(world, [
      { at: 10, text: 'disse com a Manta foi' },
    ]);
    const id = await fixManta(owner, source.id);
    expect((await learningOf(owner)).terms.map((term) => term.term)).toEqual([
      'Atlântida',
    ]);
    const other = await transcribed(world, [{ at: 10, text: 'com a Manta' }]);
    expect(await textOf(owner, other.id)).toEqual(['com Atlântida']);

    const undone = await owner(
      'POST',
      `${correctionsUrl(source.id)}/${id}/undo`,
    );

    expect(undone.statusCode, undone.body).toBe(201);
    expect(await learningOf(owner)).toMatchObject({ rules: [], terms: [] });
    const next = await transcribed(world, [{ at: 10, text: 'com a Manta' }]);
    expect(await textOf(owner, next.id)).toEqual(['com a Manta']);
    // BR-6: the replacement already made in another recording stays, and can be undone.
    expect(await textOf(owner, other.id)).toEqual(['com Atlântida']);
    const [entry] = learnedEntries(await historyOf(owner, other.id));
    expect(entry?.items[0]?.canUndo).toBe(true);
    const back = await owner(
      'POST',
      `${correctionsUrl(other.id)}/${entry?.items[0]?.id ?? ''}/undo`,
    );
    expect(back.statusCode, back.body).toBe(201);
    expect(await textOf(owner, other.id)).toEqual(['com a Manta']);
  });

  it('AC-7: deletions and punctuation do not teach', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const source = await transcribed(world, [
      { at: 10, text: 'obrigado o Mariri falou' },
    ]);
    for (const [from, to] of [
      ['obrigado', ''],
      ['Mariri', 'Mariri,'],
    ] as const) {
      const word = await wordOf(owner, source.id, from);
      const saved = await owner('POST', correctionsUrl(source.id), {
        version: 1,
        position: word.position,
        count: 1,
        expected: [from],
        text: to,
      });
      expect(saved.statusCode, saved.body).toBe(201);
    }

    expect(await learningOf(owner)).toMatchObject({ rules: [], terms: [] });
  });

  it('AC-11, AC-13, AC-14: a learned name joins the transcriber list in a version by the learning; the masters list stays theirs', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const source = await transcribed(world, [
      { at: 10, text: 'o mestre Tiuako disse concerteza de Atlantida' },
    ]);
    const manual = await listAt(owner, 180);
    expect(manual.tokens).toBe(180);
    for (const [from, to] of [
      ['Tiuako', 'Tiuaco'],
      ['concerteza', 'com certeza'],
      ['Atlantida', 'Atlântida'],
    ] as const) {
      const word = await wordOf(owner, source.id, from);
      const saved = await owner('POST', correctionsUrl(source.id), {
        version: 1,
        position: word.position,
        count: 1,
        expected: [from],
        text: to,
      });
      expect(saved.statusCode, saved.body).toBe(201);
    }
    // AC-13: "Tiuaco" is in the masters' list; "com certeza" is lower case, corrected once.
    expect((await learningOf(owner)).terms.map((term) => term.term)).toEqual([
      'Atlântida',
    ]);

    const sent = await workerTerms(world);

    expect(sent.version).toBe(manual.version + 1);
    expect(sent.terms).toEqual([...manual.terms, 'Atlântida']);
    expect((await workerTerms(world)).version).toBe(sent.version);
    const list = (await owner('GET', '/api/v1/media/terms')).json<TermList>();
    expect(list.terms).toEqual(manual.terms);
    expect(list.versions[0]).toMatchObject({
      version: sent.version,
      authorName: 'Aprendizado das correções',
    });

    // AC-14: the master saves on the version opened before the learning's: no conflict.
    const saved = await owner('PUT', '/api/v1/media/terms', {
      baseVersion: manual.version,
      terms: [...manual.terms, 'Novo Termo'],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<TermList>().terms).toEqual([
      ...manual.terms,
      'Novo Termo',
    ]);
    expect((await workerTerms(world)).terms).toEqual([
      ...manual.terms,
      'Novo Termo',
      'Atlântida',
    ]);
    const stale = await owner('PUT', '/api/v1/media/terms', {
      baseVersion: manual.version,
      terms: [...manual.terms, 'Outro'],
    });
    expect(stale.statusCode).toBe(409);
  });

  it('AC-15, AC-16: masters switch a term and a rule; members get 403', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const source = await transcribed(world, [
      { at: 10, text: 'disse com a Manta foi' },
    ]);
    await fixManta(owner, source.id);
    const { rules, terms } = await learningOf(owner);

    const off = await owner('PUT', `${LEARNING}/terms/${terms[0]?.id ?? ''}`, {
      enabled: false,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<TranscriptLearning>().terms[0]?.state).toBe('off');
    expect((await workerTerms(world)).terms).not.toContain('Atlântida');
    const ruleOff = await owner(
      'PUT',
      `${LEARNING}/rules/${rules[0]?.id ?? ''}`,
      { enabled: false },
    );
    expect(ruleOff.json<TranscriptLearning>().rules[0]?.state).toBe('off');
    const next = await transcribed(world, [{ at: 10, text: 'com a Manta' }]);
    expect(await textOf(owner, next.id)).toEqual(['com a Manta']);
    expect(await textOf(owner, source.id)).toEqual(['disse com Atlântida foi']);
    expect(
      (
        await owner('PUT', `${LEARNING}/rules/${'0'.repeat(32)}`, {
          enabled: false,
        })
      ).statusCode,
    ).toBe(404);

    const maria = await member(world.media, {
      email: 'maria@example.com',
      topics: ['hermetismo'],
      features: CORRECTOR,
    });
    expect((await maria.call('GET', LEARNING)).statusCode).toBe(403);
    expect(
      (
        await maria.call('PUT', `${LEARNING}/rules/${rules[0]?.id ?? ''}`, {
          enabled: true,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await maria.call('PUT', `${LEARNING}/terms/${terms[0]?.id ?? ''}`, {
          enabled: true,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('ADR 0037, FR-1, FR-4: on the Groq path the job is prompted with the learned terms and the new version gets the rules', async () => {
    const world = await startWorld();
    const { media } = world;
    const source = await transcribed(world, [
      { at: 10, text: 'disse com a Manta foi' },
    ]);
    await fixManta(media.owner, source.id);
    const item = await readyForTranscription(media);
    const tested = await media.owner('POST', '/api/v1/media/groq/test', {
      key: 'gsk_live_secret_key_123_valid',
    });
    expect(tested.json()).toMatchObject({ ok: true });
    await media.owner('PUT', '/api/v1/media/groq/mode', {
      mode: 'manual',
      idleHours: 12,
    });
    const routed = await media.owner(
      'POST',
      `/api/v1/media/${item.id}/transcription/groq`,
    );
    expect(routed.statusCode, routed.body).toBe(200);

    const leased = await worker(media, '/api/v1/media-worker/jobs/lease', {
      worker: 'vm',
      kinds: ['transcribe'],
    });
    expect(leased.statusCode, leased.body).toBe(200);
    const job = leased.json<GroqTranscribeJob>();

    const list = (
      await media.owner('GET', '/api/v1/media/terms')
    ).json<TermList>();
    expect(list.versions[0]).toMatchObject({
      version: job.termsVersion,
      authorName: 'Aprendizado das correções',
    });
    expect((await workerTerms(world)).terms).toContain('Atlântida');
    const done = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/groq/transcript`,
      {
        worker: 'vm',
        leaseId: job.leaseId,
        termsVersion: job.termsVersion,
        vad: 'applied',
        speechRatio: 0.9,
        elapsedMs: 1_200,
        // One 20 s chunk: the audio Groq got is 3 minutes long.
        raw: {
          chunks: rawOf([{ at: 1, text: 'e com a Manta foi' }]).chunks.map(
            (chunk) => ({ ...chunk, end: 20 }),
          ),
        },
      },
    );
    expect(done.statusCode, done.body).toBe(204);
    expect(await textOf(media.owner, item.id)).toEqual(['e com Atlântida foi']);
    const [entry] = learnedEntries(await historyOf(media.owner, item.id));
    expect(entry?.items[0]).toMatchObject({
      learned: true,
      after: 'Atlântida',
    });
  });

  it('AC-18, NFR-3: a failure writing a learned replacement keeps the new version out, nothing changed', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const source = await transcribed(world, [
      { at: 10, text: 'disse com a Manta foi' },
    ]);
    await fixManta(owner, source.id);
    const asked = await owner(
      'POST',
      `/api/v1/media/${source.id}/transcription`,
      {},
    );
    expect(asked.statusCode).toBeLessThan(300);
    dbExec(
      world.media,
      `CREATE TRIGGER fail_learning BEFORE INSERT ON transcript_corrections
       WHEN NEW.rule_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    const versions = () =>
      dbRows(
        world.media,
        'SELECT version FROM transcripts WHERE media_id = ? ORDER BY version',
        source.id,
      );

    const job = await leaseTranscription(world.media, world.token);
    const sent = await sendTranscript(world.media, {
      token: world.token,
      job,
      raw: rawOf([{ at: 50, text: 'veio com a Manta' }]),
    });

    expect(sent.statusCode).toBe(500);
    expect(versions()).toEqual([{ version: 1 }]);
    expect(
      dbRows(
        world.media,
        'SELECT count(*) AS n FROM transcript_corrections WHERE rule_id IS NOT NULL',
      ),
    ).toEqual([{ n: 0 }]);
  });
});
