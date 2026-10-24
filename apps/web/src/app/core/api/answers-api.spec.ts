import { newEvents } from './answers-api.js';

describe('newEvents', () => {
  const sse = (...events: object[]) =>
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

  it('returns complete events after the ones already seen', () => {
    const text = sse(
      { type: 'sources', sources: [] },
      { type: 'token', text: 'Oi' },
    );
    expect(newEvents(text, 0)).toHaveLength(2);
    expect(newEvents(text, 1)).toEqual([{ type: 'token', text: 'Oi' }]);
  });

  it('waits for an event cut in the middle', () => {
    const text = `${sse({ type: 'token', text: 'a' })}data: {"type":"tok`;
    expect(newEvents(text, 0)).toEqual([{ type: 'token', text: 'a' }]);
  });
});
