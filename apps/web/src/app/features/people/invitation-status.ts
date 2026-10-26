import { HttpErrorResponse } from '@angular/common/http';
import {
  apiErrorSchema,
  invitationLimitSchema,
  type Person,
} from '@kb-chat/contracts';

/** What a person's row says about their access (KBC-026 FR-5). */
export type InvitationState =
  | { readonly kind: 'active'; readonly at: string }
  | { readonly kind: 'sent'; readonly at: string }
  | { readonly kind: 'failed'; readonly at: string }
  | { readonly kind: 'none' };

/** "Ativo" after the first sign-in (BR-5); before it, the last invitation e-mail. */
export function invitationStateOf(person: Person): InvitationState {
  if (person.lastLoginAt) return { kind: 'active', at: person.lastLoginAt };
  const { failedAt, sentAt } = person.invitation ?? {};
  if (failedAt) return { kind: 'failed', at: failedAt };
  if (sentAt) return { kind: 'sent', at: sentAt };
  return { kind: 'none' };
}

/** When a resend refused by the limit may go (BR-3), or null for any other failure. */
export function invitationLimitOf(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse) || err.status !== 429) return null;
  const envelope = apiErrorSchema.safeParse(err.error);
  if (!envelope.success) return null;
  const details = invitationLimitSchema.safeParse(envelope.data.error.details);
  return details.success ? details.data.retryAt : null;
}
