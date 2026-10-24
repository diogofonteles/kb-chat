import {
  aiTestCodeSchema,
  type AiTestCode,
  type AiTestResult,
} from '@kb-chat/contracts';
import { LlmKeyRejectedError } from '../ports/llm-errors.js';
import type { LlmPort } from '../ports/llm.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import type {
  ResearchToolResult,
  ResearchToolsPort,
} from '../ports/research-tools.js';
import type { ProviderChoice } from './provider-registry.js';
import { PROVIDERS } from './provider-catalog.js';

/** NFR-1: the test answers within 20 s or reports "sem resposta do provedor". */
export const TEST_TIMEOUT_MS = 20_000;
export const TEST_QUESTION = 'Responda apenas: ok';

export interface ConnectionTestDeps {
  readonly choice: ProviderChoice;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly locate: () => Promise<string | null>;
  readonly llm: () => LlmPort;
  /** A runner whose tool set is NO_TOOLS. */
  readonly runner: () => ResearchRunnerPort;
}

/** A tool set with no tools: the CLI test only proves login and the MCP connection. */
export const NO_TOOLS: ResearchToolsPort = {
  definitions: () => [],
  call: async (name): Promise<ResearchToolResult> => {
    throw new Error(`No tool ${name} in a connection test`);
  },
};

class TestFailure extends Error {
  constructor(readonly code: AiTestCode) {
    super(code);
  }
}

/** OpenRouter's adapter reports refusals as "OpenRouter answered 401". */
const isKeyRejected = (err: unknown): boolean =>
  err instanceof LlmKeyRejectedError ||
  (err instanceof Error && /answered 40[13]\b/.test(err.message));

function failureCode(err: unknown, timedOut: boolean): AiTestCode {
  if (err instanceof TestFailure) return err.code;
  if (timedOut) return 'PROVIDER_TIMEOUT';
  return isKeyRejected(err) ? 'LLM_KEY_REJECTED' : 'PROVIDER_UNAVAILABLE';
}

async function askModel(llm: LlmPort, signal: AbortSignal): Promise<void> {
  if (!llm.configured()) throw new TestFailure('LLM_NOT_CONFIGURED');
  const chunks = llm.stream([{ role: 'user', content: TEST_QUESTION }], {
    maxTokens: 64,
    signal,
  });
  for await (const chunk of chunks) void chunk;
  if (signal.aborted) throw new TestFailure('PROVIDER_TIMEOUT');
}

async function askCli(
  deps: ConnectionTestDeps,
  signal: AbortSignal,
): Promise<void> {
  if ((await deps.locate()) === null) throw new TestFailure('CLI_MISSING');
  const runner = deps.runner();
  const events = runner.run({
    topic: '',
    question: TEST_QUESTION,
    history: [],
    signal,
  });
  for await (const event of events) {
    if (event.type === 'error') {
      const code = aiTestCodeSchema.safeParse(event.code);
      throw new TestFailure(code.success ? code.data : 'PROVIDER_UNAVAILABLE');
    }
    if (event.type === 'done' && event.interrupted)
      throw new TestFailure('PROVIDER_TIMEOUT');
  }
}

/** Asks the provider a minimal question (KBC-007 FR-2); the key is never part of the result. */
export async function testConnection(
  deps: ConnectionTestDeps,
): Promise<AiTestResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? TEST_TIMEOUT_MS);
  const signal = AbortSignal.any([deps.signal, timeout]);
  const { provider, model } = deps.choice;
  const result = (ok: boolean, code: AiTestCode | null): AiTestResult => ({
    ok,
    code,
    model: model ?? provider,
    latencyMs: Date.now() - started,
  });
  try {
    if (provider !== 'stub' && PROVIDERS[provider].billing === 'subscription')
      await askCli(deps, signal);
    else await askModel(deps.llm(), signal);
    return result(true, null);
  } catch (err) {
    return result(false, failureCode(err, timeout.aborted));
  }
}
