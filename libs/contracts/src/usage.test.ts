import { describe, expect, it } from 'vitest';
import { usageEventRequestSchema, usageRecordSchema } from './usage.js';

describe('usage contracts', () => {
  it('accepts a usage event request and refuses an invalid session id', () => {
    const event = { type: 'open_doc', position: null };
    const sessionId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
    expect(usageEventRequestSchema.parse({ sessionId, event })).toEqual({
      sessionId,
      event,
    });
    expect(
      usageEventRequestSchema.safeParse({ sessionId: 'x', event }).success,
    ).toBe(false);
  });

  it('reads a log line with who and when', () => {
    const line = {
      type: 'ai_answer',
      usd: 0.01,
      ts: '2026-10-24T10:00:00.000Z',
      principal: 'owner',
      sessionId: 's1',
    };
    expect(usageRecordSchema.parse(line)).toEqual(line);
    expect(usageRecordSchema.safeParse({ ...line, ts: 'ontem' }).success).toBe(
      false,
    );
  });
});
