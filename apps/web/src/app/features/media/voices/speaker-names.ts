import type { MediaTranscript, VoiceLabel } from '@kb-chat/contracts';
import { lastStartedAt, type Cue } from '@kb-chat/player-core';
import { voiceChangeStarts } from './voice-changes.js';

/** What the screen says for a voice (KBC-065 BR-2, BR-3, BR-6). */
export interface SpeakerShown {
  readonly name: string;
  readonly main: boolean;
}

export const audienceLabel = (): string =>
  $localize`:@@voices.audience:Pergunta da plateia`;

const UNNAMED_FOR_EDITORS = (voice: number): string =>
  $localize`:@@voices.voice:Voz ${voice}:number:`;

const UNNAMED_FOR_LISTENERS = (): string =>
  $localize`:@@voices.unidentified:Falante não identificado`;

function speakerShownOf(
  label: VoiceLabel | undefined,
  voice: number,
  editing: boolean,
): SpeakerShown {
  if (label?.kind === 'person')
    return { name: label.name ?? '', main: label.main };
  if (label?.kind === 'audience') return { name: audienceLabel(), main: false };
  return {
    name: editing ? UNNAMED_FOR_EDITORS(voice) : UNNAMED_FOR_LISTENERS(),
    main: false,
  };
}

/** Whoever receives the separation edits recordings: an unnamed voice reads "Voz N" (BR-6). */
const isEditing = (transcript: MediaTranscript): boolean =>
  transcript.speakers !== undefined;

/**
 * Each voice and the voice it reads as: two voices of one person are one speaker, so the
 * name does not repeat between them; two voices of the audience are two people, and do.
 */
function sameSpeaker(labels: readonly VoiceLabel[]): Map<number, number> {
  const first = new Map<string, number>();
  const same = new Map<number, number>();
  for (const { voice, speakerId } of labels) {
    if (speakerId === null) continue;
    const kept = first.get(speakerId) ?? voice;
    first.set(speakerId, kept);
    same.set(voice, kept);
  }
  return same;
}

/** Who speaks at the first segment of each change of speaker (FR-4), by segment index. */
export function speakerChanges(
  transcript: MediaTranscript,
): Map<number, SpeakerShown & { readonly voice: number }> {
  const labels = transcript.voiceNames ?? [];
  const same = sameSpeaker(labels);
  const editing = isEditing(transcript);
  const voices = transcript.segments.map(({ voice }) => ({
    voice:
      voice === null || voice === undefined ? null : (same.get(voice) ?? voice),
  }));
  const shown = new Map<number, SpeakerShown & { voice: number }>();
  for (const index of voiceChangeStarts(voices)) {
    const voice = voices[index]?.voice ?? 1;
    const label = labels.find((one) => one.voice === voice);
    shown.set(index, { voice, ...speakerShownOf(label, voice, editing) });
  }
  return shown;
}

const prefixOf = ({ name, main }: SpeakerShown): string =>
  `— ${main ? '✦ ' : ''}${name}: `;

/**
 * The cues with the speaker's name at each change (FR-4): "— ✦ Mestre Gabriel: …". The voice
 * of a cue is its segment's; the API's subtitles stay the same for everybody.
 */
export function cuesWithSpeakers(
  cues: readonly Cue[],
  transcript: MediaTranscript,
): readonly Cue[] {
  const { segments } = transcript;
  const changes = [...speakerChanges(transcript)].sort(([a], [b]) => a - b);
  let next = 0;
  return cues.map((cue) => {
    const at = lastStartedAt(segments, cue.startMs);
    let shown: SpeakerShown | null = null;
    while (next < changes.length && (changes[next]?.[0] ?? Infinity) <= at) {
      shown = changes[next]?.[1] ?? null;
      next += 1;
    }
    return shown ? { ...cue, text: prefixOf(shown) + cue.text } : cue;
  });
}
