import { z } from 'zod';

/** The most voices a separation finds or a person may announce (KBC-064 BR-4). */
export const MAX_VOICES = 10;

/** A voice of one recording: "Voz N", numbered by who speaks first; never a person. */
export const voiceIndexSchema = z.number().int().min(1).max(MAX_VOICES);
