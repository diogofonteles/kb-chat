import type {
  SweepCoverage,
  SweepProgress,
  SweepStopReason,
  SweepTarget,
} from '@kb-chat/contracts';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';

/** pt-BR is the only locale of v1 (i18n skill): "2.555". */
const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const n = (value: number): string => integer.format(value);

/** Why a sweep stopped before the end, in plain words (UP-11). */
const STOP_REASONS: Record<SweepStopReason, () => string> = {
  time: () =>
    $localize`:@@sweep.reasonTime:o tempo máximo de 30 minutos acabou`,
  requests: () =>
    $localize`:@@sweep.reasonRequests:o limite de pedidos desta pesquisa acabou`,
  spend: () => $localize`:@@sweep.reasonSpend:o teto de gasto do dia chegou`,
  capacity: () =>
    $localize`:@@sweep.reasonCapacity:o provedor de IA recusou pedidos demais`,
  stopped: () => $localize`:@@sweep.reasonStopped:você parou a pesquisa`,
};

export const stopReasonText = (reason: SweepStopReason): string =>
  STOP_REASONS[reason]();

/** "autoria Mestre Laércio; expressões: livro, obra", or the whole collection. */
export function targetText(
  target: SweepTarget,
  phrases: readonly string[],
): string {
  const parts = [
    target.authorship &&
      $localize`:@@sweep.authorship:autoria ${AUTHORSHIP_LABELS[target.authorship]}:label:`,
    target.entity &&
      $localize`:@@sweep.entity:entidade “${target.entity}:name:”`,
    target.source && $localize`:@@sweep.source:origem “${target.source}:name:”`,
    target.subjects?.length &&
      $localize`:@@sweep.subjects:assuntos: ${target.subjects.join(', ')}:list:`,
  ].filter((part): part is string => Boolean(part));
  const set =
    parts.length > 0
      ? parts.join('; ')
      : $localize`:@@sweep.wholeCollection:o acervo inteiro`;
  return phrases.length > 0
    ? $localize`:@@sweep.withPhrases:${set}:set:; expressões: ${phrases.join(', ')}:phrases:`
    : set;
}

/** Before the first batch: what the sweep will take (honest about free models, UP-02). */
export function estimateText(progress: SweepProgress): string {
  return $localize`:@@sweep.estimate:${n(progress.documents)}:documents: documentos em ~${n(progress.batches)}:batches: lotes (~${n(progress.requests)}:requests: pedidos à IA).`;
}

export const FREE_MODELS_NOTE = (): string =>
  $localize`:@@sweep.freeNote:Modelos gratuitos são menos rigorosos e mais lentos; a varredura pode levar vários minutos.`;

/** "Lote 12 de 80 · 640 de 2.555 documentos" (UP-14). */
export function progressText(progress: SweepProgress): string {
  return $localize`:@@sweep.progress:Lote ${n(progress.batchesDone)}:done: de ${n(progress.batches)}:batches: · ${n(progress.documentsDone)}:docs: de ${n(progress.documents)}:documents: documentos`;
}

/**
 * The coverage line the app measured (KBC-030): never the model's. Documents with
 * occurrences only when the sweep looked for expressions.
 */
export function coverageText(coverage: SweepCoverage): string {
  const parts = [
    $localize`:@@sweep.covSet:${n(coverage.documents)}:count: documentos no conjunto`,
    $localize`:@@sweep.covScanned:${n(coverage.scanned)}:count: varridos por dentro`,
    ...(coverage.withHits === null
      ? []
      : [
          $localize`:@@sweep.covHits:${n(coverage.withHits)}:count: com ocorrências`,
        ]),
    $localize`:@@sweep.covRead:${n(coverage.read)}:count: lidos`,
  ];
  return $localize`:@@sweep.coverage:Cobertura (medida pelo aplicativo): ${parts.join(' · ')}:parts:.`;
}

/** "Faltaram 1.900 documentos: o limite de pedidos desta pesquisa acabou." */
export function missingText(missing: number, reason: SweepStopReason): string {
  return $localize`:@@sweep.missing:Faltaram ${n(missing)}:count: documentos: ${stopReasonText(reason)}:reason:.`;
}

/** The steps summary's part: "varreu 2.555 de 2.555 documentos". */
export function sweptText(coverage: SweepCoverage): string {
  const swept = coverage.documents - coverage.missing;
  return $localize`:@@sweep.swept:varreu ${n(swept)}:swept: de ${n(coverage.documents)}:documents: documentos`;
}
