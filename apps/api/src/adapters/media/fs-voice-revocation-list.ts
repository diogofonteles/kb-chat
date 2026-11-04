import { open, readFile, type FileHandle } from 'node:fs/promises';
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
const LINE_BREAK = 0x0a;

const isHeader = (line: string): boolean =>
  line === REVOCATION_LIST_HEADER || STARTED.test(line);
const isKnownLine = (line: string): boolean =>
  UUID.test(line) || isHeader(line);

/** Every line that ended; what follows the last break counts only if it is a whole line. */
function linesOf(content: string): string[] {
  const lines = content.split('\n');
  const last = lines.pop() ?? '';
  return isKnownLine(last) ? [...lines, last] : lines;
}

/**
 * One 0600 text file next to `media.db`, with a profile id per line. It is in no backup, so a
 * restore never rolls it back (ADR 0032). A write reaches the disk before anything is answered,
 * so only the very end of the file can be torn, by a crash, and that revocation had no answer.
 * Any other line that makes no sense may be a revocation already answered: the list is then
 * incomplete, from the last header on, and the owner's next mark takes it back.
 */
export class FsVoiceRevocationList implements VoiceRevocationListPort {
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  add(profileId: string): Promise<void> {
    return this.inTurn(() => this.append(profileId));
  }

  async read(): Promise<VoiceRevocations> {
    const lines = linesOf(await this.content());
    const start = lines.findLastIndex(isHeader);
    const header = lines[start];
    const since = lines.slice(start + 1);
    return {
      ids: [...new Set(lines.filter((line) => UUID.test(line)))],
      complete:
        header !== undefined &&
        since.every((line) => line === '' || UUID.test(line)),
      startedAt: header?.match(STARTED)?.[1] ?? null,
    };
  }

  /** Twice at once writes one header: a second date would be younger than the first consent. */
  start(at: Date): Promise<void> {
    return this.inTurn(async () => {
      if ((await this.read()).complete) return;
      await this.append(`${REVOCATION_LIST_HEADER} since ${at.toISOString()}`);
    });
  }

  /** One writer at a time: cutting a torn end must not cut what another write just added. */
  private inTurn<T>(write: () => Promise<T>): Promise<T> {
    const done = this.turn.then(write);
    this.turn = done.catch(() => undefined);
    return done;
  }

  /** Between line breaks; a torn end goes first, or it would read as a line that ended. */
  private async append(line: string): Promise<void> {
    const file = await open(this.path, 'a+', 0o600);
    try {
      await cutTornEnd(file);
      await file.appendFile(`\n${line}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await this.syncFolder();
  }

  /** So a list just created is not lost with the folder's entry. */
  private async syncFolder(): Promise<void> {
    const folder = await open(dirname(this.path), 'r');
    try {
      await folder.sync();
    } finally {
      await folder.close();
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

async function cutTornEnd(file: FileHandle): Promise<void> {
  const bytes = await file.readFile();
  const lineEnd = bytes.lastIndexOf(LINE_BREAK) + 1;
  const end = bytes.subarray(lineEnd).toString('utf8');
  if (end !== '' && !isKnownLine(end)) await file.truncate(lineEnd);
}
