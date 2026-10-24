import { aResponse } from '../../testing/fixtures.js';
import { reduceChat, type Ask } from './chat-message.js';

const ask: Ask = { id: 1, topic: 'hermetismo', question: 'ritmo', mode: 'all' };

describe('reduceChat', () => {
  it('adds a loading message when an ask starts', () => {
    const messages = reduceChat([], { type: 'started', ask });
    expect(messages).toEqual([
      { ...ask, status: 'loading', response: null, error: null },
    ]);
  });

  it('stores the response and then an error on the same message', () => {
    const started = reduceChat([], { type: 'started', ask });
    const done = reduceChat(started, {
      type: 'done',
      id: 1,
      response: aResponse(),
    });
    expect(done[0]?.status).toBe('done');
    const failed = reduceChat(done, {
      type: 'failed',
      id: 1,
      error: 'OFFLINE',
    });
    expect(failed[0]).toMatchObject({ status: 'error', error: 'OFFLINE' });
  });

  it('replaces a retried message in place instead of appending', () => {
    const first = reduceChat([], { type: 'started', ask });
    const failed = reduceChat(first, {
      type: 'failed',
      id: 1,
      error: 'OFFLINE',
    });
    const retried = reduceChat(failed, { type: 'started', ask });
    expect(retried).toHaveLength(1);
    expect(retried[0]?.status).toBe('loading');
  });
});
