import {
  DEFAULT_INVITE_FEATURES,
  FEATURES,
  type PersonUpdate,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { VerifiedIdentity } from '../../ports/identity-verifier.js';
import { isMaster, type StoredPerson } from './person.js';

/** The pure rules of "Pessoas e permissões" (BR-2, BR-3); the service persists their result. */

export interface PeopleChange<T> {
  readonly people: readonly StoredPerson[];
  readonly result: T;
}

interface RuleContext {
  readonly ownerEmail: string | undefined;
  readonly now: string;
}

const isOwnerEmail = (person: StoredPerson, ownerEmail?: string): boolean =>
  ownerEmail !== undefined && person.email === ownerEmail;

const replace = (
  people: readonly StoredPerson[],
  next: StoredPerson,
): StoredPerson[] => people.map((p) => (p.id === next.id ? next : p));

/** The owner's account is always there and always a master (ADR 0008). */
export function ensureOwner(
  people: readonly StoredPerson[],
  context: RuleContext & { readonly newId: () => string },
): readonly StoredPerson[] {
  const { ownerEmail, now } = context;
  if (!ownerEmail) return people;
  const owner = people.find((p) => isOwnerEmail(p, ownerEmail));
  if (owner)
    return isMaster(owner)
      ? people
      : replace(people, { ...owner, role: 'master' });
  const created: StoredPerson = {
    id: context.newId(),
    sub: null,
    email: ownerEmail,
    name: '',
    picture: null,
    role: 'master',
    topics: [],
    features: [...FEATURES],
    invitedBy: 'KB_CHAT_OWNER_EMAIL',
    createdAt: now,
    lastLoginAt: null,
  };
  return [...people, created];
}

/** Matches a verified Google account: by `sub`, else an invite for its e-mail (binds `sub`). */
export function signIn(
  people: readonly StoredPerson[],
  identity: VerifiedIdentity,
  now: string,
): PeopleChange<StoredPerson> {
  const known =
    people.find((p) => p.sub === identity.sub) ??
    people.find((p) => p.email === identity.email && p.sub === null);
  if (!known) throw new AppError('NOT_INVITED', 'This account was not invited');
  const signedIn: StoredPerson = {
    ...known,
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
    lastLoginAt: now,
  };
  return { people: replace(people, signedIn), result: signedIn };
}

export function invite(
  people: readonly StoredPerson[],
  request: { readonly email: string; readonly invitedBy: string },
  context: { readonly now: string; readonly newId: () => string },
): PeopleChange<StoredPerson> {
  const email = request.email.toLowerCase();
  if (people.some((p) => p.email === email))
    throw new AppError('ALREADY_INVITED', 'This e-mail is already invited');
  const invited: StoredPerson = {
    id: context.newId(),
    sub: null,
    email,
    name: '',
    picture: null,
    role: 'member',
    topics: [],
    features: [...DEFAULT_INVITE_FEATURES],
    invitedBy: request.invitedBy,
    createdAt: context.now,
    lastLoginAt: null,
  };
  return { people: [...people, invited], result: invited };
}

/** What an approved access request carries over to the person (KBC-014 BR-6). */
export interface ApprovedRequest {
  readonly email: string;
  readonly name: string;
  readonly phone: string | null;
  /** A Google request binds its account at once. */
  readonly sub: string | null;
  readonly picture: string | null;
  readonly approvedBy: string;
}

export function approve(
  people: readonly StoredPerson[],
  approved: ApprovedRequest,
  context: { readonly now: string; readonly newId: () => string },
): PeopleChange<StoredPerson> {
  const { sub, approvedBy, ...rest } = approved;
  const { people: withInvite, result } = invite(
    people,
    { email: approved.email, invitedBy: approvedBy },
    context,
  );
  if (sub !== null && people.some((p) => p.sub === sub))
    throw new AppError('ALREADY_INVITED', 'This account already has access');
  const person: StoredPerson = {
    ...result,
    ...rest,
    email: result.email,
    sub,
    // A form person has no Google account: the id is their principal from now on.
    ...(sub === null && { principal: result.id }),
  };
  return { people: replace(withInvite, person), result: person };
}

/** The first code sign-in fixes whose data this is, so a later Google link keeps it. */
export function codeSignIn(
  people: readonly StoredPerson[],
  id: string,
  now: string,
): PeopleChange<StoredPerson> {
  const person = find(people, id);
  const signedIn: StoredPerson = {
    ...person,
    principal: person.principal ?? person.sub ?? person.id,
    lastLoginAt: now,
  };
  return { people: replace(people, signedIn), result: signedIn };
}

function find(people: readonly StoredPerson[], id: string): StoredPerson {
  const person = people.find((p) => p.id === id);
  if (!person) throw new AppError('NOT_FOUND', 'Unknown person');
  return person;
}

/** At least one master always remains (BR-3); then the owner's account stays a master. */
function guardMasterLoss(
  people: readonly StoredPerson[],
  target: StoredPerson,
  ownerEmail: string | undefined,
): void {
  if (!isMaster(target)) return;
  if (people.filter(isMaster).length <= 1)
    throw new AppError('LAST_MASTER', 'At least one master must remain');
  if (isOwnerEmail(target, ownerEmail))
    throw new AppError('OWNER_PROTECTED', 'The owner stays a master');
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export function update(
  people: readonly StoredPerson[],
  change: { readonly id: string; readonly patch: PersonUpdate },
  ownerEmail: string | undefined,
): PeopleChange<StoredPerson> {
  const { id, patch } = change;
  const target = find(people, id);
  if (patch.role === 'member') guardMasterLoss(people, target, ownerEmail);
  const next: StoredPerson = {
    ...target,
    role: patch.role ?? target.role,
    topics: patch.topics ? unique(patch.topics) : target.topics,
    features: patch.features ? unique(patch.features) : target.features,
  };
  return { people: replace(people, next), result: next };
}

export function revoke(
  people: readonly StoredPerson[],
  id: string,
  ownerEmail: string | undefined,
): PeopleChange<StoredPerson> {
  const target = find(people, id);
  guardMasterLoss(people, target, ownerEmail);
  if (isOwnerEmail(target, ownerEmail))
    throw new AppError('OWNER_PROTECTED', 'The owner cannot be removed');
  return { people: people.filter((p) => p.id !== id), result: target };
}
