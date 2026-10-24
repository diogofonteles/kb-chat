import { join } from 'node:path';
import type {
  ResearchEvent,
  ResearchProfile,
  ResearchTurn,
} from '@kb-chat/contracts';
import { FsVaultAdapter } from '../adapters/fs-vault-adapter.js';
import { JsonSettingsStore } from '../adapters/json-settings-store.js';
import { JsonlSpendLedger } from '../adapters/jsonl-spend-ledger.js';
import { OWNER } from '../app.js';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { startMcpTurnServer } from '../mcp/mcp-turn-server.js';
import { McpTurnRegistry } from '../mcp/mcp-turns.js';
import { CatalogRegistry } from '../modules/catalog/index.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import { createAiProviders } from '../providers/create-ai-providers.js';
import { createResearchAgent } from '../research-agent-factory.js';
import { createSearchIndex } from '../search-index-factory.js';

/** The runner the API would use now for the profile, with the kb tools really served. */
export interface EvalSession {
  readonly runner: ResearchRunnerPort;
  /** Which provider answers (Settings, then the environment, ADR 0007). */
  readonly provider: string;
  close(): Promise<void>;
}

export interface EvalSessionOptions {
  readonly config: AppConfig;
  /** What the subscription CLIs inherit (process.env in the script). */
  readonly env: NodeJS.ProcessEnv;
  readonly profile: ResearchProfile;
}

/**
 * Composes the research agent like main does, plus an MCP endpoint of its own on a free
 * port: a subscription CLI started by the eval must reach the kb tools of its turn, not
 * whatever API (or nothing) listens on PORT.
 */
async function composeAgent(config: AppConfig) {
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const log = createLogger('warn');
  const index = await createSearchIndex({ config, vault, log });
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const ledger = new JsonlSpendLedger(
    join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
  );
  return {
    index,
    agent: createResearchAgent({ catalog, index, vault, ledger }),
  };
}

export async function openEvalSession(
  options: EvalSessionOptions,
): Promise<EvalSession> {
  const { config } = options;
  const { index, agent } = await composeAgent(config);
  const turns = new McpTurnRegistry();
  const mcp = await startMcpTurnServer(turns, config.ALLOWED_HOSTS);
  const ai = await createAiProviders({
    config,
    principal: OWNER,
    store: new JsonSettingsStore(join(config.KB_CHAT_STATE_DIR, 'settings')),
    env: options.env,
    tools: agent.toolsFor,
    perTokenRunner: agent.perTokenRunner,
    systemPrompt: agent.systemPrompt,
    turns,
    apiBaseUrl: mcp.baseUrl,
  });
  return {
    runner: ai.registry.researchRunner(OWNER, options.profile),
    provider: ai.registry.active(OWNER),
    close: async () => {
      await mcp.close();
      await index.close();
    },
  };
}

/** What one research turn streamed, as the reader saw it. */
export interface EvalTurn {
  readonly answer: string;
  readonly steps: readonly string[];
  /** When each step came, in ms since the question. */
  readonly stepMs: readonly number[];
  readonly sources: ReadonlyMap<number, string>;
  /** Segments shown and then taken back (the agent thinking aloud, ADR 0009). */
  readonly retracts: number;
  readonly usd: number;
  readonly error: string | null;
  readonly firstStepMs: number | null;
  readonly firstTokenMs: number | null;
  readonly totalMs: number;
}

interface TurnState {
  segments: Map<number, string>;
  steps: string[];
  stepMs: number[];
  sources: Map<number, string>;
  retracts: number;
  usd: number;
  error: string | null;
  firstStepMs: number | null;
  firstTokenMs: number | null;
}

const COLLECTORS: {
  [K in ResearchEvent['type']]?: (
    state: TurnState,
    event: Extract<ResearchEvent, { type: K }>,
    elapsed: () => number,
  ) => void;
} = {
  token: (state, event, elapsed) => {
    const text = state.segments.get(event.segment) ?? '';
    state.segments.set(event.segment, text + event.text);
    state.firstTokenMs ??= elapsed();
  },
  retract: (state, event) => {
    state.segments.delete(event.segment);
    state.retracts += 1;
  },
  step: (state, event, elapsed) => {
    state.steps.push(event.step.text);
    state.stepMs.push(elapsed());
    state.firstStepMs ??= elapsed();
  },
  sources: (state, event) => {
    for (const s of event.sources)
      state.sources.set(s.n, `${s.title} (${s.id})`);
  },
  done: (state, event) => {
    state.usd = event.usd;
  },
  error: (state, event) => {
    state.error = event.code;
  },
};

function collect(
  state: TurnState,
  event: ResearchEvent,
  elapsed: () => number,
): void {
  const collector = COLLECTORS[event.type] as
    ((s: TurnState, e: ResearchEvent, t: () => number) => void) | undefined;
  collector?.(state, event, elapsed);
}

export interface EvalQuestion {
  readonly topic: string;
  readonly question: string;
  readonly history: readonly ResearchTurn[];
  readonly profile: ResearchProfile;
}

/** Runs one turn and times its first step, first answer text and end. */
export async function runEvalTurn(
  runner: ResearchRunnerPort,
  question: EvalQuestion,
): Promise<EvalTurn> {
  const state: TurnState = {
    segments: new Map(),
    steps: [],
    stepMs: [],
    sources: new Map(),
    retracts: 0,
    usd: 0,
    error: null,
    firstStepMs: null,
    firstTokenMs: null,
  };
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const input = { ...question, signal: new AbortController().signal };
  for await (const event of runner.run(input)) collect(state, event, elapsed);
  const { segments, ...rest } = state;
  return {
    ...rest,
    answer: [...segments.values()].join(''),
    totalMs: elapsed(),
  };
}
