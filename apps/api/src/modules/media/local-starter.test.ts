import type { LocalTranscriberStart } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { LocalStarter } from './transcriber-status-routes.js';

const mac = () => {
  const calls: string[] = [];
  const answer = (what: string) => (): Promise<LocalTranscriberStart> => {
    calls.push(what);
    return Promise.resolve({ ok: true, detail: what });
  };
  return {
    calls,
    local: { start: answer('restart -k'), wake: answer('start') },
  };
};

describe('LocalStarter: "Ligar transcritor" (QA F-2, review r2 S-1)', () => {
  it('restarts with -k only when none is on and no start is under way', async () => {
    const { calls, local } = mac();
    const starter = new LocalStarter(local, {
      anyOnline: () => false,
      startingNow: () => false,
    });
    await starter.start();
    expect(calls).toEqual(['restart -k']);
  });

  it('never -k while a start the API just made is still preparing (uv installing extras)', async () => {
    const { calls, local } = mac();
    const starter = new LocalStarter(local, {
      anyOnline: () => false,
      startingNow: () => true,
    });
    await starter.start();
    expect(calls).toEqual(['start']);
  });

  it('never -k with a transcriber on', async () => {
    const { calls, local } = mac();
    const starter = new LocalStarter(local, {
      anyOnline: () => true,
      startingNow: () => false,
    });
    await starter.start();
    expect(calls).toEqual(['start']);
  });
});
