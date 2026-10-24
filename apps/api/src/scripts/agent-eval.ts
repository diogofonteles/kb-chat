// Research agent evaluation (KBC-008 AC-8, NFR-1..3) against the real vault and the
// provider the API would use now (Settings, then the environment, ADR 0007); a per-token
// provider spends real money within the daily cap. Usage:
//   pnpm --filter @kb-chat/api agent-eval <questions.json> <report.md> [topic]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResearchEvent, ResearchTurn } from '@kb-chat/contracts';
import { z } from 'zod';
import { FsVaultAdapter } from '../adapters/fs-vault-adapter.js';
import { JsonSettingsStore } from '../adapters/json-settings-store.js';
import { JsonlSpendLedger } from '../adapters/jsonl-spend-ledger.js';
import { OWNER } from '../app.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { CatalogRegistry } from '../modules/catalog/index.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import { createAiProviders } from '../providers/create-ai-providers.js';
import { createResearchAgent } from '../research-agent-factory.js';
import { createSearchIndex } from '../search-index-factory.js';

const questionsSchema = z.array(
  z.object({
    question: z.string().min(1),
    /** Sends the previous question and answer as history (a follow-up). */
    followUp: z.boolean().default(false),
    /** Fragments of the id or title of a document that holds the answer. */
    expected: z.array(z.string().min(1)).default([]),
    /** Words the answer text itself must name (accent- and case-insensitive). */
    mustMention: z.array(z.string().min(1)).default([]),
  }),
);
type Question = z.infer<typeof questionsSchema>[number];

interface Outcome {
  readonly question: Question;
  readonly answer: string;
  readonly steps: readonly string[];
  readonly cited: readonly string[];
  readonly hit: boolean | null;
  /** The mustMention words missing from the answer; null when none were asked. */
  readonly missing: readonly string[] | null;
  readonly firstStepMs: number | null;
  readonly firstTokenMs: number | null;
  readonly totalMs: number;
  readonly usd: number;
  readonly error: string | null;
}

const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const [questionsPath, reportPath, topicArg] = process.argv.slice(2);
if (!questionsPath || !reportPath) {
  process.stderr.write(
    'Uso: pnpm --filter @kb-chat/api agent-eval <perguntas.json> <relatorio.md> [tópico]\n',
  );
  process.exit(2);
}

async function composeRunner() {
  const config = loadConfig();
  const log = createLogger('warn');
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({ config, vault, log });
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const ledger = new JsonlSpendLedger(
    join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
  );
  const agent = createResearchAgent({ catalog, index, vault, ledger });
  const ai = await createAiProviders({
    config,
    principal: OWNER,
    store: new JsonSettingsStore(join(config.KB_CHAT_STATE_DIR, 'settings')),
    env: process.env,
    tools: agent.toolsFor,
    perTokenRunner: agent.perTokenRunner,
    systemPrompt: agent.systemPrompt,
  });
  const runner = ai.registry.researchRunner(OWNER);
  // Subscription runners reach the kb tools through the API's MCP routes, which this
  // script does not serve yet (KBC-011): refuse instead of measuring an agent without tools.
  if (runner.billing === 'subscription')
    throw new Error(
      'agent-eval needs a per-token provider for now: set KB_CHAT_LLM or a provider key and choose it in Settings.',
    );
  return { runner, index, topic: topicArg ?? config.KB_TOPIC ?? 'hermetismo' };
}

interface Collected {
  answer: string;
  steps: string[];
  sources: Map<number, string>;
  usd: number;
  error: string | null;
  firstStepMs: number | null;
  firstTokenMs: number | null;
}

function collect(
  state: Collected,
  event: ResearchEvent,
  startedAt: number,
): void {
  if (event.type === 'token') {
    state.answer += event.text;
    state.firstTokenMs ??= Math.round(performance.now() - startedAt);
  }
  if (event.type === 'step') {
    state.steps.push(event.step.text);
    state.firstStepMs ??= Math.round(performance.now() - startedAt);
  }
  if (event.type === 'sources')
    for (const s of event.sources)
      state.sources.set(s.n, `${s.title} (${s.id})`);
  if (event.type === 'done') state.usd = event.usd;
  if (event.type === 'error') state.error = event.code;
}

