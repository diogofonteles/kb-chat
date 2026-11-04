import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  VoiceRevocationListPort,
  VoiceRevocations,
} from '../../ports/voice-revocation-list.js';
import { isMissingFile } from '../atomic-json.js';

/** The mark of a list started on purpose; the runbook appends it after a lost disk. */
export const REVOCATION_LIST_HEADER = 'voice-revocations v1';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * One 0600 text file next to `media.db`, with a profile id per line. It is in no backup, so a
 * restore never rolls it back (ADR 0032). Each id goes between line breaks: a line torn by a
 * crash costs only that line, and that revocation had not answered yet.
 */
export class FsVoiceRevocationList implements VoiceRevocationListPort {
  constructor(private readonly path: string) {}

  async add(profileId: string): Promise<void> {
    await this.append(`\n${profileId}\n`);
  }

  async read(): Promise<VoiceRevocations> {
    const lines = (await this.content()).split('\n');
    return {
      ids: [...new Set(lines.filter((line) => UUID.test(line)))],
      complete: lines.includes(REVOCATION_LIST_HEADER),
    };
  }

  async start(): Promise<void> {
    await this.append(`${REVOCATION_LIST_HEADER}\n`);
    const folder = await open(dirname(this.path), 'r');
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  }

  private async append(text: string): Promise<void> {
    const file = await open(this.path, 'a', 0o600);
    try {
      await file.appendFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async content(): Promise<string> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (err) {
      if (isMissingFile(err)) return '';
      throw err;
    }
  }
}
