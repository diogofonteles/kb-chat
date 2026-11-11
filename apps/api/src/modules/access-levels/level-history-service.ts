import {
  levelAuditQuerySchema,
  type LevelAuditEntry,
  type LevelAuditItem,
  type LevelAuditPage,
  type LevelAuditQuery,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  LevelAuditPort,
  LevelAuditPosition,
  LevelAuditRead,
} from '../../ports/level-audit.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import type { StoredPerson } from '../auth/index.js';
import type { CatalogRegistry } from '../catalog/index.js';
import type { ContentGate } from './content-gate.js';
import type { LevelDirectory } from './level-directory.js';

export interface LevelHistoryDeps {
  readonly audit: LevelAuditPort;
  readonly catalog: CatalogRegistry;
  readonly gate: ContentGate;
  readonly directory: LevelDirectory;
  readonly people: { list(): Promise<readonly StoredPerson[]> };
  /** An audio's title; absent with media off. */
  readonly media?: Pick<MediaStorePort, 'getMedia'>;
}

type Query = ReturnType<typeof levelAuditQuerySchema.parse>;

const CURSOR = /^(\d{4}-\d{2}):(\d{1,9})$/;

const badCursor = () =>
  new AppError('VALIDATION_FAILED', 'Invalid cursor', {
    details: { field: 'cursor' },
  });

export const encodeCursor = ({ month, index }: LevelAuditPosition): string =>
  Buffer.from(`${month}:${index}`).toString('base64url');

function decodeCursor(cursor: string): LevelAuditPosition {
  const match = CURSOR.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match?.[1] || !match[2]) throw badCursor();
  return { month: match[1], index: Number(match[2]) };
}

/** A bound as an instant: a day (`YYYY-MM-DD`) is its UTC start or end (R1-9). */
const instantOf = (bound: string, end: boolean): string =>
  bound.length > 10
    ? new Date(bound).toISOString()
    : `${bound}T${end ? '23:59:59.999' : '00:00:00.000'}Z`;

/** An operation, by collection and moment: its lines share both. */
const operationOf = (entry: LevelAuditEntry): string =>
  `${entry.collection}|${entry.at}`;

/** The filters of FR-4 as one predicate over a line; undone operations are left out (R1-5). */
function acceptsOf(
  query: Query,
  known: {
    readonly rootOf: (slug: string) => string;
    readonly undone: ReadonlySet<string>;
  },
): (entry: LevelAuditEntry) => boolean {
  const { rootOf, undone } = known;
  const actor = query.actor?.toLocaleLowerCase('pt-BR');
  const from = query.from && instantOf(query.from, false);
  const to = query.to && instantOf(query.to, true);
  return (entry) =>
    entry.kind !== 'scale.undone' &&
    !undone.has(operationOf(entry)) &&
    (!query.topic || rootOf(entry.collection) === query.topic) &&
    (!actor ||
      [entry.by, entry.actingAs ?? ''].some((who) =>
        who.toLocaleLowerCase('pt-BR').includes(actor),
      )) &&
    (!query.kind || entry.kind === query.kind) &&
    (!query.target || entry.target === query.target) &&
    (!from || entry.at >= from) &&
    (!to || entry.at <= to);
}

/** The scale's own lines, read whole for the codes of deleted levels and the undone marks. */
const SCALE_KINDS: ReadonlySet<LevelAuditEntry['kind']> = new Set([
  'scale.create',
  'scale.rename',
  'scale.delete',
  'scale.clear',
  'scale.undone',
]);
const SCALE_LINES_MAX = 10_000;

/** Each level id's code as the scale's lines last named it, and the operations undone. */
function scaleFacts(entries: readonly LevelAuditEntry[]) {
  const codes = new Map<string, string>();
  const undone = new Set<string>();
  const name = (collection: string, id: unknown, code: unknown) => {
    const key = `${collection}:${String(id)}`;
    if (typeof id === 'string' && typeof code === 'string' && !codes.has(key))
      codes.set(key, code);
  };
  for (const entry of entries) {
    if (entry.kind === 'scale.undone') undone.add(operationOf(entry));
    const said = entry.kind === 'scale.delete' ? entry.before : entry.after;
    name(entry.collection, entry.target, field(said, 'code'));
    const levels: unknown[] =
      entry.kind === 'scale.clear' && Array.isArray(entry.after)
        ? entry.after
        : [];
    levels.forEach((one) =>
      name(entry.collection, field(one, 'id'), field(one, 'code')),
    );
  }
  return { codes, undone };
}

const isMediaLine = (entry: LevelAuditEntry): boolean =>
  entry.count?.media !== undefined || entry.count?.recordings !== undefined;

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? (Reflect.get(value, key) as unknown)
    : undefined;

const text = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/** How a line's before and after read: nothing, a level id, a list of ids, a `{ code }`. */
type Reader = 'none' | 'code' | 'codes' | 'field';

const SHAPES: Record<LevelAuditEntry['kind'], readonly [Reader, Reader]> = {
  'scale.create': ['none', 'field'],
  'scale.rename': ['field', 'field'],
  'scale.reorder': ['codes', 'codes'],
  'scale.delete': ['field', 'none'],
  'scale.clear': ['codes', 'none'],
  'scale.undone': ['none', 'none'],
  'person.level': ['code', 'code'],
  'item.level': ['code', 'code'],
  bulk: ['none', 'code'],
};

