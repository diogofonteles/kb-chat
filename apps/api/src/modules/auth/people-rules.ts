import type { Feature, InvitationPreset } from '@kb-chat/contracts';
import {
  DEFAULT_INVITE_FEATURES,
  MASTER_FEATURES,
  MASTER_GRANT_ONLY_FEATURES,
  type Invitation,
  type PersonUpdate,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { VerifiedIdentity } from '../../ports/identity-verifier.js';
import { aiOf, applyAiUpdate, type AiChangeContext } from './person-ai.js';
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
    features: [...MASTER_FEATURES],
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

/** The outcome of the last invitation e-mail (KBC-026). */
export function recordInvitation(
  people: readonly StoredPerson[],
  id: string,
  invitation: Invitation,
): PeopleChange<StoredPerson> {
  const next: StoredPerson = { ...find(people, id), invitation };
  return { people: replace(people, next), result: next };
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
  change: {
    readonly id: string;
    readonly patch: PersonUpdate;
    readonly context: AiChangeContext;
  },
  ownerEmail: string | undefined,
): PeopleChange<StoredPerson> {
  const { id, patch } = change;
  const target = find(people, id);
  if (patch.role === 'member') guardMasterLoss(people, target, ownerEmail);
  const role = patch.role ?? target.role;
  const next: StoredPerson = {
    ...target,
    role,
    topics: patch.topics ? unique(patch.topics) : target.topics,
    features: heldFeatures(
      role,
      patch.features ? unique(patch.features) : target.features,
    ),
    ...(patch.ai && {
      ai: applyAiUpdate(aiOf(target), patch.ai, change.context),
    }),
    // Only a master may hold it; losing the role takes it away (KBC-060 BR-1).
    canActAs: role === 'master' && (patch.canActAs ?? target.canActAs ?? false),
  };
  return { people: replace(people, next), result: next };
}

/** A grant by name holds for a master only: kept off a member, it cannot wake on a promotion. */
const heldFeatures = (
  role: StoredPerson['role'],
  features: readonly Feature[],
): Feature[] =>
  role === 'master' ? [...features] : features.filter(notGrantedByName);

/** A preset never gives what must be granted to one master by name (ADR 0032). */
const notGrantedByName = (feature: Feature): boolean =>
  !MASTER_GRANT_ONLY_FEATURES.includes(feature);

/** What applying a preset changes (KBC-028): access and AI, and maybe the first preferences. */
export interface PresetChange {
  readonly id: string;
  readonly preset: InvitationPreset;
  readonly context: AiChangeContext;
  /** False for someone who saved their own preferences: theirs stay (BR-6). */
  readonly withPreferences: boolean;
}

/** Sets a preset on a person, as the editor would (the AI change goes to the audit trail). */
export function applyPreset(
  people: readonly StoredPerson[],
  change: PresetChange,
  ownerEmail: string | undefined,
): PeopleChange<StoredPerson> {
  const { preset } = change;
  const updated = update(
    people,
    {
      id: change.id,
      patch: {
        role: preset.role,
        topics: preset.topics,
        features: preset.features.filter(notGrantedByName),
        ai: preset.ai,
      },
      context: change.context,
    },
    ownerEmail,
  );
  if (!change.withPreferences) return updated;
  // The profile's preferences replace the earlier ones, none included (KBC-028 review).
  const hasPreferences = Object.keys(preset.preferences).length > 0;
  const next: StoredPerson = {
    ...updated.result,
    initialPreferences: hasPreferences ? preset.preferences : undefined,
  };
  return { people: replace(updated.people, next), result: next };
}

/** The person as they were (same id); they must still be there. */
export function restore(
  people: readonly StoredPerson[],
  before: StoredPerson,
): PeopleChange<StoredPerson> {
  find(people, before.id);
  return { people: replace(people, before), result: before };
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
