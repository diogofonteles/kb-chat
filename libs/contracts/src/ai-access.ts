import { z } from 'zod';
import type { ResearchProfile } from './research.js';
import { lastTestSchema } from './settings.js';

/**
 * The AI access policy (KBC-022, ADR 0016): which app-owned AI serves each person, chosen by
 * a master. `house` is the app's OpenRouter account ("Plano da casa"); `claude-subscription`
 * and `chatgpt-subscription` the owner's subscriptions, lent person by person (KBC-024,
 * KBC-027; ADR 0019, ADR 0020); `none` leaves the person with their own AI or search only.
 */
export const APP_AIS = [
  'house',
  'claude-subscription',
  'chatgpt-subscription',
  'none',
] as const;
export const appAiSchema = z.enum(APP_AIS);
export type AppAi = z.infer<typeof appAiSchema>;

/** The subscriptions the owner lends; never a default (ADR 0019, ADR 0020). */
export const LENT_SUBSCRIPTIONS = [
  'claude-subscription',
  'chatgpt-subscription',
] as const;
export type LentSubscription = (typeof LENT_SUBSCRIPTIONS)[number];
export const isLentSubscription = (appAi: string): appAi is LentSubscription =>
  LENT_SUBSCRIPTIONS.some((subscription) => subscription === appAi);

/** What the house default may be: an app AI that is not a subscription. */
export const DEFAULTABLE_APP_AIS = ['house', 'none'] as const;
export const defaultableAppAiSchema = z.enum(DEFAULTABLE_APP_AIS);
export type DefaultableAppAi = z.infer<typeof defaultableAppAiSchema>;

/** A person's assignment: an app AI, or `default` (the house default). */
export const APP_AI_ASSIGNMENTS = ['default', ...APP_AIS] as const;
export const appAiAssignmentSchema = z.enum(APP_AI_ASSIGNMENTS);
export type AppAiAssignment = z.infer<typeof appAiAssignmentSchema>;

/** Researches a day on the house plan, per person. */
export const MAX_DAILY_RESEARCHES = 500;
export const dailyResearchesSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_DAILY_RESEARCHES);

/** The house default quota when the master sets none. */
export const DEFAULT_DAILY_RESEARCHES = 5;

/** How many researches each profile counts against the daily quota (ADR 0016). */
export const RESEARCH_WEIGHTS: Readonly<Record<ResearchProfile, number>> = {
  fast: 1,
  deep: 2,
  exhaustive: 5,
};

export const MAX_MONTHLY_CAP_USD = 100;

export const paidFallbackSchema = z.object({
  enabled: z.boolean(),
  monthlyCapUsd: z.number().min(0).max(MAX_MONTHLY_CAP_USD),
});
export type PaidFallback = z.infer<typeof paidFallbackSchema>;

/** One change of a person's AI access: who, when and what (the audit trail). */
export const aiAccessChangeSchema = z.object({
  appAi: appAiAssignmentSchema,
  enforced: z.boolean(),
  by: z.string(),
  at: z.iso.datetime(),
  /** Lending a subscription: the master confirmed its terms (KBC-024). */
  termsAccepted: z.boolean().optional(),
});
export type AiAccessChange = z.infer<typeof aiAccessChangeSchema>;

/** A person's AI access as masters see and edit it. */
export const personAiSchema = z.object({
  appAi: appAiAssignmentSchema,
  /** The assigned app AI serves the person even when they chose their own. */
  enforced: z.boolean(),
  /** null: the house default. */
  dailyResearches: dailyResearchesSchema.nullable(),
  paidFallback: paidFallbackSchema,
  /** Newest last; at most the last 50 changes. */
  history: z.array(aiAccessChangeSchema),
});
export type PersonAi = z.infer<typeof personAiSchema>;

export const DEFAULT_PERSON_AI: PersonAi = {
  appAi: 'default',
  enforced: false,
  dailyResearches: null,
  paidFallback: { enabled: false, monthlyCapUsd: 1 },
  history: [],
};

/** Lending a subscription needs the terms confirmed in the same request (ADR 0019). */
const termsConfirmed = (request: {
  appAi?: AppAiAssignment;
  subscriptionTermsAccepted?: boolean;
}): boolean =>
  request.appAi === undefined ||
  !isLentSubscription(request.appAi) ||
  request.subscriptionTermsAccepted === true;

const TERMS_ERROR = {
  path: ['subscriptionTermsAccepted'],
  error: 'Lending a subscription needs its terms confirmed',
};

/** PATCH /api/v1/people/:id `ai`: what a master changes; missing fields stay. */
export const personAiUpdateSchema = z
  .strictObject({
    appAi: appAiAssignmentSchema.optional(),
    enforced: z.boolean().optional(),
    dailyResearches: dailyResearchesSchema.nullable().optional(),
    paidFallback: paidFallbackSchema.optional(),
    /** Granting `claude-subscription`: the master confirmed the terms (KBC-024). */
    subscriptionTermsAccepted: z.literal(true).optional(),
  })
  .refine(termsConfirmed, TERMS_ERROR);
export type PersonAiUpdate = z.infer<typeof personAiUpdateSchema>;

/** POST /api/v1/people/ai-assignment: one, several or every person at once. */
export const aiAssignmentRequestSchema = z
  .strictObject({
    personIds: z.union([z.literal('all'), z.array(z.uuid()).min(1).max(1000)]),
    appAi: appAiAssignmentSchema,
    /** With "all" and an AI (not "default"): the default for people invited later too. */
    setDefault: z.boolean().default(false),
    /** Granting `claude-subscription`: the master confirmed the terms (KBC-024). */
    subscriptionTermsAccepted: z.literal(true).optional(),
  })
  .refine(
    (request) =>
      !request.setDefault ||
      (request.personIds === 'all' &&
        defaultableAppAiSchema.safeParse(request.appAi).success),
    {
      path: ['setDefault'],
      error:
        'The default changes only with "all" and an AI that is not a subscription',
    },
  )
  .refine(termsConfirmed, TERMS_ERROR);
export type AiAssignmentRequest = z.input<typeof aiAssignmentRequestSchema>;

export const aiAssignmentResultSchema = z.object({
  updated: z.number().int().nonnegative(),
});

/**
 * GET /api/v1/ai/status: what serves the signed-in person now and who pays. `app`: an AI the
 * administrator lends ("IA da aplicação"); `own`: the person's own ("Sua IA").
 */
export const aiStatusSchema = z.object({
  source: z.enum(['app', 'own', 'none']),
  /** The app AI serving them (source `app`), else null. */
  appAi: appAiSchema.nullable(),
  /** The provider id answering (e.g. "openrouter"), "stub" in tests, or null. */
  provider: z.string().nullable(),
  /** House plan only: researches left today and the daily quota. */
  remainingToday: z.number().int().nonnegative().nullable(),
  dailyResearches: z.number().int().nonnegative().nullable(),
  /** The master made the app AI win over the person's own. */
  enforced: z.boolean(),
  /** Own per-token AI: today's spend and the daily cap (KBC-023); null otherwise. */
  spentTodayUsd: z.number().nonnegative().nullable(),
  dailyCapUsd: z.number().nonnegative().nullable(),
  /** The serving AI costs nothing (house plan, own free models, Gemini free tier). */
  free: z.boolean(),
  /** The person's last connection test. */
  lastTest: lastTestSchema.nullable(),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

/** Which of the owner's subscriptions can be lent now (the CLI is ready on the server). */
export const lendableSchema = z.object({
  'claude-subscription': z.boolean(),
  'chatgpt-subscription': z.boolean(),
});
export type Lendable = z.infer<typeof lendableSchema>;
