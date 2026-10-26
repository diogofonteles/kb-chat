import { describe, expect, it } from 'vitest';
import type {
  AgentChunk,
  AgentLlmPort,
  AgentStreamOptions,
} from '../ports/llm.js';
import { HouseLlm, type PaidFallbackGate } from './house-llm.js';

/** An adapter that records the chain of each call and answers one token. */
function recordingAdapter() {
  const chains: (readonly string[] | undefined)[] = [];
  const adapter: AgentLlmPort = {
    model: 'openrouter',
    billing: 'per-token',
    configured: () => true,
    price: async () => ({ input: 1, output: 1 }),
    balance: async () => 5,
    maxOutputTokens: (n) => n,
    stream: async function* () {
      yield { type: 'token', text: 'x' };
    },
    streamAgent: async function* (_m, _t, options: AgentStreamOptions) {
      chains.push(options.models);
      yield { type: 'token', text: 'x' } satisfies AgentChunk;
      yield {
        type: 'tool_call',
        call: { id: '1', name: 't', arguments: '{}' },
      };
    },
  };
  return { adapter, chains };
}

const options = { maxTokens: 1000, signal: new AbortController().signal };

const gate = (
  allowed: boolean,
): PaidFallbackGate & { asked: number[]; settled: [number, number][] } => {
  const asked: number[] = [];
  const settled: [number, number][] = [];
  return {
    model: 'paid/model',
    price: { input: 1e-6, output: 2e-6 },
    asked,
    settled,
    allowed: async (estimate) => {
      asked.push(estimate);
      return allowed;
    },
    settle: (estimate, usd) => settled.push([estimate, usd]),
  };
};

const drain = async (stream: AsyncIterable<unknown>) => {
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

describe('HouseLlm (KBC-022 AC-7, BR-5)', () => {
  it('sends the free chain and adds the paid model only while the cap allows', async () => {
    const { adapter, chains } = recordingAdapter();
    const free = ['a:free', 'openrouter/free'];
    const allowed = gate(true);
    const llm = new HouseLlm({ adapter, chain: () => free, paid: allowed });
    await drain(
      llm.streamAgent([{ role: 'user', content: 'abcdefg' }], [], options),
    );
    expect(chains[0]).toEqual(['a:free', 'openrouter/free', 'paid/model']);
    // 7 characters ≈ 2 tokens at 3.5 per token, plus the whole output budget.
    expect(allowed.asked[0]).toBeCloseTo(2 * 1e-6 + 1000 * 2e-6);
    // No usage reported by this adapter: the whole reservation is counted.
    expect(allowed.settled).toEqual([[allowed.asked[0], allowed.asked[0]]]);
    const refused = new HouseLlm({
      adapter,
      chain: () => free,
      paid: gate(false),
    });
    await drain(refused.streamAgent([], [], options));
    expect(chains[1]).toEqual(free);
    const none = new HouseLlm({ adapter, chain: () => free, paid: null });
    await drain(none.streamAgent([], [], options));
    expect(chains[2]).toEqual(free);
  });

  it('is priced at zero before the call and names the first model of the chain', async () => {
    const { adapter } = recordingAdapter();
    const llm = new HouseLlm({ adapter, chain: () => ['a:free'], paid: null });
    expect(await llm.price()).toEqual({ input: 0, output: 0 });
    expect(await llm.balance()).toBeNull();
    expect(llm.model).toBe('a:free');
    expect(llm.maxOutputTokens(10)).toBe(10);
    expect(llm.configured()).toBe(true);
    expect(await drain(llm.stream([], options))).toEqual([
      { type: 'token', text: 'x' },
    ]);
    const empty = new HouseLlm({ adapter, chain: () => [], paid: null });
    expect(empty.configured()).toBe(false);
    expect(empty.model).toBe('openrouter');
  });
});