const citedSources = (state: Collected): string[] =>
  [
    ...new Set(
      [...state.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
    ),
  ].map((n) => `[${n}] ${state.sources.get(n) ?? '(número sem fonte)'}`);

const isHit = (question: Question, cited: readonly string[]): boolean | null =>
  question.expected.length === 0
    ? null
    : cited.some((source) =>
        question.expected.some((fragment) =>
          fold(source).includes(fold(fragment)),
        ),
      );

const missingWords = (question: Question, answer: string): string[] | null =>
  question.mustMention.length === 0
    ? null
    : question.mustMention.filter((word) => !fold(answer).includes(fold(word)));

async function runTurn(
  runner: ResearchRunnerPort,
  question: Question,
  context: { topic: string; history: readonly ResearchTurn[] },
): Promise<Collected> {
  const state: Collected = {
    answer: '',
    steps: [],
    sources: new Map(),
    usd: 0,
    error: null,
    firstStepMs: null,
    firstTokenMs: null,
  };
  const startedAt = performance.now();
  const input = {
    topic: context.topic,
    question: question.question,
    history: context.history,
    signal: new AbortController().signal,
  };
  for await (const event of runner.run(input)) collect(state, event, startedAt);
  return state;
}

async function ask(
  runner: ResearchRunnerPort,
  question: Question,
  context: { topic: string; history: readonly ResearchTurn[] },
): Promise<Outcome> {
  const startedAt = performance.now();
  const state = await runTurn(runner, question, context);
  const cited = citedSources(state);
  return {
    question,
    answer: state.answer,
    steps: state.steps,
    cited,
    hit: isHit(question, cited),
    missing: missingWords(question, state.answer),
    firstStepMs: state.firstStepMs,
    firstTokenMs: state.firstTokenMs,
    totalMs: Math.round(performance.now() - startedAt),
    usd: state.usd,
    error: state.error,
  };
}

const yesNo = (hit: boolean | null): string =>
  hit === null ? '—' : hit ? 'sim' : 'não';
const seconds = (ms: number | null): string =>
  ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`;

function mentionLine(outcome: Outcome): string[] {
  if (outcome.missing === null) return [];
  const words = outcome.question.mustMention
    .map((word) => `${word} ${outcome.missing?.includes(word) ? '✗' : '✓'}`)
    .join(', ');
  return [
    `- A resposta nomeia: ${outcome.missing.length === 0 ? 'sim' : 'não'} (${words})`,
  ];
}

function outcomeSection(outcome: Outcome, index: number): string {
  return [
    `## ${index + 1}. ${outcome.question.question}${outcome.question.followUp ? ' (seguimento)' : ''}`,
    '',
    `- Cita o documento esperado: ${yesNo(outcome.hit)} (esperado: ${outcome.question.expected.join(', ') || '—'})`,
    ...mentionLine(outcome),
    `- Primeiro passo: ${seconds(outcome.firstStepMs)} · primeiro texto: ${seconds(outcome.firstTokenMs)} · total: ${seconds(outcome.totalMs)} · custo: US$ ${outcome.usd.toFixed(4)}${outcome.error ? ` · erro: ${outcome.error}` : ''}`,
    `- Passos (${outcome.steps.length}): ${outcome.steps.join(' → ') || '—'}`,
    '',
    '### Resposta',
    '',
    outcome.answer.trim() || '_(sem texto)_',
    '',
    '### Fontes citadas',
    '',
    ...(outcome.cited.length > 0
      ? outcome.cited.map((s) => `- ${s}`)
      : ['- nenhuma']),
    '',
  ].join('\n');
}

function summary(outcomes: readonly Outcome[], model: string): string {
  const judged = outcomes.filter((o) => o.hit !== null);
  const hits = judged.filter((o) => o.hit).length;
  const usd = outcomes.reduce((sum, o) => sum + o.usd, 0);
  const totals = outcomes.map((o) => o.totalMs).sort((a, b) => a - b);
  const median = totals[Math.floor(totals.length / 2)] ?? 0;
  const mentionJudged = outcomes.filter((o) => o.missing !== null);
  const mentionOk = mentionJudged.filter((o) => o.missing?.length === 0);
  return [
    '# Avaliação do agente de pesquisa (KBC-008)',
    '',
    `- Data: ${new Date().toISOString()} · modelo: ${model} · perguntas: ${outcomes.length}`,
    `- Citam o documento esperado: ${hits}/${judged.length} (meta: ≥ 8/10, NFR-3)`,
    `- Custo total: US$ ${usd.toFixed(4)} · médio: US$ ${(usd / Math.max(1, outcomes.length)).toFixed(4)} (meta: ≤ US$ 0,02, NFR-2)`,
    `- Tempo total mediano: ${seconds(median)} · maior: ${seconds(totals.at(-1) ?? 0)} (meta: ≤ 60 s, NFR-1)`,
    `- Respostas que nomeiam os termos exigidos: ${mentionOk.length}/${mentionJudged.length}`,
    `- Erros: ${outcomes.filter((o) => o.error).length}`,
    '',
  ].join('\n');
}

const questions = questionsSchema.parse(
  JSON.parse(await readFile(questionsPath, 'utf8')),
);
const { runner, index, topic } = await composeRunner();
const outcomes: Outcome[] = [];
// A follow-up continues the conversation of the questions before it; any other question starts a new one.
let conversation: ResearchTurn[] = [];
for (const question of questions) {
  process.stdout.write(`… ${question.question}\n`);
  const history = question.followUp ? conversation : [];
  const outcome = await ask(runner, question, { topic, history });
  outcomes.push(outcome);
  conversation = [
    ...history,
    { question: question.question, answer: outcome.answer },
  ].slice(-20);
}
await index.close();
const report = [
  summary(outcomes, runner.model),
  ...outcomes.map(outcomeSection),
].join('\n');
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, report);
process.stdout.write(`Relatório: ${reportPath}\n`);
