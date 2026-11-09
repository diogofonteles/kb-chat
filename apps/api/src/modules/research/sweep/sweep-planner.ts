import type { MainAuthorIdentity } from '../prompt.js';
import type { SweepPlan } from '@kb-chat/contracts';
import type { TrackShelf } from '../../../ports/track-shelf.js';
import type { VaultReaderPort } from '../../../ports/vault-reader.js';
import {
  splitFrontmatter,
  type CatalogEntry,
  type CatalogRegistry,
} from '../../catalog/index.js';
import { acceptsEntry, type DocFilter } from '../doc-filter.js';
import type { TextFinder } from '../text-finder.js';
import { isVisible } from '../tool-context.js';
import { defaultPlan } from './plan-tool.js';
import { authorshipLabels, oneLine } from '../tool-output.js';

/**
 * Characters read on each side of an occurrence when a sweep has phrases: enough for the
 * sentence and the list that usually follow a mention (KBC-030, ADR 0021).
 */
export const HIT_WINDOW_CHARS = 1_500;
const READ_CONCURRENCY = 32;

/** A range of one document's body (NFC, frontmatter out, as read_document counts it). */
export interface SweepUnit {
  readonly entry: CatalogEntry;
  readonly start: number;
  readonly end: number;
}

/** One document of the set: what of it goes to the batches. */
export interface SweepDoc {
  readonly entry: CatalogEntry;
  readonly length: number;
  /** Empty when the document had no occurrence of the phrases (scanned, not read). */
  readonly units: readonly SweepUnit[];
}

export interface SweepBatch {
  /** 0-based, in sweep order. */
  readonly index: number;
  readonly units: readonly SweepUnit[];
  readonly chars: number;
}

/** The resolved sweep: the whole set, what a cursor skips and the batches left to run. */
export interface SweepLayout {
  readonly plan: SweepPlan;
  /** Every document of the target set, in id order (the cursor's order). */
  readonly docs: readonly SweepDoc[];
  /** Documents at or before the cursor: covered by an earlier turn. */
  readonly skipped: number;
  readonly batches: readonly SweepBatch[];
  /** Documents whose whole body was examined (scanned for the phrases, or read whole). */
  readonly scanned: number;
  /** Documents with any occurrence of the phrases; null without phrases. */
  readonly withHits: number | null;
}

export interface LayoutRequest {
  readonly plan: SweepPlan;
  /** Largest batch, in characters of document text (from the model's context). */
  readonly batchChars: number;
  /** The cursor: the last document id already swept. */
  readonly after?: string;
  /**
   * How many documents the cursor's set had. A set that changed since (a cursor from before
   * sub-collections or tracks joined it, KBC-101) starts over: an id order that moved would
   * count unread documents as read.
   */
  readonly cursorSet?: number;
  /** The tracks the turn may research; without it, texts only (KBC-101 BR-1, AC-5). */
  readonly tracks?: TrackShelf;
}

/** What of a track's body a batch showed (KBC-101 BR-4): to place its findings. */
export interface ShownWindow {
  readonly body: string;
  readonly start: number;
  readonly end: number;
}

/** A batch as the model reads it: fenced text, each document labelled [Dk]. */
export interface BatchText {
  readonly text: string;
  /** Label number → the document it names. */
  readonly labels: ReadonlyMap<number, CatalogEntry>;
  /** Label number → the windows of a track's body the batch showed, in order. */
  readonly shown: ReadonlyMap<number, readonly ShownWindow[]>;
}

export interface SweepPlannerDeps {
  readonly catalog: CatalogRegistry;
  readonly vault: VaultReaderPort;
  readonly finder: TextFinder;
  /** The collection's main author (KBC-049): the label of its documents. */
  readonly mainAuthorOf?: (topic: string) => MainAuthorIdentity | null;
}

const filterOf = (
  { target }: SweepPlan,
  visible: (entry: CatalogEntry) => boolean,
): DocFilter => ({
  authorship: target.authorship,
  entity: target.entity,
  source: target.source,
  subjects: target.subjects ?? [],
  visible,
});

