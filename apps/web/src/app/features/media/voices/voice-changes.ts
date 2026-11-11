import type { SegmentVoice, SpeakerTurn } from '@kb-chat/contracts';

/**
 * Where "Voz N" is shown in the transcript (KBC-064 FR-5): the index of the first segment
 * of each change of voice. A segment with no voice (silence, music) changes nothing, so the
 * same voice speaking on after it is not labelled again.
 */
export function voiceChangeStarts(
  segments: readonly Pick<SegmentVoice, 'voice'>[],
): Set<number> {
  const starts = new Set<number>();
  let previous: number | null = null;
  segments.forEach(({ voice }, index) => {
    if (voice === null) return;
    if (voice !== previous) starts.add(index);
    previous = voice;
  });
  return starts;
}

/** The voice label's look: one of 5 colour tokens and a filled or hollow shape (never colour alone). */
export interface VoiceLook {
  /** 1 to 5: `--color-voice-N`. */
  readonly tone: number;
  readonly shape: 'circle' | 'square' | 'triangle' | 'diamond' | 'hexagon';
  /** Voices 6 to 10 repeat the tones with hollow shapes. */
  readonly hollow: boolean;
}

const SHAPES: readonly VoiceLook['shape'][] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'hexagon',
];

export function voiceLookOf(voice: number): VoiceLook {
  const index = (voice - 1) % SHAPES.length;
  return {
    tone: index + 1,
    shape: SHAPES[index] ?? 'circle',
    hollow: voice > SHAPES.length,
  };
}

/** How long a voice's sample plays (KBC-065 FR-3). */
export const SAMPLE_MS = 5_000;

/** The first 5 s of the voice's longest turn (the whole turn when shorter); null with none. */
export function sampleOf(
  turns: readonly SpeakerTurn[],
  voice: number,
): { readonly startMs: number; readonly endMs: number } | null {
  let longest: SpeakerTurn | null = null;
  for (const turn of turns)
    if (
      turn.voice === voice &&
      (!longest || turn.endMs - turn.startMs > longest.endMs - longest.startMs)
    )
      longest = turn;
  if (!longest) return null;
  const { startMs, endMs } = longest;
  return { startMs, endMs: Math.min(endMs, startMs + SAMPLE_MS) };
}
