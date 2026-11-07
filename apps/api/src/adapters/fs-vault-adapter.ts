import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { TopicFolder, VaultReaderPort } from '../ports/vault-reader.js';

const SERVED_ROOTS = ['raw', join('wiki', 'concepts')] as const;
const EXCLUDED_SEGMENT = '_quarantine';
const MAX_NESTING = 2;

const topicYamlSchema = z.looseObject({
  title: z.string().optional(),
  domain: z.string().optional(),
});

/** Where the topic walk is: the folder, how deep, and the topic it sits in (if any). */
interface Walk {
  readonly prefix: string;
  readonly depth: number;
  readonly parent?: string;
}

const isMarkdown = (path: string): boolean => path.endsWith('.md');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The topic's title (its slug without one) and its kb `domain`, from topic.yaml. */
async function readTopicYaml(
  dir: string,
  slug: string,
): Promise<{ title: string; domain?: string }> {
  const yamlText = await readFile(join(dir, 'topic.yaml'), 'utf8');
  const parsed = topicYamlSchema.safeParse(parse(yamlText));
  const title = parsed.success ? parsed.data.title?.trim() : undefined;
  const domain = parsed.success ? parsed.data.domain?.trim() : undefined;
  return { title: title || slug, ...(domain && { domain }) };
}

async function listServedRoot(
  topicDir: string,
  servedRoot: string,
): Promise<string[]> {
  const dir = join(topicDir, servedRoot);
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { recursive: true });
  return entries
    .filter(
      (entry) =>
        isMarkdown(entry) && !entry.split(sep).includes(EXCLUDED_SEGMENT),
    )
    .map((entry) => join(servedRoot, entry).split(sep).join('/'));
}

/** Reads a kb vault from the filesystem; it never writes. */
export class FsVaultAdapter implements VaultReaderPort {
  constructor(private readonly root: string) {}

  async listTopics(): Promise<readonly TopicFolder[]> {
    const topics: TopicFolder[] = [];
    await this.collectTopics({ prefix: '', depth: 1 }, topics);
    return topics.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async listDocuments(topic: string): Promise<readonly string[]> {
    const topicDir = join(this.root, topic);
    const ids: string[] = [];
    for (const servedRoot of SERVED_ROOTS)
      ids.push(...(await listServedRoot(topicDir, servedRoot)));
    return ids.sort();
  }

  async readDocument(topic: string, id: string): Promise<string | null> {
    const topicDir = join(this.root, topic);
    try {
      const realTopic = await realpath(topicDir);
      const realFile = await realpath(join(topicDir, id));
      const inside = relative(realTopic, realFile);
      if (
        inside.startsWith('..') ||
        inside.startsWith(sep) ||
        !isMarkdown(realFile)
      )
        return null;
      return await readFile(realFile, 'utf8');
    } catch {
      return null;
    }
  }

  private async collectTopics(at: Walk, out: TopicFolder[]): Promise<void> {
    const dir = join(this.root, at.prefix);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        entry.name.startsWith('_')
      )
        continue;
      const slug = at.prefix ? `${at.prefix}/${entry.name}` : entry.name;
      await this.visitCandidate(slug, at, out);
    }
  }

  /**
   * A folder with topic.yaml is a topic; one level down it may hold sub-topics
   * (`udv/palavra-do-mestre`, ADR 0028). A folder without it may only group topics.
   */
  private async visitCandidate(
    slug: string,
    at: Walk,
    out: TopicFolder[],
  ): Promise<void> {
    const dir = join(this.root, slug);
    const isTopic = await exists(join(dir, 'topic.yaml'));
    if (isTopic) {
      const yaml = await readTopicYaml(dir, slug);
      out.push(
        at.parent ? { slug, ...yaml, parent: at.parent } : { slug, ...yaml },
      );
    }
    if (at.depth < MAX_NESTING)
      await this.collectTopics(
        {
          prefix: slug,
          depth: at.depth + 1,
          parent: isTopic ? slug : undefined,
        },
        out,
      );
  }
}
