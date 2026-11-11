import { z } from 'zod';
import {
  mediaIdSchema,
  separationVersionSchema,
  transcriberPresenceSchema,
  voiceIndexSchema,
} from './media.js';

/**
 * Voice profiles with consent (KBC-071, ADR 0032). A voice print is sensitive personal data
 * (LGPD art. 5º, II): it travels only between the API and a transcriber marked for it, in the
 * contracts of voice-prints.ts. Nothing the browser reads has a field for it.
 */

/** The only purpose a consent can name (BR-1). */
export const VOICE_CONSENT_PURPOSE = 'suggest-names-when-editing' as const;
/** The version of the consent text on screen, kept with each consent. */
export const VOICE_CONSENT_TEXT_VERSION = 2;
/** Speech a profile needs, in total, from its source voices. */
export const MIN_PROFILE_SPEECH_MS = 30_000;
/** At most this many source voices in one profile. */
export const MAX_PROFILE_SOURCES = 10;
/** An attached document, before base64. */
export const MAX_CONSENT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** The body of the route that takes the document (base64 grows it by a third). */
export const MAX_VOICE_PROFILE_BODY_BYTES = 8 * 1024 * 1024;
export const CONSENT_ATTACHMENT_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

/** Living person, or a deceased one whose work has someone who answers for it (BR-1). */
export const VOICE_SUBJECTS = ['living', 'deceased'] as const;
export const voiceSubjectSchema = z.enum(VOICE_SUBJECTS);
export type VoiceSubject = z.infer<typeof voiceSubjectSchema>;

/** How the authorisation was given. */
export const VOICE_CONSENT_METHODS = [
  'signed-paper',
  'signed-digital',
  'email',
] as const;
export const voiceConsentMethodSchema = z.enum(VOICE_CONSENT_METHODS);
export type VoiceConsentMethod = z.infer<typeof voiceConsentMethodSchema>;

const textEvidenceSchema = z.strictObject({
  kind: z.literal('text'),
  text: z.string().trim().min(10).max(20_000),
});
const attachmentEvidenceSchema = z.strictObject({
  kind: z.literal('attachment'),
  fileName: z.string().trim().min(1).max(200),
  mime: z.enum(CONSENT_ATTACHMENT_MIMES),
  /** The document, in base64. */
  data: z
    .base64()
    .min(4)
    .max(Math.ceil((MAX_CONSENT_ATTACHMENT_BYTES * 4) / 3) + 4),
});
export const voiceConsentEvidenceSchema = z.discriminatedUnion('kind', [
  textEvidenceSchema,
  attachmentEvidenceSchema,
]);
export type VoiceConsentEvidence = z.infer<typeof voiceConsentEvidenceSchema>;

/**
 * A consent as registered by a master (FR-1): who, when, how, for what, and the proof. For a
 * deceased person the one who authorises answers for the work, and says in what capacity.
 */
export const voiceConsentSchema = z
  .strictObject({
    subject: voiceSubjectSchema,
    grantedBy: z.string().trim().min(2).max(120),
    /** In what capacity, for a deceased person: "Herdeira", "Presidente da instituição". */
    grantedByRole: z.string().trim().min(2).max(120).nullable(),
    grantedOn: z.iso.date(),
    method: voiceConsentMethodSchema,
    purpose: z.literal(VOICE_CONSENT_PURPOSE),
    textVersion: z.literal(VOICE_CONSENT_TEXT_VERSION),
    evidence: voiceConsentEvidenceSchema,
  })
  .refine((c) => c.subject === 'living' || c.grantedByRole !== null, {
    error: 'a deceased person needs who answers for the work',
    path: ['grantedByRole'],
  });
export type VoiceConsent = z.infer<typeof voiceConsentSchema>;

export const voiceSourceSchema = z.strictObject({
  mediaId: mediaIdSchema,
  voice: voiceIndexSchema,
});
export type VoiceSource = z.infer<typeof voiceSourceSchema>;

/**
 * POST /api/v1/topics/:topic/voice-profiles. `consent` is read by the service, so that a
 * missing or invalid one is the 422 of FR-1 and never reaches the rest of the request.
 */
