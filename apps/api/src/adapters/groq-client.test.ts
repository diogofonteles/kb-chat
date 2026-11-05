import { describe, expect, it } from 'vitest';
import { FakeGroq } from '../testing/fake-groq.js';
import { GroqClient, retryAfterMsOf } from './groq-client.js';

describe('GroqClient (KBC-037)', () => {
  it('checks a key by listing the models (FR-1)', async () => {
    const groq = new FakeGroq();
    const client = new GroqClient({ fetch: groq.fetch });
    expect(await client.checkKey('gsk_test_valid')).toBe('ok');
    expect(await client.checkKey('gsk_wrong')).toBe('key-rejected');
    expect(groq.keyChecks).toEqual(['gsk_test_valid', 'gsk_wrong']);
  });

  it('says Groq is unreachable when the network fails or Groq errs', async () => {
    const down = new GroqClient({
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(await down.checkKey('gsk_test_valid')).toBe('unreachable');
    const failing = new GroqClient({
      fetch: async () => new Response('', { status: 503 }),
    });
    expect(await failing.checkKey('gsk_test_valid')).toBe('unreachable');
  });

  it('sends a chunk with the model, Portuguese, the prompt and word and segment times', async () => {
    const groq = new FakeGroq();
    const client = new GroqClient({ fetch: groq.fetch });
    const answer = await client.transcribe({
      key: 'gsk_test_valid',
      audio: Buffer.from('fLaC-bytes'),
      prompt: 'Hoasca, Tiuaco.',
    });
    expect(answer.kind).toBe('ok');
    expect(groq.calls).toEqual([
      {
        key: 'gsk_test_valid',
        model: 'whisper-large-v3-turbo',
        language: 'pt',
        prompt: 'Hoasca, Tiuaco.',
        granularities: ['word', 'segment'],
        bytes: 10,
      },
    ]);
  });

  it("passes on a 429's retry-after and a refused key", async () => {
    const groq = new FakeGroq();
    const client = new GroqClient({ fetch: groq.fetch });
    groq.rateLimitNext(1, 30);
    const chunk = { audio: Buffer.from('x'), prompt: '' };
    expect(
      await client.transcribe({ ...chunk, key: 'gsk_test_valid' }),
    ).toEqual({ kind: 'rate-limited', retryAfterMs: 30_000 });
    expect(await client.transcribe({ ...chunk, key: 'gsk_bad' })).toEqual({
      kind: 'key-rejected',
    });
    const failing = new GroqClient({
      fetch: async () => new Response('', { status: 500 }),
    });
    expect(await failing.transcribe({ ...chunk, key: 'k' })).toEqual({
      kind: 'failed',
      status: 500,
    });
  });

  it('reads retry-after in seconds or as a date, with a default', () => {
    expect(retryAfterMsOf('30')).toBe(30_000);
    expect(retryAfterMsOf('1.5')).toBe(1_500);
    expect(
      retryAfterMsOf(
        'Wed, 21 Oct 2026 07:28:30 GMT',
        Date.parse('2026-10-21T07:28:00Z'),
      ),
    ).toBe(30_000);
    expect(retryAfterMsOf(null)).toBe(30_000);
    expect(retryAfterMsOf('soon')).toBe(30_000);
  });
});
