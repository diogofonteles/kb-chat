import { z } from 'zod';
import { phoneSchema } from './phone.js';

/** KBC-014 (ADR 0011): access requests, sign-up without Google and one-time codes. */

/** Six digits, sent by email or SMS. */
export const CODE_LENGTH = 6;
export const oneTimeCodeSchema = z
  .string()
  .regex(/^\d{6}$/, { error: 'The code has 6 digits' });

/** Where a one-time code goes; SMS only when a provider is configured (BR-9). */
export const CODE_CHANNELS = ['email', 'sms'] as const;
export const codeChannelSchema = z.enum(CODE_CHANNELS);
export type CodeChannel = z.infer<typeof codeChannelSchema>;

const emailSchema = z.email().max(254);
const nameSchema = z.string().trim().min(1).max(80);

/** POST /api/v1/access-requests/signup: the form of "Pedir acesso sem conta Google". */
export const signUpRequestSchema = z.object({
  email: emailSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  phone: phoneSchema,
});
export type SignUpRequest = z.input<typeof signUpRequestSchema>;

/** POST /api/v1/access-requests/signup/verify: the code that confirms the email (BR-2). */
export const signUpVerifySchema = z.object({
  email: emailSchema,
  code: oneTimeCodeSchema,
});
export type SignUpVerify = z.infer<typeof signUpVerifySchema>;

/** POST /api/v1/access-requests/google: the ticket of a not-invited Google sign-in. */
export const googleAccessRequestSchema = z.object({
  ticket: z.string().min(20).max(4096),
  phone: phoneSchema.optional(),
});
export type GoogleAccessRequest = z.input<typeof googleAccessRequestSchema>;

/** The answer to a new request: it waits for a master. */
export const accessRequestCreatedSchema = z.object({
  status: z.literal('pending'),
});

/** 202 of every send: the same body whatever the account (BR-3). */
export const acceptedSchema = z.object({});

export const accessRequestSourceSchema = z.enum(['form', 'google']);
export type AccessRequestSource = z.infer<typeof accessRequestSourceSchema>;

/** A pending request as masters see it in "Solicitações pendentes". */
export const accessRequestSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  source: accessRequestSourceSchema,
  createdAt: z.iso.datetime(),
});
export type AccessRequest = z.infer<typeof accessRequestSchema>;

export const accessRequestListSchema = z.object({
  items: z.array(accessRequestSchema),
});
export type AccessRequestList = z.infer<typeof accessRequestListSchema>;

/** Where a person's own request stands (shown to a verified Google identity only). */
export const requestStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('refused'), retryAt: z.iso.datetime() }),
]);
export type RequestState = z.infer<typeof requestStateSchema>;

/** `details` of 403 NOT_INVITED on a Google sign-in: the ticket for "Solicitar acesso". */
export const notInvitedDetailsSchema = z.object({
  ticket: z.string(),
  request: requestStateSchema,
});
export type NotInvitedDetails = z.infer<typeof notInvitedDetailsSchema>;

/** POST /api/v1/auth/code: an email (or a phone, for SMS) that should get a sign-in code. */
export const codeRequestSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  channel: codeChannelSchema,
});
export type CodeRequest = z.infer<typeof codeRequestSchema>;

/** POST /api/v1/auth/code/verify. */
export const codeVerifySchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  code: oneTimeCodeSchema,
});
export type CodeVerify = z.infer<typeof codeVerifySchema>;
