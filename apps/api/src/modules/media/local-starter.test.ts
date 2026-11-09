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
      saidSince: () => false,
    });
    await starter.start();
    expect(calls).toEqual(['restart -k']);
  });

  it('never -k while a start the API just made is still preparing (uv installing extras)', async () => {
    const { calls, local } = mac();
    const starter = new LocalStarter(local, {
      anyOnline: () => false,
      startingNow: () => true,
      saidSince: () => false,
    });
    await starter.start();
    expect(calls).toEqual(['start']);
  });

  it('never -k with a transcriber on', async () => {
    const { calls, local } = mac();
    const starter = new LocalStarter(local, {
      anyOnline: () => true,
      startingNow: () => false,
      saidSince: () => false,
    });
    await starter.start();
    expect(calls).toEqual(['start']);
  });

  it('review r3 S-5: a second press while its own start still prepares never uses -k', async () => {
    const { calls, local } = mac();
    let clock = new Date('2026-11-09T12:00:00.000Z');
    let heard = false;
    const starter = new LocalStarter(
      local,
      {
        anyOnline: () => false,
        startingNow: () => false,
        saidSince: () => heard,
      },
      () => clock,
    );
    await starter.start();
    // 40 s later uv is still installing the extras: no word from the transcriber yet.
    clock = new Date('2026-11-09T12:00:40.000Z');
    await starter.start();
    expect(calls).toEqual(['restart -k', 'start']);
    // Once it said something and went off again, a press may restart it.
    heard = true;
    clock = new Date('2026-11-09T12:01:20.000Z');
    await starter.start();
    expect(calls).toEqual(['restart -k', 'start', 'restart -k']);
  });
});
