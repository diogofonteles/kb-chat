import type { TrackKind } from '@kb-chat/contracts';
import type { HandleStop, TrackEdge } from '@kb-chat/player-core';
import { formatClock } from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import type { ConflictReason, SaveResult } from './track-draft-state.js';

const pad = (value: number) => String(value).padStart(2, '0');

/** "12:04,2": a boundary to the tenth of a second (FR-3). */
export function formatBoundary(ms: number): string {
  const tenths = Math.round(ms / 100);
  const seconds = Math.floor(tenths / 10);
  const clock =
    seconds >= 3600
      ? formatClock(seconds * 1000)
      : `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  return `${clock},${tenths % 10}`;
}

/** "12 minutos e 4,2 segundos": a boundary read aloud (FR-4). */
export function speakBoundary(ms: number): string {
  const whole = Math.floor(ms / 1000) * 1000;
  const tenths = Math.round((ms - whole) / 100);
  if (tenths === 0 || tenths === 10) return speak(Math.round(ms / 1000) * 1000);
  const seconds = Math.floor(ms / 1000) % 60;
  const before = speak(whole - seconds * 1000);
  const second = $localize`:@@tracks.boundary.seconds:${seconds}:whole:,${tenths}:tenth: segundos`;
  if (whole - seconds * 1000 === 0) return second;
  return $localize`:@@tracks.boundary.spoken:${before}:minutes: e ${second}:seconds:`;
}

export const edgeName = (edge: TrackEdge, ordinal: number): string =>
  edge === 'start'
    ? $localize`:@@tracks.handle.start:Início da faixa ${ordinal}:ordinal:`
    : $localize`:@@tracks.handle.end:Fim da faixa ${ordinal}:ordinal:`;

/** Why a handle stopped, in words beside it (FR-3). */
export function stopText(stop: HandleStop | null): string {
  if (!stop || stop.kind === 'recording') return '';
  return stop.kind === 'minimum'
    ? $localize`:@@tracks.stop.minimum:Mínimo de 5 s`
    : $localize`:@@tracks.stop.neighbour:Encostou na faixa ${stop.ordinal}:ordinal:`;
}

/** What stands in the way, in the banner that keeps the tracks to copy (FR-10). */
export const CONFLICT_TEXT: Record<ConflictReason, () => string> = {
  stale: () =>
    $localize`:@@tracks.conflict:Outra pessoa mudou esta edição; recarregue para ver.`,
  approved: () =>
    $localize`:@@tracks.conflictApproved:Esta edição foi aprovada; recarregue para ver.`,
  'proposal-running': () =>
    $localize`:@@tracks.conflictRunning:Uma análise com IA começou nesta gravação; recarregue para acompanhar.`,
};

const NOT_DONE: Record<Exclude<SaveResult, 'saved'>, () => string> = {
  conflict: () =>
    $localize`:@@tracks.notDone.conflict:Nada foi feito: esta edição tem um conflito. Veja o aviso acima.`,
  failed: () =>
    $localize`:@@tracks.notDone.failed:Nada foi feito: não consegui salvar a última mudança.`,
  offline: () =>
    $localize`:@@tracks.notDone.offline:Nada foi feito: estou sem conexão.`,
};

/** Why a press stopped: only a save that came back fine lets it go on (BR-1). */
export const notDoneText = (result: SaveResult): string =>
  result === 'saved' ? '' : NOT_DONE[result]();

export const KIND_LABELS: Record<TrackKind, () => string> = {
  qa: () => $localize`:@@tracks.kind.qa:Pergunta e resposta`,
  talk: () => $localize`:@@tracks.kind.talk:Exposição`,
};
