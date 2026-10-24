import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import type { TopicFolder, VaultReaderPort } from '../ports/vault-reader.js';

const SERVED_ROOTS = ['raw', join('wiki', 'concepts')] as const;
const EXCLUDED_SEGMENT = '_quarantine';
const MAX_NESTING = 2;

const isMarkdown = (path: string): boolean => path.endsWith('.md');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readTopicTitle(dir: string, slug: string): Promise<string> {
  const yamlText = await readFile(join(dir, 'topic.yaml'), 'utf8');
  const parsed: unknown = parse(yamlText);
  const title = (parsed as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : slug;
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
    await this.collectTopics('', 1, topics);
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

  private async collectTopics(
    prefix: string,
    depth: number,
    out: TopicFolder[],
  ): Promise<void> {
    const dir = join(this.root, prefix);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        entry.name.startsWith('_')
      )
        continue;
      const slug = prefix ? `${prefix}/${entry.name}` : entry.name;
      await this.visitCandidate(slug, depth, out);
    }
  }

  private async visitCandidate(
    slug: string,
    depth: number,
    out: TopicFolder[],
  ): Promise<void> {
    const dir = join(this.root, slug);
    if (await exists(join(dir, 'topic.yaml'))) {
      out.push({ slug, title: await readTopicTitle(dir, slug) });
      return;
    }
    if (depth < MAX_NESTING) await this.collectTopics(slug, depth + 1, out);
  }
}
