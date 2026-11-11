import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretSealerPort } from '../../ports/secret-sealer.js';
import type { VoicePrintVaultPort } from '../../ports/voice-print-vault.js';
import { isMissingFile } from '../atomic-json.js';

const SUFFIX = '.sealed';
const UNFINISHED = '.tmp';
const contextOf = (profileId: string): string => `voice-print:${profileId}`;

/**
 * One 0600 sealed file per profile (ADR 0032). The folder is not in the backup, which copies
 * `media.db` only: once removed here, a print is gone from the system. A write in progress
 * carries the profile's id too, so that a revocation removes it and a start finds it after a
 * crash.
 */
export class FsVoicePrintVault implements VoicePrintVaultPort {
  constructor(
    private readonly dir: string,
    private readonly sealer: SecretSealerPort,
  ) {}

  async put(profileId: string, embedding: readonly number[]): Promise<void> {
    const sealed = this.sealer.seal(
      JSON.stringify(embedding),
      contextOf(profileId),
    );
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const temp = this.unfinishedOf(profileId);
    try {
      await writeFile(temp, sealed, { mode: 0o600 });
      await rename(temp, this.pathOf(profileId));
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async read(profileId: string): Promise<number[] | null> {
    const sealed = await this.sealedOf(profileId);
    if (sealed === null) return null;
    try {
      const plain = this.sealer.open(sealed, contextOf(profileId));
      return JSON.parse(plain) as number[];
    } catch {
      return null;
    }
  }

  async opens(profileId: string): Promise<boolean> {
    return (await this.read(profileId)) !== null;
  }

  async remove(profileId: string): Promise<void> {
    await rm(this.pathOf(profileId), { force: true });
    await rm(this.unfinishedOf(profileId), { force: true });
  }

  async ids(): Promise<string[]> {
    const names = await this.names(SUFFIX);
    return names.map((name) => name.slice(0, -SUFFIX.length));
  }

  async removeUnfinished(): Promise<number> {
    const names = await this.names(UNFINISHED);
    await Promise.all(
      names.map((name) => rm(join(this.dir, name), { force: true })),
    );
    return names.length;
  }

  private async names(suffix: string): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      return names.filter((name) => name.endsWith(suffix));
    } catch (err) {
      if (isMissingFile(err)) return [];
      throw err;
    }
  }

  private async sealedOf(profileId: string): Promise<string | null> {
    try {
      return await readFile(this.pathOf(profileId), 'utf8');
    } catch (err) {
      if (isMissingFile(err)) return null;
      throw err;
    }
  }

  private unfinishedOf(profileId: string): string {
    return join(this.dir, `${profileId}${UNFINISHED}`);
  }

  private pathOf(profileId: string): string {
    return join(this.dir, `${profileId}${SUFFIX}`);
  }
}
