import { formatClock } from '@kb-chat/player-core';
import type {
  TrackChange,
  TrackChangeField,
  TrackImpact,
  MovedBookmarksEntry,
} from '@kb-chat/contracts';

const FIELDS: Record<TrackChangeField, () => string> = {
  title: () => $localize`:@@trackEdit.field.title:Título`,
  summary: () => $localize`:@@trackEdit.field.summary:Descrição`,
  asker: () => $localize`:@@trackEdit.field.asker:Quem pergunta`,
  answerer: () => $localize`:@@trackEdit.field.answerer:Quem responde`,
  bounds: () => $localize`:@@trackEdit.field.bounds:Início e fim`,
  subjects: () => $localize`:@@trackEdit.field.subjects:Assuntos`,
  archived: () => $localize`:@@trackEdit.field.archived:Faixa apagada`,
  restored: () => $localize`:@@trackEdit.field.restored:Faixa restaurada`,
};

export const changeFieldText = (field: TrackChangeField): string =>
  FIELDS[field]();

/** `<startMs>-<endMs>` as the bar says it. */
function boundsText(value: string): string {
  const [start, end] = value.split('-').map(Number);
  return `${formatClock(start ?? 0)} a ${formatClock(end ?? 0)}`;
}

const empty = () => $localize`:@@trackEdit.empty:vazio`;

const shown = (change: TrackChange, value: string | null): string => {
  if (value === null) return empty();
  return change.field === 'bounds' ? boundsText(value) : value;
};

/** Nothing for what has no before or after: being deleted says it all. */
export function changeValuesText(change: TrackChange): string {
  if (change.field === 'archived' || change.field === 'restored') return '';
  const before = shown(change, change.before);
  const after = shown(change, change.after);
  return $localize`:@@trackEdit.change:${before}:before: → ${after}:after:`;
}

/** FR-4: what a deletion touches, in numbers, and the way back. */
export function impactText({ listeners, bookmarks }: TrackImpact): string {
  const people =
    listeners === 1
      ? $localize`:@@trackEdit.impact.listener:1 pessoa ouviu esta faixa`
      : $localize`:@@trackEdit.impact.listeners:${listeners}:count: pessoas ouviram esta faixa`;
  const marks =
    bookmarks === 1
      ? $localize`:@@trackEdit.impact.bookmark:1 marcador está nela`
      : $localize`:@@trackEdit.impact.bookmarks:${bookmarks}:count: marcadores estão nela`;
  return $localize`:@@trackEdit.impact:${people}:people: e ${marks}:marks:. Você pode restaurar em até 30 dias.`;
}

/** BR-4: said to the bookmark's owner. */
export function movedText({ count }: Pick<MovedBookmarksEntry, 'count'>) {
  return count === 1
    ? $localize`:@@trackEdit.moved.one:1 marcador foi movido para a gravação completa porque a faixa mudou`
    : $localize`:@@trackEdit.moved:${count}:count: marcadores foram movidos para a gravação completa porque a faixa mudou`;
}

export const restoreRefusals: Record<string, () => string> = {
  'restore-expired': () =>
    $localize`:@@trackEdit.restore.expired:Passou o prazo de 30 dias para restaurar esta faixa.`,
  'restore-overlap': () =>
    $localize`:@@trackEdit.restore.overlap:Outra faixa ocupa este trecho agora. Ajuste os limites dela antes de restaurar.`,
  'edit-open': () =>
    $localize`:@@trackEdit.restore.editOpen:Esta gravação está em edição. Aprove as faixas antes de restaurar.`,
};
