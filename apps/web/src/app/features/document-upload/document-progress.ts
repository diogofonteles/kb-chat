import type { DocumentUpload, DocumentWork } from '@kb-chat/contracts';

/** Where an item is for the person: at work, in line, waiting for them, ended. */
export type UploadPhase = 'active' | 'yours' | 'waiting' | 'failed' | 'ready';

/** A recording transcribed whose tracks wait for a person. */
const waitsForPerson = ({ state, progress }: DocumentUpload): boolean =>
  state === 'choosing' ||
  (state === 'transcribing' && progress.media?.step === 'attention');

export function phaseOf(upload: DocumentUpload): UploadPhase {
  if (waitsForPerson(upload)) return 'yours';
  if (upload.state === 'received') return 'waiting';
  if (upload.state === 'ready' || upload.state === 'failed')
    return upload.state;
  return 'active';
}

/** The steps of an item and where it is in them. */
export interface UploadSteps {
  readonly words: readonly string[];
  /** The step it is in; past the last one when it ended well. */
  readonly at: number;
}

const RECEIVED = () => $localize`:@@docProgress.step.received:Recebido`;
const READY = () => $localize`:@@docProgress.step.ready:Pronto`;
const CLASSIFYING = () =>
  $localize`:@@docProgress.step.classifying:Classificando`;

const documentSteps = () => [
  RECEIVED(),
  $localize`:@@docProgress.step.converting:Convertendo`,
  CLASSIFYING(),
  $localize`:@@docProgress.step.map:No mapa`,
  READY(),
];
const recordingSteps = () => [
  RECEIVED(),
  $localize`:@@docProgress.step.downloading:Baixando`,
  $localize`:@@docProgress.step.transcribing:Transcrevendo`,
  CLASSIFYING(),
  READY(),
];
const listSteps = () => [
  RECEIVED(),
  $localize`:@@docProgress.step.listing:Lendo a lista`,
  $localize`:@@docProgress.step.choosing:Sua escolha`,
];

const DOCUMENT_AT: Partial<Record<DocumentUpload['state'], number>> = {
  converting: 1,
  classifying: 2,
  mapping: 3,
  mapped: 3,
};

function recordingAt({ state, progress }: DocumentUpload): number {
  if (state === 'converting') return 1;
  if (state !== 'transcribing') return 0;
  return progress.media?.step === 'publishing' ? 3 : 2;
}

const listAt = ({ state }: DocumentUpload): number =>
  state === 'choosing' ? 2 : state === 'converting' ? 1 : 0;

