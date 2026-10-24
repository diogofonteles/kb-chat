// Research agent evaluation (KBC-008 AC-8, NFR-1..3; KBC-011 NFR-1..3) against the real vault
// and the provider the API would use now (Settings, then the environment, ADR 0007); a
// per-token provider spends real money within the daily cap. The kb tools are served to a
// subscription CLI by an MCP endpoint of the eval's own. Usage:
//   pnpm --filter @kb-chat/api agent-eval <questions.json> <report.md> [topic] [--profile fast|deep]
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  researchProfileSchema,
  type ResearchProfile,
  type ResearchTurn,
} from '@kb-chat/contracts';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import { openEvalSession, runEvalTurn, type EvalTurn } from './eval-session.js';

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

interface Outcome extends EvalTurn {
  readonly question: Question;
  readonly cited: readonly string[];
  readonly hit: boolean | null;
  /** The mustMention words missing from the answer; null when none were asked. */
  readonly missing: readonly string[] | null;
}

const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function parseArgs(argv: readonly string[]) {
  const flag = argv.indexOf('--profile');
  const profile = researchProfileSchema.parse(
    flag >= 0 ? argv[flag + 1] : 'fast',
  );
  const positional = argv.filter(
    (_, i) => flag < 0 || (i !== flag && i !== flag + 1),
  );
  const [questionsPath, reportPath, topic] = positional;
  return { questionsPath, reportPath, topic, profile };
}

const args = parseArgs(process.argv.slice(2));
if (!args.questionsPath || !args.reportPath) {
  process.stderr.write(
    'Uso: pnpm --filter @kb-chat/api agent-eval <perguntas.json> <relatorio.md> [tópico] [--profile fast|deep]\n',
  );
  process.exit(2);
}

const citedSources = (turn: EvalTurn): string[] =>
  [
    ...new Set(
      [...turn.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
    ),
  ].map((n) => `[${n}] ${turn.sources.get(n) ?? '(número sem fonte)'}`);

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

async function ask(
  runner: ResearchRunnerPort,
  question: Question,
  context: {
    topic: string;
    history: readonly ResearchTurn[];
    profile: ResearchProfile;
  },
): Promise<Outcome> {
  const turn = await runEvalTurn(runner, {
    ...context,
    question: question.question,
  });
  const cited = citedSources(turn);
  return {
    ...turn,
    question,
    cited,
    hit: isHit(question, cited),
    missing: missingWords(question, turn.answer),
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
    `- Primeiro passo: ${seconds(outcome.firstStepMs)} · primeiro texto: ${seconds(outcome.firstTokenMs)} · total: ${seconds(outcome.totalMs)} · custo: US$ ${outcome.usd.toFixed(4)} · textos recolhidos: ${outcome.retracts} · aprofundou: ${outcome.escalated ? `sim (${outcome.model ?? '?'})` : 'não'}${outcome.error ? ` · erro: ${outcome.error}` : ''}`,
    `- Passos (${outcome.steps.length}): ${outcome.steps.map((step, i) => `${step} (${seconds(outcome.stepMs[i] ?? null)})`).join(' → ') || '—'}`,
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

const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

interface RunInfo {
  readonly model: string;
  readonly provider: string;
  readonly profile: ResearchProfile;
}

function commitOf(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '?';
  }
}

function summary(outcomes: readonly Outcome[], run: RunInfo): string {
  const judged = outcomes.filter((o) => o.hit !== null);
  const hits = judged.filter((o) => o.hit).length;
  const usd = outcomes.reduce((sum, o) => sum + o.usd, 0);
  const totals = outcomes.map((o) => o.totalMs);
  const firstTexts = outcomes.map((o) => o.firstTokenMs ?? o.totalMs);
  const mentionJudged = outcomes.filter((o) => o.missing !== null);
  const mentionOk = mentionJudged.filter((o) => o.missing?.length === 0);
  return [
    '# Avaliação do agente de pesquisa (KBC-008, KBC-011)',
    '',
    `- Data: ${new Date().toISOString()} · commit: ${commitOf()} · provedor: ${run.provider} · modelo: ${run.model} · perfil: ${run.profile} · perguntas: ${outcomes.length}`,
    `- Citam o documento esperado: ${hits}/${judged.length} (meta: ≥ 8/10)`,
    `- Primeiro texto mediano: ${seconds(medianOf(firstTexts))} (meta do perfil rápido: ≤ 10 s, KBC-011 NFR-1)`,
    `- Tempo total mediano: ${seconds(medianOf(totals))} · maior: ${seconds(Math.max(0, ...totals))} (meta do perfil rápido: ≤ 20 s, KBC-011 NFR-2)`,
    `- Custo total: US$ ${usd.toFixed(4)} · médio: US$ ${(usd / Math.max(1, outcomes.length)).toFixed(4)}`,
    `- Respostas que nomeiam os termos exigidos: ${mentionOk.length}/${mentionJudged.length}`,
    `- Textos recolhidos (mostrados e retirados): ${outcomes.reduce((sum, o) => sum + o.retracts, 0)} · erros: ${outcomes.filter((o) => o.error).length}`,
    `- Aprofundadas automaticamente (Rápido → Profundo): ${outcomes.filter((o) => o.escalated).length}/${outcomes.length}`,
    '',
  ].join('\n');
}

const questions = questionsSchema.parse(
  JSON.parse(await readFile(args.questionsPath, 'utf8')),
);
const config = loadConfig();
const topic = args.topic ?? config.KB_TOPIC ?? 'hermetismo';
const { profile } = args;
const session = await openEvalSession({ config, env: process.env, profile });
const outcomes: Outcome[] = [];
// A follow-up continues the conversation of the questions before it; any other question starts a new one.
let conversation: ResearchTurn[] = [];
for (const question of questions) {
  process.stdout.write(`… ${question.question}\n`);
  const history = question.followUp ? conversation : [];
  const outcome = await ask(session.runner, question, {
    topic,
    history,
    profile,
  });
  outcomes.push(outcome);
  conversation = [
    ...history,
    { question: question.question, answer: outcome.answer },
  ].slice(-20);
}
await session.close();
const run = {
  model: session.runner.model,
  provider: session.provider,
  profile,
};
const report = [summary(outcomes, run), ...outcomes.map(outcomeSection)].join(
  '\n',
);
await mkdir(dirname(args.reportPath), { recursive: true });
await writeFile(args.reportPath, report);
process.stdout.write(`Relatório: ${args.reportPath}\n`);
