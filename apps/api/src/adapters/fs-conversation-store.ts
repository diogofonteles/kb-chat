import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  conversationIdSchema,
  conversationSchema,
  type Conversation,
} from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { ConversationStorePort } from '../ports/conversation-store.js';

/** On-disk shape: the contract plus who owns it, versioned for later migrations. */
const storedSchema = z.object({
  v: z.literal(1),
  principal: z.string().min(1),
  conversation: conversationSchema,
});
type Stored = z.infer<typeof storedSchema>;

const FILE_SUFFIX = '.json';

export interface FsConversationStoreOptions {
  /** `<KB_CHAT_STATE_DIR>/conversations`, created on the first write. */
  readonly dir: string;
  readonly log: Pick<FastifyBaseLogger, 'warn'>;
}

const isMissing = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'ENOENT';

/**
 * One JSON file per conversation (`<id>.json`, mode 0600). Writes go to a temp file that is
 * renamed over the old one, so a crash never leaves a half-written conversation. Ids are
 * checked as uuids before touching the disk, so no id can name a path outside the folder.
 */
export class FsConversationStore implements ConversationStorePort {
  constructor(private readonly options: FsConversationStoreOptions) {}

  async list(principal: string): Promise<Conversation[]> {
    const names = await readdir(this.options.dir).catch((err: unknown) => {
      if (isMissing(err)) return [];
      throw err;
    });
    const ids = names
      .filter((name) => name.endsWith(FILE_SUFFIX))
      .map((name) => name.slice(0, -FILE_SUFFIX.length))
      .filter((id) => conversationIdSchema.safeParse(id).success);
    const stored = await Promise.all(ids.map((id) => this.read(id)));
    return stored.flatMap((entry) =>
      entry?.principal === principal ? [entry.conversation] : [],
    );
  }

  async get(principal: string, id: string): Promise<Conversation | null> {
    const entry = await this.read(id);
    return entry?.principal === principal ? entry.conversation : null;
  }

  async put(principal: string, conversation: Conversation): Promise<void> {
    const file = this.fileOf(conversation.id);
    const stored: Stored = { v: 1, principal, conversation };
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(stored), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temp, file);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async remove(principal: string, id: string): Promise<boolean> {
    const entry = await this.read(id);
    if (entry?.principal !== principal) return false;
    await rm(this.fileOf(id), { force: true });
    return true;
  }

  private fileOf(id: string): string {
    if (!conversationIdSchema.safeParse(id).success)
      throw new Error(`Invalid conversation id: ${JSON.stringify(id)}`);
    return join(this.options.dir, `${id}${FILE_SUFFIX}`);
  }

  /** A missing file is null; an unreadable one is logged and skipped, never fatal. */
  private async read(id: string): Promise<Stored | null> {
    const file = this.fileOf(id);
    const text = await readFile(file, 'utf8').catch((err: unknown) => {
      if (!isMissing(err))
        this.options.log.warn({ err, file }, 'cannot read a conversation file');
      return null;
    });
    if (text === null) return null;
    const parsed = storedSchema.safeParse(parseJson(text));
    // A file renamed by hand would answer for another id: skipped like a corrupt one.
    if (parsed.success && parsed.data.conversation.id === id)
      return parsed.data;
    this.options.log.warn({ file }, 'skipping an unreadable conversation file');
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
