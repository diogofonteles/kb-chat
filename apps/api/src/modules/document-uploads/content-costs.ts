import type {
  ContentCost,
  ContentCostKind,
  ContentCosts,
} from '@kb-chat/contracts';
import type { DocumentUploadRecord } from '../../ports/document-uploads.js';

/**
 * The first measurements, used for a kind until a few were added here: the dearest of 46
 * documents kb judged (2026-11-25, US$ 0.0026), rounded up, plus a vision model's description
 * for an image.
 */
export const FIRST_COSTS: ContentCosts = {
  document: { usd: 0.003, seconds: 60, samples: 0 },
  image: { usd: 0.004, seconds: 40, samples: 0 },
  page: { usd: 0.003, seconds: 40, samples: 0 },
  recording: { usd: 0.003, seconds: 60, samples: 0 },
};

/** Fewer than this say little: the first measurements stay. */
export const MIN_SAMPLES = 5;
/** Only the latest: kb's model, and so its price, changes. */
export const MAX_SAMPLES = 100;
/** The estimate is "até": most cost less than this share of the sample. */
const SHARE = 0.9;

const IMAGE = /\.(png|jpe?g|tiff?|webp)$/i;

export const costKindOf = (
  record: DocumentUploadRecord,
): ContentCostKind | null => {
  if (record.kind === 'url') return 'page';
  if (record.kind === 'recording') return 'recording';
  if (record.kind !== 'file') return null;
  return IMAGE.test(record.name) ? 'image' : 'document';
};

/** Done on the Mac as a new document (one already there was not judged). */
const isSample = (record: DocumentUploadRecord): boolean =>
  record.state === 'mapped' && record.detail === null;

function atShare(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * SHARE));
  return sorted[at] ?? 0;
}

function measured(
  samples: readonly DocumentUploadRecord[],
  first: ContentCost,
): ContentCost {
  if (samples.length < MIN_SAMPLES) return first;
  const times = samples.flatMap((one) =>
    one.workMs === null ? [] : [one.workMs / 1_000],
  );
  return {
    usd: atShare(samples.map((one) => one.spentUsd)),
    seconds: times.length === 0 ? first.seconds : Math.ceil(atShare(times)),
    samples: samples.length,
  };
}

/** What one item of each kind costs and takes here, from the latest ones that ended. */
export function contentCostsOf(
  records: readonly DocumentUploadRecord[],
): ContentCosts {
  const latest = records
    .filter(isSample)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const of = (kind: ContentCostKind): ContentCost =>
    measured(
      latest.filter((one) => costKindOf(one) === kind).slice(0, MAX_SAMPLES),
      FIRST_COSTS[kind],
    );
  return {
    document: of('document'),
    image: of('image'),
    page: of('page'),
    recording: of('recording'),
  };
}
