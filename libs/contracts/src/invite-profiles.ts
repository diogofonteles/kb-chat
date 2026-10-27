import { z } from 'zod';
import {
  appAiAssignmentSchema,
  dailyResearchesSchema,
  isLentSubscription,
  paidFallbackSchema,
} from './ai-access.js';
import {
  DEFAULT_INVITE_FEATURES,
  FEATURES,
  featureSchema,
  inviteRequestSchema,
  roleSchema,
} from './auth.js';
import { initialPreferencesSchema } from './settings.js';
import { topicSlugSchema } from './topics.js';

/**
 * The app AI a preset may give (KBC-028 BR-2): the house plan, none or the default; the
 * owner's subscriptions are lent person by person, with the terms, never by a preset.
 */
const presetAppAiSchema = appAiAssignmentSchema.refine(
  (appAi) => !isLentSubscription(appAi),
  { error: 'A preset never lends a subscription' },
);

/** What a preset sets on the person's AI access (ADR 0016), all optional. */
export const presetAiSchema = z.strictObject({
  appAi: presetAppAiSchema.default('default'),
  enforced: z.boolean().default(false),
  dailyResearches: dailyResearchesSchema.nullable().default(null),
  paidFallback: paidFallbackSchema.default({
    enabled: false,
    monthlyCapUsd: 1,
  }),
});

/**
 * Everything an invitation can set up at once (KBC-028): role, collections, features, the
 * app AI and its limits, and the person's initial preferences.
 */
export const invitePresetSchema = z
  .strictObject({
    role: roleSchema.default('member'),
    topics: z.array(topicSlugSchema).max(500).default([]),
    features: z
      .array(featureSchema)
      .max(FEATURES.length)
      .default([...DEFAULT_INVITE_FEATURES]),
    ai: presetAiSchema.prefault({}),
    preferences: initialPreferencesSchema.prefault({}),
  })
  .refine(
    (preset) =>
      preset.preferences.defaultTopic === undefined ||
      preset.role === 'master' ||
      preset.topics.includes(preset.preferences.defaultTopic),
    {
      path: ['preferences', 'defaultTopic'],
      error: 'The default collection must be one of the collections granted',
    },
  );
export type InvitePreset = z.infer<typeof invitePresetSchema>;
export type InvitePresetInput = z.input<typeof invitePresetSchema>;

export const inviteProfileNameSchema = z.string().trim().min(1).max(60);

/** A reusable preset ("Aluno", "Pesquisador"); at most one is the default (BR-3). */
export const inviteProfileSchema = z.object({
  id: z.uuid(),
  name: inviteProfileNameSchema,
  preset: invitePresetSchema,
  isDefault: z.boolean(),
});
export type InviteProfile = z.infer<typeof inviteProfileSchema>;

export const inviteProfileListSchema = z.object({
  items: z.array(inviteProfileSchema),
});
export type InviteProfileList = z.infer<typeof inviteProfileListSchema>;

/** POST /api/v1/invite-profiles. */
export const inviteProfileCreateSchema = z.strictObject({
  name: inviteProfileNameSchema,
  preset: invitePresetSchema,
  isDefault: z.boolean().default(false),
});
export type InviteProfileCreate = z.input<typeof inviteProfileCreateSchema>;

/** PUT /api/v1/invite-profiles/:id: what changes; missing fields stay. */
export const inviteProfileUpdateSchema = z.strictObject({
  name: inviteProfileNameSchema.optional(),
  preset: invitePresetSchema.optional(),
  isDefault: z.boolean().optional(),
});
export type InviteProfileUpdate = z.input<typeof inviteProfileUpdateSchema>;

/**
 * POST /api/v1/people with a preset (KBC-028): the preset sent, else the profile named, else
 * the default profile, else the plain invitation.
 */
export const presetInviteRequestSchema = inviteRequestSchema
  .extend({
    preset: invitePresetSchema.optional(),
    profileId: z.uuid().optional(),
  })
  .refine((request) => !(request.preset && request.profileId), {
    path: ['profileId'],
    error: 'Send a preset or a profile, not both',
  });
export type PresetInviteRequest = z.input<typeof presetInviteRequestSchema>;

/** POST /api/v1/people/:id/profile: applies a profile to someone already invited. */
export const applyProfileRequestSchema = z.strictObject({
  profileId: z.uuid(),
});
