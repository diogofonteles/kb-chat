/**
 * Reduced raw results of the transcription pilot (2026-10-28, `out/<variant>/raw`): a few
 * chunks per track, token ids dropped, for the post-filter and confidence tests (KBC-036
 * AC-4, AC-5). The full transcripts and the audio stay outside the repository.
 */
import { readFileSync } from 'node:fs';
import { rawTranscriptSchema, type RawTranscript } from '@kb-chat/contracts';
import { fileURLToPath } from 'node:url';

export const PILOT_FIXTURES = [
  'loop-elingue',
  'noisy-cd03-05',
  'noisy-cd03-06',
  'noisy-cd03-08',
  'clean-cd01-01',
  'clean-cd02-01',
] as const;
export type PilotFixture = (typeof PILOT_FIXTURES)[number];

export function pilotRaw(name: PilotFixture): RawTranscript {
  const path = fileURLToPath(
    new URL(`./fixtures/transcripts/${name}.json`, import.meta.url),
  );
  const text = readFileSync(path, 'utf8');
  return rawTranscriptSchema.parse(JSON.parse(text));
}

/** The pilot's term list (migration 5, v1). */
export const PILOT_TERMS = [
  'Mestre Gabriel',
  'UDV',
  'União do Vegetal',
  'Vegetal',
  'Hoasca',
  'Burracheira',
  'Caiano',
  'Minguarana',
  'Lupunamanta',
  'Supairunam',
  'Perambulando',
  'Caminho Firme',
  'Jardim das Flores',
  'Luz do Universo',
  'Conselheira do Rei',
  'Mestre Florêncio',
];
