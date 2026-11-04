import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
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
      guarded: true,
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
      guarded: true,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').replaceAll(/\s/g, '')).toBe(
      `${REVOCATION_LIST_HEADER.replaceAll(' ', '')}since${AT.toISOString()}${ONE}${TWO}${ONE}`,
    );
  });

  it('a line it cannot read in the list makes the list incomplete', async () => {
    await list.start(AT);
    await list.add(ONE);
    appendFileSync(path, `${TWO.slice(0, 20)}\n`);
    await list.add(TWO);
    expect(await list.read()).toEqual({
      ids: [ONE, TWO],
      complete: false,
      startedAt: AT.toISOString(),
      guarded: true,
    });
  });

  it('a last line with its break and no sense is not a torn write', async () => {
    await list.start(AT);
    appendFileSync(path, `${TWO.slice(0, 20)}\n`);
    expect((await list.read()).complete).toBe(false);
  });

  it('a torn write at the very end had no answer yet, so the list stays whole', async () => {
    await list.start(AT);
    await list.add(ONE);
    appendFileSync(path, TWO.slice(0, 20));
    expect(await list.read()).toEqual({
      ids: [ONE],
      complete: true,
      startedAt: AT.toISOString(),
      guarded: true,
    });
  });

  it('a whole id whose line break was lost still counts', async () => {
    await list.start(AT);
    appendFileSync(path, TWO);
    await list.add(ONE);
    expect(await list.read()).toEqual({
      ids: [TWO, ONE],
      complete: true,
      startedAt: AT.toISOString(),
      guarded: true,
    });
  });

  it('the next revocation cuts a torn write away, so the list stays whole', async () => {
    await list.start(AT);
    appendFileSync(path, TWO.slice(0, 20));
    await list.add(ONE);
    expect((await list.read()).complete).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toContain(TWO.slice(0, 20));
  });

  it('two revocations at once, over a torn write, both stay', async () => {
    await list.start(AT);
    appendFileSync(path, TWO.slice(0, 20));
    await Promise.all([list.add(ONE), list.add(TWO)]);
    const { ids, complete } = await list.read();
    expect(complete).toBe(true);
    expect([...ids].sort()).toEqual([ONE, TWO]);
  });

  it("the owner's mark after a check trusts the list from there on", async () => {
    await list.start(AT);
    appendFileSync(path, `${TWO.slice(0, 20)}\n`);
    appendFileSync(path, `\n${REVOCATION_LIST_HEADER}\n`);
    expect((await list.read()).complete).toBe(true);
  });

  it('the header after a torn line still counts', async () => {
    await list.add(ONE);
    appendFileSync(path, TWO.slice(0, 20));
    await list.start(AT);
    expect((await list.read()).complete).toBe(true);
  });

  it('starts once, however many ask at the same time', async () => {
    const later = new Date(AT.getTime() + 1000);
    await Promise.all([list.start(AT), list.start(later)]);
    expect(readFileSync(path, 'utf8').match(/since/g)).toHaveLength(1);
  });

  describe('who else can write it', () => {
    it('a closed list is guarded', async () => {
      await list.start(AT);
      expect((await list.read()).guarded).toBe(true);
    });

    it('a missing list has nobody to distrust', async () => {
      expect((await list.read()).guarded).toBe(true);
    });

    it.each([0o666, 0o640, 0o620, 0o604])(
      'a list with mode %o is not guarded, and no line of it is believed less for being there',
      async (mode) => {
        await list.start(AT);
        await list.add(ONE);
        chmodSync(path, mode);
        expect((await list.read()).guarded).toBe(false);
      },
    );

    it('a list of another owner is not guarded', async () => {
      await list.start(AT);
      const other = (process.getuid?.() ?? 0) + 1;
      const owned = new FsVoiceRevocationList(path, { uid: other });
      expect((await owned.read()).guarded).toBe(false);
    });

    it('a link in place of the list is not guarded, and nothing is read through it', async () => {
      const elsewhere = join(dir, 'elsewhere');
      writeFileSync(elsewhere, `${REVOCATION_LIST_HEADER}\n${ONE}\n`, {
        mode: 0o600,
      });
      symlinkSync(elsewhere, path);
      expect(await list.read()).toEqual({
        ids: [],
        complete: false,
        startedAt: null,
        guarded: false,
      });
    });

    it('adding to it still works: a revocation is never refused', async () => {
      await list.start(AT);
      chmodSync(path, 0o666);
      await list.add(ONE);
      expect((await list.read()).ids).toEqual([ONE]);
      expect(statSync(path).mode & 0o777).toBe(0o666);
    });
  });

  it('a revocation on a lost list counts, and the list stays lost', async () => {
    await list.add(ONE);
    expect(await list.read()).toEqual({
      ids: [ONE],
      complete: false,
      startedAt: null,
      guarded: true,
    });
  });

  it("the owner's mark has no date: a person checked the list", async () => {
    await list.start(AT);
    appendFileSync(path, `${REVOCATION_LIST_HEADER}\n`);
    expect((await list.read()).startedAt).toBeNull();
  });
});