/** Names and codes the page's lines need, read once per page. */
interface Labels {
  readonly codeOf: (collection: string, id: unknown) => string | null;
  readonly personOf: (id: string) => string | null;
  readonly nameOf: (email: string) => string;
}

/**
 * "Histórico de níveis" (KBC-108 FR-4, BR-5): the levels audit, newest first, as masters read
 * it: who (and as whom), when, what, before → after, in names and codes.
 */
export class LevelHistoryService {
  constructor(private readonly deps: LevelHistoryDeps) {}

  async page(input: LevelAuditQuery): Promise<LevelAuditPage> {
    const query = levelAuditQuerySchema.parse(input);
    const facts = scaleFacts(
      (
        await this.deps.audit.read({
          accepts: (entry) => SCALE_KINDS.has(entry.kind),
          limit: SCALE_LINES_MAX,
        })
      ).entries,
    );
    const rootOf = (slug: string) => this.deps.gate.rootOf(slug);
    const read: LevelAuditRead = {
      accepts: acceptsOf(query, { rootOf, undone: facts.undone }),
      ...(query.from && {
        fromMonth: instantOf(query.from, false).slice(0, 7),
      }),
      ...(query.to && { toMonth: instantOf(query.to, true).slice(0, 7) }),
      ...(query.cursor && { after: decodeCursor(query.cursor) }),
      limit: query.limit,
    };
    const { entries, next } = await this.deps.audit.read(read);
    const labels = await this.labels(facts.codes);
    return {
      items: entries.map((entry) => this.itemOf(entry, labels)),
      nextCursor: next ? encodeCursor(next) : null,
    };
  }

  private async labels(gone: ReadonlyMap<string, string>): Promise<Labels> {
    const people = await this.deps.people.list();
    const byEmail = new Map(people.map((one) => [one.email, one]));
    const byId = new Map(people.map((one) => [one.id, one]));
    return {
      codeOf: (collection, id) => {
        if (typeof id !== 'string') return null;
        const root = this.deps.gate.rootOf(collection);
        const level = this.deps.directory
          .scaleOf(root)
          .find((one) => one.id === id);
        // A level the kept lines no longer name: its id, which comes from its code (R1-8).
        return level?.code ?? gone.get(`${root}:${id}`) ?? id.toUpperCase();
      },
      personOf: (id) => {
        const person = byId.get(id);
        return person ? person.name || person.email : null;
      },
      nameOf: (email) => byEmail.get(email)?.name || email,
    };
  }

  private itemOf(entry: LevelAuditEntry, labels: Labels): LevelAuditItem {
    const { before, after } = this.changeOf(entry, labels);
    return {
      at: entry.at,
      by: entry.by,
      byName: labels.nameOf(entry.by),
      actingAs: entry.actingAs ?? null,
      actingAsName: entry.actingAs ? labels.nameOf(entry.actingAs) : null,
      kind: entry.kind,
      collection: entry.collection,
      target: entry.target ?? null,
      ...this.subjectOf(entry, labels),
      before,
      after,
      moves: this.movesOf(entry, labels),
      ...(entry.count && { count: entry.count }),
    };
  }

  /** Where a deleted level's content and people went, in codes. */
  private movesOf(
    entry: LevelAuditEntry,
    labels: Labels,
  ): LevelAuditItem['moves'] {
    if (entry.kind !== 'scale.delete') return null;
    const code = (key: string) =>
      labels.codeOf(entry.collection, field(entry.after, key)) ?? '';
    return { content: code('moveContentTo'), people: code('movePeopleTo') };
  }

  /** Before → after in codes, by what the line records. */
  private changeOf(
    entry: LevelAuditEntry,
    labels: Labels,
  ): { before: string | null; after: string | null } {
    const read = (reader: Reader, value: unknown): string | null => {
      const code = (id: unknown) => labels.codeOf(entry.collection, id);
      const readers: Record<Reader, () => string | null> = {
        none: () => null,
        code: () => code(value),
        codes: () =>
          Array.isArray(value) && value.length > 0
            ? value.map(code).join(', ')
            : null,
        field: () => text(field(value, 'code')),
      };
      return readers[reader]();
    };
    const [before, after] = SHAPES[entry.kind];
    return {
      before: read(before, entry.before),
      after: read(after, entry.after),
    };
  }

  /** What the line is about, named: a document, an audio, a person or a level. */
  private subjectOf(
    entry: LevelAuditEntry,
    labels: Labels,
  ): Pick<LevelAuditItem, 'subject' | 'targetLabel'> {
    const { target } = entry;
    if (!target) return { subject: null, targetLabel: null };
    if (entry.kind === 'person.level')
      return { subject: 'person', targetLabel: labels.personOf(target) };
    if (entry.kind === 'item.level' && isMediaLine(entry))
      return {
        subject: 'media',
        targetLabel: this.deps.media?.getMedia(target)?.title ?? null,
      };
    if (entry.kind === 'item.level')
      return {
        subject: 'document',
        targetLabel:
          this.deps.catalog.get(entry.collection)?.entries.get(target)?.title ??
          null,
      };
    if (entry.kind.startsWith('scale.'))
      return {
        subject: 'level',
        targetLabel:
          text(field(entry.after, 'code')) ??
          text(field(entry.before, 'code')) ??
          labels.codeOf(entry.collection, target),
      };
    return { subject: null, targetLabel: null };
  }
}
