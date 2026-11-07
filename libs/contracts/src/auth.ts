import { z } from 'zod';
import { MEDIA_MAX_QUOTA_BYTES } from './media.js';
import {
  DEFAULT_PERSON_AI,
  personAiSchema,
  personAiUpdateSchema,
} from './ai-access.js';
import { codeChannelSchema } from './access.js';
import { initialPreferencesSchema } from './settings.js';
import { topicSlugSchema } from './topics.js';

/**
 * What a person may use (KBC-010): search the documents, research with AI, build or extend
 * a collection (KBC-009), keep their own AI settings and keys, listen to the media of the
 * collections they see and upload audio to them (KBC-034), create collections and
 * sub-collections (KBC-048), edit recordings (`media-edit`), ask the app's AI to propose
 * their tracks (`media-edit-ai`, KBC-067, ADR 0029 §9), use the media library (KBC-051),
 * see who speaks in a recording (`media-speakers`, KBC-065) and navigate a recording by its
 * approved tracks (`media-tracks`, KBC-066). Every feature is granted per
 * person (owner's rule, 2026-10-28): a new feature never comes on for everyone by itself.
 * Voice profiles (`media-voice-profiles`, KBC-071, ADR 0032) stay with masters, see below.
 */
export const FEATURES = [
  'search',
  'research',
  'collection-builder',
  'own-ai-settings',
  'media',
  'media-upload',
  'collection-create',
  'media-edit',
  'media-edit-ai',
  /** "Biblioteca de mídia" (KBC-051 BR-1): needs `media` as well. */
  'media-library',
  'media-speakers',
  'media-tracks',
  /** "Classificar mídia por assunto" (KBC-069, ADR 0029 §9). */
  'media-classify',
  /** "Assuntos na mídia" (KBC-070): subjects in search and library, on top of `media-tracks`. */
  'media-subjects',
  /** "Cadastrar perfis de voz": biometric data, see MASTER_ONLY_FEATURES. */
  'media-voice-profiles',
  /**
   * "Pesquisar faixas com IA" (KBC-099, ADR 0035 §5): the research tools see the tracks of the
   * collection, on top of `research` and `media`.
   */
  'media-research',
] as const;
export const featureSchema = z.enum(FEATURES);
export type Feature = z.infer<typeof featureSchema>;

/**
 * Features that stay with the master role (ADR 0032): a master has them like any other, and
 * a member cannot hold them, whatever a list or a preset says.
 */
export const MASTER_ONLY_FEATURES: readonly Feature[] = [
  'media-voice-profiles',
];

/** What being a master gives by itself (KBC-010 BR-3). */
export const MASTER_FEATURES: readonly Feature[] = FEATURES;

/** What is granted to one person, and what a stored list or a preset can hold. */
export const GRANTABLE_FEATURES: readonly Feature[] = FEATURES.filter(
  (feature) => !MASTER_ONLY_FEATURES.includes(feature),
);

/** A master grants and revokes collections, features and the master role itself. */
export const roleSchema = z.enum(['master', 'member']);
export type Role = z.infer<typeof roleSchema>;

/** What a new invite gets (BR-3): search, on no collection. */
export const DEFAULT_INVITE_FEATURES: readonly Feature[] = ['search'];

/** A person's media quota, in bytes (KBC-035 BR-1). */
export const mediaQuotaSchema = z
  .number()
  .int()
  .positive()
  .max(MEDIA_MAX_QUOTA_BYTES);

/** The header every state-changing request carries (CSRF, ADR 0008). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'kb-chat';

/**
 * GET /api/v1/auth/config: the public Google client id the web signs in with, where a
 * one-time sign-in code can go (KBC-014: `sms` only with a provider) and the contact the
 * public privacy policy names for data requests (KBC-016: the owner's email, from config).
 */
export const authConfigSchema = z.object({
  googleClientId: z.string().min(1).nullable(),
  codeChannels: z.array(codeChannelSchema),
  // Defaults to null so a web newer than its API still reads the config.
  privacyContactEmail: z.email().nullable().default(null),
});
export type AuthConfig = z.infer<typeof authConfigSchema>;

/** POST /api/v1/auth/google: the ID token (JWT) Google Identity Services handed the web. */
export const googleLoginRequestSchema = z.object({
  credential: z.string().min(20).max(8192),
});
export type GoogleLoginRequest = z.infer<typeof googleLoginRequestSchema>;

/* ---------- Acting as a person (KBC-060, ADR 0027) ---------- */

/**
 * Sent with every write: whose view the tab shows (`self`, or the id of the person a master
 * acts as). A write from a tab whose view the session no longer has answers VIEW_CHANGED,
 * so an old tab never writes as the wrong person.
 */
export const VIEW_HEADER = 'x-kb-chat-view';
export const OWN_VIEW = 'self';

/** POST /api/v1/people/:id/act-as: why the master acts as this person (kept in the audit). */
export const actAsRequestSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});
export type ActAsRequest = z.infer<typeof actAsRequestSchema>;

/** Someone in the act-as audit, by name and e-mail at the time. */
export const auditPersonSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
});

/** The person a master is acting as, on `GET /me` and the answer to start. */
export const actingSchema = z.object({
  person: auditPersonSchema,
  /** The master who acts (the real signed-in account). */
  actor: auditPersonSchema,
  reason: z.string(),
  startedAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  /** What is left by the server's clock when it answered (the browser's may differ). */
  remainingMs: z.number().int().min(0),
});
export type Acting = z.infer<typeof actingSchema>;

