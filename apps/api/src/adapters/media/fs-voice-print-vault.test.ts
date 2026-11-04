import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../secret-box.js';
import { FsVoicePrintVault } from './fs-voice-print-vault.js';

const PRINT = [0.25, -0.5, 0.125];
const ID = '11111111-1111-4111-8111-111111111111';

describe('FsVoicePrintVault (ADR 0032)', () => {
  let dir: string;
  let vault: FsVoicePrintVault;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'vault-')), 'voice-prints');
    vault = new FsVoicePrintVault(dir, new SecretBox(Buffer.alloc(32, 7)));
  });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('stores a print sealed, in a closed folder, and reads it back', async () => {
    await vault.put(ID, PRINT);
    expect(await vault.read(ID)).toEqual(PRINT);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(dir);
    const path = join(dir, file ?? '');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('0.25');
  });

  it('a print copied onto another profile does not open', async () => {
    await vault.put(ID, PRINT);
    const other = '22222222-2222-4222-8222-222222222222';
    writeFileSync(
      join(dir, `${other}.sealed`),
      readFileSync(join(dir, `${ID}.sealed`)),
    );
    expect(await vault.read(other)).toBeNull();
  });

  it('a print sealed with another key does not open', async () => {
    await vault.put(ID, PRINT);
    const other = new FsVoicePrintVault(
      dir,
      new SecretBox(Buffer.alloc(32, 8)),
    );
    expect(await other.read(ID)).toBeNull();
  });

  it('removes for good, and removing again is no error', async () => {
    await vault.put(ID, PRINT);
    await vault.remove(ID);
    await vault.remove(ID);
    expect(await vault.has(ID)).toBe(false);
    expect(await vault.read(ID)).toBeNull();
    expect(await vault.ids()).toEqual([]);
  });

  it('BR-2: removing also takes a write a crash left unfinished', async () => {
    await vault.put(ID, PRINT);
    writeFileSync(join(dir, `${ID}.tmp`), 'half a sealed print');
    await vault.remove(ID);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a write left by a crash neither blocks the next one nor shows as a print', async () => {
    await vault.put(ID, PRINT);
    writeFileSync(join(dir, `${ID}.tmp`), 'half a sealed print');
    expect(await vault.ids()).toEqual([ID]);
    await vault.put(ID, PRINT);
    expect(await vault.read(ID)).toEqual(PRINT);
    expect(readdirSync(dir)).toEqual([`${ID}.sealed`]);
  });

  it('removes what a crash left on its own, whatever its profile', async () => {
    await vault.put(ID, PRINT);
    writeFileSync(join(dir, 'lost.tmp'), 'half a sealed print');
    expect(await vault.removeUnfinished()).toBe(1);
    expect(readdirSync(dir)).toEqual([`${ID}.sealed`]);
    expect(await vault.removeUnfinished()).toBe(0);
  });

  it('a failed write leaves nothing behind', async () => {
    await vault.put(ID, PRINT);
    rmSync(join(dir, `${ID}.sealed`));
    mkdirSync(join(dir, `${ID}.sealed`));
    await expect(vault.put(ID, PRINT)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([`${ID}.sealed`]);
  });

  it('finds no unfinished write before the first print', async () => {
    expect(await vault.removeUnfinished()).toBe(0);
  });

  it('lists nothing before the first print', async () => {
    expect(await vault.ids()).toEqual([]);
  });
});
