import {
  accessRequestSourceSchema,
  type AccessRequest,
  type RequestState,
} from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';

/** A refused person may ask again a day after the refusal (KBC-014 BR-7). */
export const REFUSAL_COOLDOWN_MS = 24 * 3600 * 1000;

export const storedRequestSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  source: accessRequestSourceSchema,
  /** The verified Google account of a Google request; null for the form. */
  sub: z.string().min(1).nullable(),
  picture: z.url().nullable(),
  status: z.enum(['pending', 'refused']),
  createdAt: z.iso.datetime(),
  refusedAt: z.iso.datetime().nullable(),
  refusedBy: z.string().nullable(),
});
export type StoredRequest = z.infer<typeof storedRequestSchema>;

export const requestsDocumentSchema = z.object({
  version: z.literal(1),
  requests: z.array(storedRequestSchema),
});
export type RequestsDocument = z.infer<typeof requestsDocumentSchema>;

/** What a new request says about the person. */
export type RequestDraft = Pick<
  StoredRequest,
  'email' | 'firstName' | 'lastName' | 'phone' | 'source' | 'sub' | 'picture'
>;

/** Whose request: by email, and by Google account when there is one. */
export interface Requester {
  readonly email: string;
  readonly sub?: string | null;
}

export interface RequestsChange<T> {
  readonly requests: readonly StoredRequest[];
  readonly result: T;
}

const belongsTo = (request: StoredRequest, who: Requester): boolean =>
  request.email === who.email.toLowerCase() ||
  (!!who.sub && request.sub === who.sub);

const retryAtOf = (request: StoredRequest): number =>
  Date.parse(request.refusedAt ?? request.createdAt) + REFUSAL_COOLDOWN_MS;

/** Where this person's own request stands; a refusal older than a day no longer counts. */
export function stateOf(
  requests: readonly StoredRequest[],
  who: Requester,
  now: number,
): RequestState {
  const mine = requests.find((r) => belongsTo(r, who));
  if (!mine) return { status: 'none' };
  if (mine.status === 'pending') return { status: 'pending' };
  const retryAt = retryAtOf(mine);
  return retryAt > now
    ? { status: 'refused', retryAt: new Date(retryAt).toISOString() }
    : { status: 'none' };
}

/** A new pending request; one already pending or refused less than a day ago is refused. */
export function addRequest(
  requests: readonly StoredRequest[],
  draft: RequestDraft,
  context: { readonly now: string; readonly newId: () => string },
): RequestsChange<StoredRequest> {
  const state = stateOf(requests, draft, Date.parse(context.now));
  if (state.status === 'pending')
    throw new AppError('ALREADY_REQUESTED', 'A request is already pending');
  if (state.status === 'refused')
    throw new AppError('REQUEST_COOLDOWN', 'Refused less than a day ago', {
      details: { retryAt: state.retryAt },
    });
  const request: StoredRequest = {
    ...draft,
    email: draft.email.toLowerCase(),
    id: context.newId(),
    status: 'pending',
    createdAt: context.now,
    refusedAt: null,
    refusedBy: null,
  };
  const others = requests.filter((r) => !belongsTo(r, draft));
  return { requests: [...others, request], result: request };
}

function pendingOf(requests: readonly StoredRequest[], id: string) {
  const request = requests.find((r) => r.id === id && r.status === 'pending');
  if (!request) throw new AppError('NOT_FOUND', 'No pending request');
  return request;
}

/** Approval takes the request out; the person it becomes lives in people.json. */
export function takePending(
  requests: readonly StoredRequest[],
  id: string,
): RequestsChange<StoredRequest> {
  const request = pendingOf(requests, id);
  return { requests: requests.filter((r) => r.id !== id), result: request };
}

/** A refusal stays a day, so the same person cannot ask again at once (BR-7). */
export function refuseRequest(
  requests: readonly StoredRequest[],
  refusal: { readonly id: string; readonly by: string },
  now: string,
): RequestsChange<StoredRequest> {
  const request = pendingOf(requests, refusal.id);
  const refused: StoredRequest = {
    ...request,
    status: 'refused',
    refusedAt: now,
    refusedBy: refusal.by,
  };
  return {
    requests: requests.map((r) => (r.id === refusal.id ? refused : r)),
    result: refused,
  };
}

export const toAccessRequest = (request: StoredRequest): AccessRequest => ({
  id: request.id,
  email: request.email,
  firstName: request.firstName,
  lastName: request.lastName,
  phone: request.phone,
  source: request.source,
  createdAt: request.createdAt,
});
