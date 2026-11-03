import type {
  Authorship,
  SweepCoverage,
  SweepProgress,
  SweepStopReason,
  SweepTarget,
} from '@kb-chat/contracts';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { formatCost } from '@features/answer/answer-format.js';

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
  labels: Record<Authorship, string> = AUTHORSHIP_LABELS,
): string {
  const parts = [
    target.authorship &&
      $localize`:@@sweep.authorship:autoria ${labels[target.authorship]}:label:`,
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

/** Before the first batch: what the sweep will take, in time or money (UP-02, SL-24). */
export function estimateText(progress: SweepProgress): string {
  const volume = $localize`:@@sweep.estimate:${n(progress.documents)}:documents: documentos em ~${n(progress.batches)}:batches: lotes (~${n(progress.requests)}:requests: pedidos à IA).`;
  const time =
    progress.minutes === undefined
      ? ''
      : $localize`:@@sweep.estimateTime: Leva pelo menos ~${n(Math.max(1, progress.minutes))}:minutes: min.`;
  const cost =
    progress.usd === undefined
      ? ''
      : $localize`:@@sweep.estimateCost: Custo de no máximo ${formatCost(progress.usd)}:usd:, dentro do seu teto diário.`;
  return `${volume}${time}${cost}`;
}

export const FREE_MODELS_NOTE = (): string =>
  $localize`:@@sweep.freeNote:Modelos gratuitos são menos rigorosos e mais lentos.`;

/** The progress bar's fixed name; its numbers are in the status text (MA-29). */
export const PROGRESS_LABEL = (): string =>
  $localize`:@@sweep.progressLabel:Progresso da varredura`;

/** "Lote 12 de 80 · a IA analisou 412 de 1.363 documentos" (UP-14). */
export function progressText(progress: SweepProgress): string {
  return $localize`:@@sweep.progress:Lote ${n(progress.batchesDone)}:done: de ${n(progress.batches)}:batches: · ${analyzedText(progress.documentsDone, progress.needed)}:analyzed:`;
}

/**
 * One word per count, the same everywhere (design review of KBC-030): "conferidos pelas
 * expressões" (searched for the phrases), "com ocorrências", "analisados pela IA".
 */
const analyzedText = (read: number, needed: number): string =>
  $localize`:@@sweep.analyzed:a IA analisou ${n(read)}:read: de ${n(needed)}:needed: documentos`;

/** The coverage line the app measured (KBC-030): never the model's. */
export function coverageText(coverage: SweepCoverage): string {
  const parts =
    coverage.withHits === null
      ? [
          $localize`:@@sweep.covSet:${n(coverage.documents)}:count: documentos no conjunto`,
          $localize`:@@sweep.covReadWhole:${n(coverage.read)}:count: lidos por inteiro pela IA`,
        ]
      : [
          $localize`:@@sweep.covSet:${n(coverage.documents)}:count: documentos no conjunto`,
          $localize`:@@sweep.covScanned:${n(coverage.scanned)}:count: conferidos pelas expressões`,
          $localize`:@@sweep.covHits:${n(coverage.withHits)}:count: com ocorrências`,
          $localize`:@@sweep.covAnalyzed:${n(coverage.read)}:count: analisados pela IA`,
        ];
  const total = coverage.continued
    ? $localize`:@@sweep.covContinued: (somando as varreduras anteriores)`
    : '';
  return $localize`:@@sweep.coverage:Cobertura (medida pelo aplicativo): ${parts.join(' · ')}:parts:${total}:total:.`;
}

/** "Faltaram 951 documentos para a IA analisar: o limite de pedidos desta pesquisa acabou." */
export function missingText(missing: number, reason: SweepStopReason): string {
  return $localize`:@@sweep.missing:Faltaram ${n(missing)}:count: documentos para a IA analisar: ${stopReasonText(reason)}:reason:.`;
}

/** Every document analyzed, but the answer could not be written. */
export function unansweredText(reason: SweepStopReason): string {
  return $localize`:@@sweep.unanswered:A varredura terminou, mas a resposta não foi escrita: ${stopReasonText(reason)}:reason:.`;
}

/** The steps summary's part: "a IA analisou 412 de 1.363 documentos". */
export const sweptText = ({ read, needed }: { read: number; needed: number }) =>
  analyzedText(read, needed);
