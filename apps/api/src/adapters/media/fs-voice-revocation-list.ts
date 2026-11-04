import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  VoiceRevocationListPort,
  VoiceRevocations,
} from '../../ports/voice-revocation-list.js';
import { isMissingFile } from '../atomic-json.js';

/** The owner's mark on a list checked by hand (runbook 11): it trusts the list from there. */
export const REVOCATION_LIST_HEADER = 'voice-revocations v1';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** The app's own mark, dated: it vouches only for consents from that moment on. */
const STARTED =
  /^voice-revocations v1 since (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

const isHeader = (line: string): boolean =>
  line === REVOCATION_LIST_HEADER || STARTED.test(line);

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
    const header = lines.findLast(isHeader);
    return {
      ids: [...new Set(lines.filter((line) => UUID.test(line)))],
      complete: header !== undefined,
      startedAt: header?.match(STARTED)?.[1] ?? null,
    };
  }

  async start(at: Date): Promise<void> {
    await this.append(`${REVOCATION_LIST_HEADER} since ${at.toISOString()}\n`);
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
