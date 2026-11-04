import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FsVoiceRevocationList,
  REVOCATION_LIST_HEADER,
} from './fs-voice-revocation-list.js';

const ONE = '11111111-1111-4111-8111-111111111111';
const TWO = '22222222-2222-4222-8222-222222222222';
const AT = new Date('2026-11-04T12:00:00.000Z');

describe('FsVoiceRevocationList (ADR 0032)', () => {
  let dir: string;
  let path: string;
  let list: FsVoiceRevocationList;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revocations-'));
    path = join(dir, 'voice-revocations.list');
    list = new FsVoiceRevocationList(path);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads as lost before it is started', async () => {
    expect(await list.read()).toEqual({
      ids: [],
      complete: false,
      startedAt: null,
    });
  });

  it('keeps ids only, in a closed file', async () => {
    await list.start(AT);
    await list.add(ONE);
    await list.add(TWO);
    await list.add(ONE);
    expect(await list.read()).toEqual({
      ids: [ONE, TWO],
      complete: true,
      startedAt: AT.toISOString(),
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').replaceAll(/\s/g, '')).toBe(
      `${REVOCATION_LIST_HEADER.replaceAll(' ', '')}since${AT.toISOString()}${ONE}${TWO}${ONE}`,
    );
  });

  it('survives a line torn by a crash, and the next id still counts', async () => {
    await list.start(AT);
    appendFileSync(path, `\n${TWO.slice(0, 10)}`);
    await list.add(ONE);
    expect((await list.read()).ids).toEqual([ONE]);
  });

  it('a revocation on a lost list counts, and the list stays lost', async () => {
    await list.add(ONE);
    expect(await list.read()).toEqual({
      ids: [ONE],
      complete: false,
      startedAt: null,
    });
  });

  it("the owner's mark has no date: a person checked the list", async () => {
    await list.start(AT);
    appendFileSync(path, `${REVOCATION_LIST_HEADER}\n`);
    expect((await list.read()).startedAt).toBeNull();
  });
});