/**
 * A track's kind and recording, as the tools label it (KBC-101 FR-2): its anchors stay in
 * the text, so a finding can be placed on its passage.
 */
function trackLabel(entry: CatalogEntry): string {
  const { media } = entry;
  if (!media) return '';
  const place =
    media.ordinal && media.total
      ? ` · faixa ${media.ordinal} de ${media.total}`
      : '';
  return ` · faixa de áudio (transcrição automática) · gravação “${oneLine(media.recordingTitle, 120)}”${place}`;
}

/** [start, end) ranges merged when they touch or overlap. */
function merged(
  ranges: readonly (readonly [number, number])[],
): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Ranges no longer than `size`: a big document becomes consecutive windows. */
function windows(
  entry: CatalogEntry,
  [start, end]: readonly [number, number],
  size: number,
): SweepUnit[] {
  const units: SweepUnit[] = [];
  for (let at = start; at < end; at += size)
    units.push({ entry, start: at, end: Math.min(end, at + size) });
  return units;
}

/** Consecutive units packed into batches of at most `size` characters. */
function packed(units: readonly SweepUnit[], size: number): SweepBatch[] {
  const batches: SweepBatch[] = [];
  let current: SweepUnit[] = [];
  let chars = 0;
  const close = () => {
    if (current.length > 0)
      batches.push({ index: batches.length, units: current, chars });
    current = [];
    chars = 0;
  };
  for (const unit of units) {
    const length = unit.end - unit.start;
    if (chars + length > size) close();
    current.push(unit);
    chars += length;
  }
  close();
  return batches;
}

/** The documents a cursor covered; none when its set changed since (see `cursorSet`). */
function skippedOf(
  docs: readonly SweepDoc[],
  { after, cursorSet = docs.length }: LayoutRequest,
): number {
  if (after === undefined || cursorSet !== docs.length) return 0;
  return docs.filter((d) => d.entry.id <= after).length;
}

async function mapLimited<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length; at += READ_CONCURRENCY)
    out.push(
      ...(await Promise.all(items.slice(at, at + READ_CONCURRENCY).map(map))),
    );
  return out;
}

/**
 * Resolves an exhaustive sweep (KBC-030, ADR 0021): the target set from the catalog, then
 * what each document contributes. With phrases, find_text's folded corpus scans every
 * body and only windows around occurrences are read; without, every body is read whole,
 * in windows no larger than a batch. Read-only, like every research tool.
 */
export class SweepPlanner {
  constructor(private readonly deps: SweepPlannerDeps) {}

  async layout(
    topic: string,
    request: LayoutRequest,
  ): Promise<SweepLayout | null> {
    const entries = this.targetSet(topic, request);
    if (!entries) return null;
    const phrases = request.plan.phrases;
    const docs =
      phrases.length > 0
        ? await this.hitDocs(topic, { entries, phrases, request })
        : await mapLimited(entries, (entry) =>
            this.wholeDoc(topic, entry, request.batchChars),
          );
    const skipped = skippedOf(docs, request);
    const pending = docs.slice(skipped).flatMap((d) => d.units);
    return {
      plan: request.plan,
      docs,
      skipped,
      batches: packed(pending, request.batchChars),
      scanned: docs.length,
      withHits:
        phrases.length > 0
          ? docs.filter((d) => d.units.length > 0).length
          : null,
    };
  }