/** Null once it failed: where it stopped is said by why it failed. */
export function stepsOf(upload: DocumentUpload): UploadSteps | null {
  if (upload.state === 'failed') return null;
  const { words, at } =
    upload.kind === 'recording'
      ? { words: recordingSteps(), at: recordingAt(upload) }
      : upload.kind === 'list'
        ? { words: listSteps(), at: listAt(upload) }
        : { words: documentSteps(), at: DOCUMENT_AT[upload.state] ?? 0 };
  return { words, at: upload.state === 'ready' ? words.length : at };
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "menos de 1 min", "12 min", "2 h", "1 h 20 min", "3 dias". */
export function durationText(exact: number): string {
  if (exact < MINUTE)
    return $localize`:@@docProgress.underMinute:menos de 1 min`;
  // To the minute first: 59 min and a half are an hour, never "60 min".
  const seconds = Math.round(exact / MINUTE) * MINUTE;
  if (seconds < HOUR) {
    const minutes = seconds / MINUTE;
    return $localize`:@@docProgress.minutes:${minutes}:n: min`;
  }
  if (seconds < DAY) return hoursText(seconds);
  const days = Math.floor(seconds / DAY);
  return days === 1
    ? $localize`:@@docProgress.oneDay:1 dia`
    : $localize`:@@docProgress.days:${days}:n: dias`;
}

function hoursText(seconds: number): string {
  const hours = Math.floor(seconds / HOUR);
  const minutes = (seconds % HOUR) / MINUTE;
  return minutes === 0
    ? $localize`:@@docProgress.hours:${hours}:h: h`
    : $localize`:@@docProgress.hoursMinutes:${hours}:h: h ${minutes}:n: min`;
}

/** "menos de 1 min", "cerca de 12 min": a time nobody knows to the second. */
export const aboutText = (seconds: number): string =>
  seconds < MINUTE
    ? durationText(seconds)
    : $localize`:@@docProgress.about:cerca de ${durationText(seconds)}:time:`;

/** Seconds from a moment to another, never negative (two clocks may differ a little). */
export const secondsSince = (from: string, now: number): number =>
  Math.max(0, Math.round((now - Date.parse(from)) / 1_000));

/** "3º na fila · começa em cerca de 4 min". */
function placeText({ progress }: DocumentUpload): string {
  const { position, startsInSeconds } = progress;
  if (position === null) return '';
  const place =
    position === 1
      ? $localize`:@@docProgress.next:Próximo da fila`
      : $localize`:@@docProgress.place:${position}:n:º na fila`;
  if (startsInSeconds === null) return place;
  return startsInSeconds < MINUTE / 2
    ? $localize`:@@docProgress.startsNow:${place}:place: · começa em instantes`
    : $localize`:@@docProgress.startsIn:${place}:place: · começa em ${aboutText(startsInSeconds)}:time:`;
}

/** "Há 1 min · falta cerca de 2 min". */
function workingText({ progress }: DocumentUpload, now: number): string {
  if (progress.startedAt === null) return '';
  const seconds = secondsSince(progress.startedAt, now);
  const since = $localize`:@@docProgress.since:Há ${durationText(seconds)}:time:`;
  const left = progress.takesSeconds ?? 0;
  if (left > 0)
    return $localize`:@@docProgress.working:${since}:since: · falta ${aboutText(left)}:left:`;
  // A first minute is nobody's delay, whatever the last ones took.
  return seconds < MINUTE
    ? since
    : $localize`:@@docProgress.workingLong:${since}:since: · está demorando mais que o comum`;
}

/** A recording in the library: what is being done to it, and how far. */
function mediaText({ progress }: DocumentUpload): string {
  const { media } = progress;
  if (!media) return '';
  const texts: Record<typeof media.step, () => string> = {
    preparing: () =>
      $localize`:@@docProgress.media.preparing:Preparando o áudio`,
    waiting: () =>
      $localize`:@@docProgress.media.waiting:Áudio pronto, esperando a vez de transcrever`,
    transcribing: () =>
      $localize`:@@docProgress.media.transcribing:O Mac está ouvindo e escrevendo`,
    publishing: () =>
      $localize`:@@docProgress.media.publishing:Transcrito; o kb classifica e publica`,
    attention: () =>
      $localize`:@@docProgress.media.attention:Transcrito; espera você na Fila de processamento`,
  };
  const text = texts[media.step]();
  return media.percent === null
    ? text
    : $localize`:@@docProgress.media.percent:${text}:text: · ${media.percent}:percent:%`;
}

function sendingText({ bytes, received }: DocumentUpload): string {
  if (!bytes || received === null) return '';
  const percent = Math.floor((received / bytes) * 100);
  return $localize`:@@docProgress.sending:${percent}:percent:% enviado`;
}

const STATUS_TEXTS: Partial<
  Record<DocumentUpload['state'], (upload: DocumentUpload) => string>
> = {
  received: placeText,
  receiving: sendingText,
  transcribing: mediaText,
};

/** What is known of an item now, in a line; empty when its state says it all. */
export const statusText = (upload: DocumentUpload, now: number): string =>
  STATUS_TEXTS[upload.state]?.(upload) ?? workingText(upload, now);

/** How everything on the list stands; the parts always add up to `total`. */
export interface UploadsSummary {
  readonly total: number;
  readonly counts: Readonly<Record<UploadPhase, number>>;
  /** What the Mac has now (the first one, of the person's). */
  readonly working: DocumentUpload | null;
  /** The Mac's time still to come; null when nothing waits for it. */
  readonly secondsLeft: number | null;
  /** Recordings still to be transcribed: their time is not in `secondsLeft`. */
  readonly hasTranscription: boolean;
  readonly spentUsd: number;
  /** The ceilings of the inclusions on the list; null when none has one. */
  readonly capUsd: number | null;
}

export function summaryOf(uploads: readonly DocumentUpload[]): UploadsSummary {
  const counts = { active: 0, yours: 0, waiting: 0, failed: 0, ready: 0 };
  for (const one of uploads) counts[phaseOf(one)] += 1;
  const batches = new Map(
    uploads.flatMap(({ batch }) => (batch ? [[batch.id, batch]] : [])),
  );
  const all = [...batches.values()];
  return {
    total: uploads.length,
    counts,
    working: uploads.find((one) => one.progress.startedAt !== null) ?? null,
    secondsLeft: secondsLeftOf(uploads),
    hasTranscription: uploads.some(isToTranscribe),
    spentUsd: all.reduce((sum, one) => sum + one.spentUsd, 0),
    capUsd:
      all.length === 0 ? null : all.reduce((sum, one) => sum + one.capUsd, 0),
  };
}

const isToTranscribe = (one: DocumentUpload): boolean =>
  one.kind === 'recording' &&
  ['received', 'converting', 'transcribing'].includes(one.state);

/** When the last of them would be done; the sum of each while the Mac is off. */
function secondsLeftOf(uploads: readonly DocumentUpload[]): number | null {
  const ahead = uploads.filter(
    ({ progress }) => progress.position !== null || progress.startedAt !== null,
  );
  if (ahead.length === 0) return null;
  const ends = ahead.map(
    ({ progress }) =>
      (progress.startsInSeconds ?? 0) + (progress.takesSeconds ?? 0),
  );
  const known = ahead.every(
    ({ progress }) =>
      progress.startedAt !== null || progress.startsInSeconds !== null,
  );
  return known ? Math.max(...ends) : ends.reduce((sum, one) => sum + one, 0);
}

/** The Mac for the screen: one that has an item now is there, whatever was last heard. */
export const macStateOf = (work: DocumentWork): DocumentWork['mac']['state'] =>
  work.busy ? 'on' : work.mac.state;
