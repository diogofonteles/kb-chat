import type { SegmentVoice } from '@kb-chat/contracts';

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