/** One line of the act-as audit (append-only, kept 12 months). */
export const actAsAuditEntrySchema = z.object({
  at: z.iso.datetime(),
  /** One acting session: its start, writes and end share it. */
  actingId: z.uuid().optional(),
  /** `refused`: a write audited before it ran, then refused (it changed nothing). */
  kind: z.enum(['start', 'end', 'write', 'refused']),
  actor: auditPersonSchema,
  person: auditPersonSchema,
  reason: z.string(),
  /** A write: the method and the route pattern (never the body). */
  method: z.string().optional(),
  route: z.string().optional(),
  /** An end: why it ended. */
  endedBy: z.enum(['actor', 'timeout', 'access']).optional(),
});
export type ActAsAuditEntry = z.infer<typeof actAsAuditEntrySchema>;

/** GET /api/v1/act-as/audit: newest first. */
export const actAsAuditListSchema = z.object({
  items: z.array(actAsAuditEntrySchema),
});

/** GET /api/v1/me/accesses: each time someone acted as the person (BR-7). */
export const myAccessSchema = z.object({
  actorName: z.string(),
  actorEmail: z.email(),
  reason: z.string(),
  startedAt: z.iso.datetime(),
  /** Null while it goes on. */
  endedAt: z.iso.datetime().nullable(),
  writes: z.number().int().min(0),
});
export type MyAccess = z.infer<typeof myAccessSchema>;
export const myAccessListSchema = z.object({ items: z.array(myAccessSchema) });

/** GET /api/v1/me: who is signed in and what they may see (FR-2). */
export const meSchema = z.object({
  email: z.email(),
  name: z.string(),
  picture: z.url().nullable(),
  role: roleSchema,
  /** Effective features: a master has all of them. */
  features: z.array(featureSchema),
  /** Visible collection slugs: a master sees every collection. */
  topics: z.array(topicSlugSchema),
  /** The account in KB_CHAT_OWNER_EMAIL: the only one that may use the subscriptions. */
  isOwner: z.boolean(),
  /** The server has the media library on (KB_CHAT_MEDIA, ADR 0022). */
  media: z.boolean(),
  /** The account may act as another person (KBC-060): the owner, and masters it grants. */
  canActAs: z.boolean().default(false),
  /** Set while a master acts as this person: everything above is the person's. */
  actingAs: actingSchema.nullable().default(null),
});
export type Me = z.infer<typeof meSchema>;

export const personIdSchema = z.uuid();

/**
 * The last invitation e-mail to a person (KBC-026): when one went out and when the last
 * attempt failed (null after a success). "Ativo" comes from `lastLoginAt`, not from here.
 */
export const invitationSchema = z.object({
  sentAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/** A person as masters see them on "Pessoas e permissões" (FR-3). */
export const personSchema = z.object({
  id: personIdSchema,
  email: z.email(),
  /** Empty until their first sign-in. */
  name: z.string(),
  picture: z.url().nullable(),
  role: roleSchema,
  topics: z.array(topicSlugSchema),
  features: z.array(featureSchema),
  isOwner: z.boolean(),
  /** E.164, from an access request (KBC-014); null for invites. */
  phone: z.string().nullable(),
  /** The invitation e-mail (KBC-026); null when none was sent (opted out, or before KBC-026). */
  invitation: invitationSchema.nullable().default(null),
  invitedBy: z.string(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
  /** Preferences set in the invitation (KBC-028), until the person saves their own. */
  initialPreferences: initialPreferencesSchema.optional(),
  /** May act as another person (KBC-060): set by the owner, master by master. */
  canActAs: z.boolean().default(false),
  /** Their converted space in bytes (KBC-035 BR-1); null: the default. Unused for the owner. */
  mediaQuotaBytes: mediaQuotaSchema.nullable().optional(),
  /** Which app AI serves the person and their limits (KBC-022); an older API sends none. */
  ai: personAiSchema.default(() => ({
    ...DEFAULT_PERSON_AI,
    paidFallback: { ...DEFAULT_PERSON_AI.paidFallback },
    history: [],
  })),
});
export type Person = z.infer<typeof personSchema>;

export const personListSchema = z.object({ items: z.array(personSchema) });
export type PersonList = z.infer<typeof personListSchema>;

/** POST /api/v1/people. */
export const inviteRequestSchema = z.object({
  email: z.email().max(254),
  /** KBC-026: false is "Não enviar e-mail de convite"; older clients keep sending. */
  sendEmail: z.boolean().default(true),
});
export type InviteRequest = z.input<typeof inviteRequestSchema>;

/** The `details` of a 429 on POST /api/v1/people/:id/invitation (KBC-026 BR-3). */
export const invitationLimitSchema = z.object({ retryAt: z.iso.datetime() });

/** PATCH /api/v1/people/:id: what a master changes; missing fields stay. */
export const personUpdateSchema = z
  .object({
    role: roleSchema,
    topics: z.array(topicSlugSchema).max(500),
    features: z.array(featureSchema).max(FEATURES.length),
    ai: personAiUpdateSchema,
    /** Only the owner may change it (KBC-060 BR-1). */
    canActAs: z.boolean(),
    /** null goes back to the default (KBC-035 BR-1). */
    mediaQuotaBytes: mediaQuotaSchema.nullable(),
  })
  .partial();
export type PersonUpdate = z.infer<typeof personUpdateSchema>;
