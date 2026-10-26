import { z } from 'zod';
import { personAiSchema, personAiUpdateSchema } from './ai-access.js';
import { codeChannelSchema } from './access.js';
import { topicSlugSchema } from './topics.js';

/**
 * What a person may use (KBC-010): search the documents, research with AI, build or extend
 * a collection (KBC-009) and keep their own AI settings and keys.
 */
export const FEATURES = [
  'search',
  'research',
  'collection-builder',
  'own-ai-settings',
] as const;
export const featureSchema = z.enum(FEATURES);
export type Feature = z.infer<typeof featureSchema>;

/** A master grants and revokes collections, features and the master role itself. */
export const roleSchema = z.enum(['master', 'member']);
export type Role = z.infer<typeof roleSchema>;

/** What a new invite gets (BR-3): search, on no collection. */
export const DEFAULT_INVITE_FEATURES: readonly Feature[] = ['search'];

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
  /** Which app AI serves the person and their limits (KBC-022). */
  ai: personAiSchema,
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
  })
  .partial();
export type PersonUpdate = z.infer<typeof personUpdateSchema>;