  /**
   * The plan's documents in id order (the cursor's order), the collection's and its
   * sub-collections', texts and the tracks the turn may see (KBC-101 BR-1, FR-5); null for
   * an unknown topic.
   */
  private targetSet(
    topic: string,
    { plan, tracks }: LayoutRequest,
  ): CatalogEntry[] | null {
    const view = this.deps.catalog.scopeView(topic);
    if (!view) return null;
    const filter = filterOf(plan, (entry) =>
      isVisible(entry, { topic, tracks }),
    );
    return [...view.entries.values()]
      .filter((entry) => acceptsEntry(filter, entry))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * The default plan for a topic (ADR 0021): the Mestre's documents when the question names
   * him and the topic has any, otherwise the whole topic (architecture review of KBC-030).
   */
  defaultPlan(topic: string, question: string): SweepPlan {
    const plan = defaultPlan(question);
    const wanted = plan.target.authorship;
    if (!wanted) return plan;
    const entries = this.deps.catalog.scopeView(topic)?.entries.values() ?? [];
    const has = [...entries].some((entry) => entry.authorship === wanted);
    return has ? plan : { ...plan, target: {} };
  }

  /** The labelled, fenced text of one batch, read from the vault now. */
  async batchText(topic: string, batch: SweepBatch): Promise<BatchText> {
    const labels = new Map<number, CatalogEntry>();
    const numbers = new Map<string, number>();
    const shown = new Map<number, ShownWindow[]>();
    const parts: string[] = [];
    for (const unit of batch.units) {
      const known = numbers.get(unit.entry.id);
      const label = known ?? numbers.size + 1;
      numbers.set(unit.entry.id, label);
      labels.set(label, unit.entry);
      const body = (await this.body(topic, unit.entry)) ?? '';
      if (unit.entry.media)
        shown.set(label, [
          ...(shown.get(label) ?? []),
          { body, start: unit.start, end: unit.end },
        ]);
      parts.push(this.unitText(topic, { unit, label, body }));
    }
    return { text: parts.join('\n\n'), labels, shown };
  }

  private unitText(
    topic: string,
    { unit, label, body }: { unit: SweepUnit; label: number; body: string },
  ): string {
    const { entry } = unit;
    const labels = authorshipLabels(this.deps.mainAuthorOf?.(topic) ?? null);
    const author = entry.author ? ` (${oneLine(entry.author, 80)})` : '';
    const head = `[D${label}] ${oneLine(entry.title, 160)}${trackLabel(entry)} · autoria: ${labels[entry.authorship]}${author} — caracteres ${unit.start}–${unit.end} de ${body.length}`;
    return `${head}\n<<<DOCUMENTO\n${body.slice(unit.start, unit.end)}\nDOCUMENTO>>>`;
  }

  private async body(
    topic: string,
    entry: CatalogEntry,
  ): Promise<string | null> {
    const text = await this.deps.vault.readDocument(topic, entry.id);
    return text === null ? null : splitFrontmatter(text).body.normalize('NFC');
  }

  private async wholeDoc(
    topic: string,
    entry: CatalogEntry,
    size: number,
  ): Promise<SweepDoc> {
    const length = (await this.body(topic, entry))?.length ?? 0;
    return {
      entry,
      length,
      units: length > 0 ? windows(entry, [0, length], size) : [],
    };
  }

  private async hitDocs(
    topic: string,
    {
      entries,
      phrases,
      request,
    }: {
      entries: readonly CatalogEntry[];
      phrases: readonly string[];
      request: LayoutRequest;
    },
  ): Promise<SweepDoc[]> {
    const ids = new Set(entries.map((e) => e.id));
    const counted = await this.deps.finder.count({
      topic,
      phrases,
      accept: (e) => ids.has(e.id),
    });
    const hit = new Set(counted?.matches.map((m) => m.entry.id));
    return mapLimited(entries, async (entry) =>
      hit.has(entry.id)
        ? this.windowsAroundHits(topic, {
            entry,
            phrases,
            size: request.batchChars,
          })
        : { entry, length: 0, units: [] },
    );
  }

  private async windowsAroundHits(
    topic: string,
    {
      entry,
      phrases,
      size,
    }: { entry: CatalogEntry; phrases: readonly string[]; size: number },
  ): Promise<SweepDoc> {
    const found = await this.deps.finder.occurrencesIn(topic, entry, {
      phrases,
      chars: 0,
    });
    const length = found?.length ?? 0;
    // An occurrence only in the kb summary: the start of the body says where it comes from.
    const ranges = (found?.items ?? []).map(({ offset }): [number, number] => {
      const at = offset ?? 0;
      return [
        Math.max(0, at - HIT_WINDOW_CHARS),
        Math.min(length, at + HIT_WINDOW_CHARS),
      ];
    });
    const units = merged(ranges)
      .filter(([start, end]) => end > start)
      .flatMap((range) => windows(entry, range, size));
    return { entry, length, units };
  }
}
