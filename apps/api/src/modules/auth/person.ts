import {
  DEFAULT_PERSON_AI,
  FEATURES,
  personAiSchema,
  featureSchema,
  initialPreferencesSchema,
  invitationSchema,
  roleSchema,
  topicSlugSchema,
  type Feature,
  type Me,
  type Person,
} from '@kb-chat/contracts';
import { z } from 'zod';

/**
 * The owner's principal (ADR 0008): the alias every local file already uses, so the owner's
 * history, settings, spend and usage stay where they are after the first Google sign-in.
 * Everyone else's principal is their Google `sub`.
 */
export const OWNER_PRINCIPAL = 'owner';

export const storedPersonSchema = z.object({
  id: z.uuid(),
  /** Bound on the first sign-in. */
  sub: z.string().min(1).nullable(),
  email: z.email(),
  name: z.string(),
  picture: z.url().nullable(),
  role: roleSchema,
  topics: z.array(topicSlugSchema),
  features: z.array(featureSchema),
  invitedBy: z.string(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
  /** E.164, from an access request (KBC-014); a sign-in code may go to it by SMS. */
  phone: z.string().nullable().optional(),
  /** The last invitation e-mail (KBC-026); absent before KBC-026 or when none was sent. */
  invitation: invitationSchema.optional(),
  /**
   * Whose data, once fixed (ADR 0011): a form approval or the first code sign-in sets it,
   * so linking Google later keeps the same history. Absent: the Google `sub`, else the id.
   */
  principal: z.string().min(1).optional(),
  /** Which app AI serves the person and their limits (KBC-022); absent: the house default. */
  ai: personAiSchema.optional(),
  /** Set in the invitation (KBC-028): the person's Settings until they save their own. */
  initialPreferences: initialPreferencesSchema.optional(),
});
export type StoredPerson = z.infer<typeof storedPersonSchema>;

export const peopleDocumentSchema = z.object({
  version: z.literal(1),
  people: z.array(storedPersonSchema),
});
export type PeopleDocument = z.infer<typeof peopleDocumentSchema>;

/** The signed-in person of a request, filled by the auth guard. */
export interface Viewer {
  readonly person: StoredPerson;
  /** Whose data: OWNER_PRINCIPAL for the owner, else the Google `sub`. */
  readonly principal: string;
  readonly isOwner: boolean;
}

export const isMaster = (person: StoredPerson): boolean =>
  person.role === 'master';

/** A master has every feature (BR-3). */
export const effectiveFeatures = (person: StoredPerson): Feature[] =>
  isMaster(person) ? [...FEATURES] : [...person.features];

export const hasFeature = (person: StoredPerson, feature: Feature): boolean =>
  isMaster(person) || person.features.includes(feature);

/** Exact slug match; a master sees every collection. */
export const canSeeTopic = (person: StoredPerson, topic: string): boolean =>
  isMaster(person) || person.topics.includes(topic);

export const visibleTopics = (
  person: StoredPerson,
  allTopics: readonly string[],
): string[] => allTopics.filter((topic) => canSeeTopic(person, topic));

/** What `toMe` needs from the server: every collection slug and whether media is on. */
export interface MeScope {
  readonly topics: readonly string[];
  readonly media: boolean;
}

export function toMe(viewer: Viewer, scope: MeScope): Me {
  const { person } = viewer;
  return {
    email: person.email,
    name: person.name,
    picture: person.picture,
    role: person.role,
    features: effectiveFeatures(person),
    topics: visibleTopics(person, scope.topics),
    isOwner: viewer.isOwner,
    media: scope.media,
  };
}

export const toPerson = (person: StoredPerson, isOwner: boolean): Person => ({
  id: person.id,
  email: person.email,
  name: person.name,
  picture: person.picture,
  role: person.role,
  topics: person.topics,
  features: person.features,
  isOwner,
  phone: person.phone ?? null,
  invitation: person.invitation ?? null,
  invitedBy: person.invitedBy,
  createdAt: person.createdAt,
  lastLoginAt: person.lastLoginAt,
  ai: person.ai ?? DEFAULT_PERSON_AI,
  ...(person.initialPreferences && {
    initialPreferences: person.initialPreferences,
  }),
});