export const createVoiceProfileRequestSchema = z.strictObject({
  speakerId: z.uuid(),
  sources: z.array(voiceSourceSchema).min(1).max(MAX_PROFILE_SOURCES),
  consent: z.unknown().optional(),
});
export type CreateVoiceProfileRequest = z.infer<
  typeof createVoiceProfileRequestSchema
>;

/** Where a profile is: being calculated, usable, or to be calculated again. */
export const VOICE_PROFILE_STATUSES = [
  'calculating',
  'ready',
  'failed',
] as const;
export const voiceProfileStatusSchema = z.enum(VOICE_PROFILE_STATUSES);
export type VoiceProfileStatus = z.infer<typeof voiceProfileStatusSchema>;

/** A profile as the screen shows it: the print itself is never here (BR-5). */
export const voiceProfileSchema = z.object({
  id: z.uuid(),
  speakerId: z.uuid(),
  speakerName: z.string().min(1),
  status: voiceProfileStatusSchema,
  sourceCount: z.number().int().min(0),
  grantedBy: z.string().min(1),
  grantedOn: z.iso.date(),
  createdAt: z.iso.datetime(),
});
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

/**
 * What the screen must tell about the revocation list (ADR 0032): `lost` and `exposed` stop
 * new prints, `behind` is a revocation that took effect and is not written on it yet.
 */
export const VOICE_REVOCATION_LIST_STATES = [
  'ok',
  'lost',
  'exposed',
  'behind',
] as const;
export type VoiceRevocationListState =
  (typeof VOICE_REVOCATION_LIST_STATES)[number];

export const voiceProfileListSchema = z.object({
  items: z.array(voiceProfileSchema),
  /** A transcriber marked for voice profiles is on, off, or none is marked. */
  transcriber: transcriberPresenceSchema,
  revocationList: z.enum(VOICE_REVOCATION_LIST_STATES),
});
export type VoiceProfileList = z.infer<typeof voiceProfileListSchema>;

/** A voice a person already named as this speaker: what a profile can be made from. */
export const namedVoiceSchema = z.object({
  mediaId: mediaIdSchema,
  title: z.string().min(1),
  voice: voiceIndexSchema,
  speakingMs: z.number().int().min(0),
});
export type NamedVoice = z.infer<typeof namedVoiceSchema>;

export const namedVoiceListSchema = z.object({
  items: z.array(namedVoiceSchema),
});

/** One consent in the report (FR-5), revoked or not. */
export const voiceConsentEntrySchema = z.object({
  id: z.uuid(),
  speakerName: z.string().min(1),
  collection: z.string().min(1),
  subject: voiceSubjectSchema,
  grantedBy: z.string().min(1),
  grantedByRole: z.string().min(1).nullable(),
  grantedOn: z.iso.date(),
  method: voiceConsentMethodSchema,
  purpose: z.literal(VOICE_CONSENT_PURPOSE),
  textVersion: z.number().int().min(1),
  registeredBy: z.string().min(1),
  registeredAt: z.iso.datetime(),
  evidence: z.enum(['text', 'attachment']),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: z.string().min(1).nullable(),
  suggestions: z.object({
    made: z.number().int().min(0),
    accepted: z.number().int().min(0),
    refused: z.number().int().min(0),
  }),
});
export type VoiceConsentEntry = z.infer<typeof voiceConsentEntrySchema>;

/** GET /api/v1/voice-profiles/report: "Perfis e consentimentos", for the owner (AC-8). */
export const voiceProfileReportSchema = z.object({
  items: z.array(voiceConsentEntrySchema),
});
export type VoiceProfileReport = z.infer<typeof voiceProfileReportSchema>;

/** POST /api/v1/media/:id/voices/:voice/suggestion: a person always decides (AC-2). */
export const decideVoiceSuggestionRequestSchema = z.strictObject({
  version: separationVersionSchema,
  decision: z.enum(['accept', 'refuse']),
});
export type DecideVoiceSuggestionRequest = z.infer<
  typeof decideVoiceSuggestionRequestSchema
>;
