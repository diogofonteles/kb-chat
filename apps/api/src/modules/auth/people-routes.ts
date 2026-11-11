import {
  applyProfileRequestSchema,
  presetInviteRequestSchema,
  type InvitationPreset,
  aiAssignmentRequestSchema,
  aiAssignmentResultSchema,
  defaultableAppAiSchema,
  isLentSubscription,
  type AppAiAssignment,
  type DefaultableAppAi,
  type PersonAiUpdate,
  type PersonAi,
  personIdSchema,
  personListSchema,
  personSchema,
  personUpdateSchema,
  type PersonUpdate,
} from '@kb-chat/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { viewerOf, type RouteAccess } from './access.js';
import type { Invitations } from './invitations.js';
import type { PeopleService } from './people-service.js';
import {
  assertPersonLevels,
  assertPresetLevels,
  recordLevels,
  serialLevels,
  undoneProfile,
  withGrantedLevels,
  withLevels,
  type PersonLevelRules,
} from './people-level-writes.js';
import { aiOf } from './person-ai.js';
import { toPerson, type StoredPerson } from './person.js';
import type { SessionService } from './session-service.js';

export interface PeopleRouteDeps {
  readonly people: PeopleService;
  readonly sessions: SessionService;
  /** Every collection slug in the vault: a grant must name one. */
  readonly topics: () => readonly string[];
  /** The invitation e-mail sent on invite (KBC-026). */
  readonly invitations: Invitations;
  /** What the house AI does around a person's AI change (KBC-022); none in tests. */
  readonly ai?: PeopleAiHooks;
  /** Invitation presets (KBC-028); absent, invitations are plain. */
  readonly presets?: PresetSource;
  /** A person's level per scaled collection (KBC-103 FR-3); absent: none can be set. */
  readonly levels?: PersonLevelRules;
}

/** Where the people routes find a preset (KBC-028), and whether a person saved Settings. */
export interface PresetSource {
  presetFor(request: {
    readonly preset?: InvitationPreset;
    readonly profileId?: string;
  }): InvitationPreset | undefined;
  /** The person saved their own preferences: a profile's ones never replace them (BR-6). */
  hasSavedSettings(person: StoredPerson): Promise<boolean>;
}

/** The house side of the AI access policy, called by the people routes (KBC-022). */
export interface PeopleAiHooks {
  /** After a person's AI was saved: e.g. provision or drop their OpenRouter key; throws on failure. */
  sync(person: StoredPerson, ai: PersonAi): Promise<void>;
  /** "Também para os próximos": the default for people left on `default`. */
  setDefault(appAi: DefaultableAppAi, by: string): Promise<void>;
}

const MASTER: RouteAccess = { master: true };

const ownerOnly = () =>
  new AppError('FORBIDDEN', 'Only the owner lends his subscription');

/** Only the owner lends his subscription; any master may take it back (KBC-024 BR-1). */
function assertMayLend(
  deps: PeopleRouteDeps,
  request: FastifyRequest,
  appAi: AppAiAssignment | undefined,
) {
  if (appAi === undefined || !isLentSubscription(appAi)) return;
  if (!deps.people.isOwner(viewerOf(request).person)) throw ownerOnly();
}

/**
 * On a person lent the subscription, how much they use it (quota, "sempre", paid fallback) is
 * the owner's call too; revoking stays open to any master (KBC-024 F-4).
 */
function assertMayChangeLent(
  deps: PeopleRouteDeps,
  request: FastifyRequest,
  change: { before: StoredPerson | null; ai: PersonAiUpdate | undefined },
) {
  const { before, ai } = change;
  if (!before || !ai || !isLentSubscription(aiOf(before).appAi)) return;
  const revokes = ai.appAi !== undefined && !isLentSubscription(ai.appAi);
  if (revokes || deps.people.isOwner(viewerOf(request).person)) return;
  throw ownerOnly();
}
const params = z.object({ id: personIdSchema });

const view = (deps: PeopleRouteDeps, person: StoredPerson) =>
  toPerson(person, deps.people.isOwner(person));

function assertKnownTopics(deps: PeopleRouteDeps, topics?: readonly string[]) {
  const known = new Set(deps.topics());
  const unknown = (topics ?? []).filter((topic) => !known.has(topic));
  if (unknown.length > 0)
    throw new AppError('VALIDATION_FAILED', 'Unknown collection', {
      details: { topics: unknown },
    });
}

function registerReads(app: FastifyInstance, deps: PeopleRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/people',
    {
      config: { access: MASTER },
      schema: { response: { 200: personListSchema } },
    },
    async () => ({
      items: (await deps.people.list()).map((person) => view(deps, person)),
    }),
  );
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/people',
    {
      config: { access: MASTER },
      schema: {
        body: presetInviteRequestSchema,
        response: { 201: personSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(view(deps, await invite(deps, request, request.body))),
  );
}

async function invite(
  deps: PeopleRouteDeps,
  request: FastifyRequest,
  body: z.infer<typeof presetInviteRequestSchema>,
): Promise<StoredPerson> {
  const inviter = viewerOf(request).person;
  const { email, sendEmail, preset, profileId } = body;
  const chosen = deps.presets?.presetFor({ preset, profileId });
  if (chosen) assertKnownTopics(deps, chosen.topics);
  // A preset sent is checked; a profile's level that no longer exists is the lowest (BR-3).
  if (preset) assertPresetLevels(deps.levels, preset);
  // Lending in the invitation is the owner's alone, as in the editor (KBC-031 BR-1).
  assertMayLend(deps, request, chosen?.ai.appAi);
  // Resolved and written in the levels queue, so a first scale never slips between (R1-6).
  const { invited, leveled } = await serialLevels(deps.levels, async () => {
    const leveled = chosen && withLevels(deps.levels, chosen);
    const invited = await deps.people.invite(email, inviter.email, leveled);
    if (leveled?.levels)
      await recordLevels(deps.levels, {
        before: { ...invited, levels: {} },
        after: invited,
        by: inviter.email,
        via: 'invite',
        log: request.log,
      });
    return { invited, leveled };
  });
  if (leveled) await followInvitedAi(deps, invited, request.log);
  return sendEmail
    ? deps.invitations.afterInvite(invited, inviter, request.log)
    : invited;
}

/**
 * The house follows the AI it was given (provisioned keys), as after the editor; if it
 * cannot, the invitation is undone so that inviting again works.
 */
async function followInvitedAi(
  deps: PeopleRouteDeps,
  invited: StoredPerson,
  log: FastifyBaseLogger,
): Promise<void> {
  await deps.ai?.sync(invited, aiOf(invited)).catch(async (err: unknown) => {
    // Whatever happens to the undo, the client gets the AI's failure (R3-3).
    await undoInvitation(deps, { invited, log }).catch((undo: unknown) =>
      log.error(
        { err: undo, person: invited.id },
        'could not undo a failed invitation; it stays',
      ),
    );
    throw err;
  });
}

/** The invitation is revoked and, when it gave levels, their removal audited (QA-r2-2). */
async function undoInvitation(
  deps: PeopleRouteDeps,
  undo: { readonly invited: StoredPerson; readonly log: FastifyBaseLogger },
): Promise<void> {
  const { invited, log } = undo;
  await serialLevels(deps.levels, async () => {
    // As it is now (a bulk may have moved it while the AI was called, R3-2).
    const now = (await deps.people.find(invited.id)) ?? invited;
    const revoked = await deps.people.revoke(invited.id).then(
      () => true,
      (err: unknown) => {
        log.error(
          { err, person: invited.id },
          'could not undo a failed invitation',
        );
        return false;
      },
    );
    if (!revoked) return;
    await recordLevels(deps.levels, {
      before: now,
      after: { ...now, levels: {} },
      by: invited.invitedBy,
      via: 'invite',
      log,
      message: 'invitation undone but its levels not audited',
    }).catch(() => undefined);
  });
}

/** Everything a master's change must pass before anything is written. */
function assertPatch(
  deps: PeopleRouteDeps,
  request: FastifyRequest,
  body: z.infer<typeof personUpdateSchema>,
): void {
  // "Ver como outra pessoa" is the owner's to give (KBC-060 BR-1).
  if (body.canActAs !== undefined && !viewerOf(request).isOwner)
    throw new AppError('FORBIDDEN', 'Only the owner grants acting as a person');
  assertKnownTopics(deps, body.topics);
  assertMayLend(deps, request, body.ai?.appAi);
}

function registerPatch(app: FastifyInstance, deps: PeopleRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/api/v1/people/:id',
    {
      config: { access: MASTER },
      schema: {
        params,
        body: personUpdateSchema,
        response: { 200: personSchema },
      },
    },
    async (request) =>
      view(
        deps,
        await patchPerson(deps, request, {
          id: request.params.id,
          body: request.body,
        }),
      ),
  );
}

async function patchPerson(
  deps: PeopleRouteDeps,
  request: FastifyRequest,
  change: { readonly id: string; readonly body: PersonUpdate },
): Promise<StoredPerson> {
  const { id, body } = change;
  assertPatch(deps, request, body);
  const by = viewerOf(request).person.email;
  // The person before, the levels and their audit, in the levels queue (R1-6, QA-2).
  const { before, updated } = await serialLevels(deps.levels, async () => {
    const before = await deps.people.find(id);
    assertPersonLevels(deps.levels, {
      role: body.role ?? before?.role,
      levels: body.levels,
    });
    assertMayChangeLent(deps, request, { before, ai: body.ai });
    const patch = withGrantedLevels(deps.levels, before, body);
    const updated = await deps.people.update(id, patch, by);
    // A grant, a level, or a master's levels dropped (R2-2): each change is a line.
    if (before)
      await recordLevels(deps.levels, {
        ...{ before, after: updated, by, via: 'editor' as const },
        log: request.log,
      });
    return { before, updated };
  });
  if (body.ai && before)
    await syncAi(deps, { before, updated, by, log: request.log });
  return updated;
}

/** "Aplicar perfil" (KBC-028 FR-4): a profile on someone already invited. */
function registerApplyProfile(app: FastifyInstance, deps: PeopleRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/people/:id/profile',
    {
      config: { access: MASTER },
      schema: {
        params,
        body: applyProfileRequestSchema,
        response: { 200: personSchema },
      },
    },
    async (request) =>
      view(
        deps,
        await applyProfile(deps, request, {
          id: request.params.id,
          profileId: request.body.profileId,
        }),
      ),
  );
}

async function applyProfile(
  deps: PeopleRouteDeps,
  request: FastifyRequest,
  target: { readonly id: string; readonly profileId: string },
): Promise<StoredPerson> {
  const { presets } = deps;
  if (!presets) throw new AppError('NOT_FOUND', 'Unknown invite profile');
  const profile = presets.presetFor({ profileId: target.profileId });
  if (!profile) throw new AppError('NOT_FOUND', 'Not found');
  assertKnownTopics(deps, profile.topics);
  const by = viewerOf(request).person.email;
  const log = request.log;
  const { before, updated } = await serialLevels(deps.levels, async () => {
    const before = await deps.people.find(target.id);
    if (!before) throw new AppError('NOT_FOUND', 'Not found');
    // Only the collections the profile reaches change level (KBC-109 BR-2); a master held
    // none to keep (R2-2).
    const held = before.role === 'master' ? {} : before.levels;
    const preset = withLevels(deps.levels, profile, held);
    assertMayChangeLent(deps, request, { before, ai: preset.ai });
    const updated = await deps.people.applyPreset(before.id, preset, {
      by,
      withPreferences: !(await presets.hasSavedSettings(before)),
    });
    const record = { before, after: updated, by, via: 'profile' as const };
    await recordLevels(deps.levels, { ...record, log });
    return { before, updated };
  });
  await followProfileAi(deps, { before, updated, by, log });
  return updated;
}

/** The whole profile goes back when the house cannot follow its AI, its levels audited. */
async function followProfileAi(deps: PeopleRouteDeps, change: AiSyncChange) {
  await syncAi(deps, change).catch(async (err: unknown) => {
    // The client always gets the AI's failure; a failed undo is told in the log (R3-3).
    await undoProfile(deps, change).catch((undo: unknown) =>
      change.log.error(
        { err: undo, person: change.before.id },
        'could not undo a profile; it stays applied',
      ),
    );
    throw err;
  });
}

/**
 * Undoes the profile in its own turn of the levels queue (R2-1): the person is read again, a
 * level written meanwhile (a bulk) stays, and the line starts from what is there now. A
 * failed undo and an undo whose audit failed are told apart.
 */
async function undoProfile(deps: PeopleRouteDeps, change: AiSyncChange) {
  const { before, updated, by, log } = change;
  await serialLevels(deps.levels, async () => {
    const now = await deps.people.find(before.id);
    if (!now) return;
    const restored = await deps.people
      .restore(undoneProfile({ before, applied: updated, now }))
      .catch((err: unknown) => {
        log.error({ err, person: before.id }, 'could not undo a profile');
        return null;
      });
    if (!restored) return;
    await recordLevels(deps.levels, {
      ...{ before: now, after: restored, by, via: 'profile' as const },
      log,
      message: 'profile undone but its levels not audited',
    }).catch(() => undefined);
  });
}

function registerWrites(app: FastifyInstance, deps: PeopleRouteDeps) {
  registerPatch(app, deps);
  registerApplyProfile(app, deps);
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/api/v1/people/:id',
    {
      config: { access: MASTER },
      schema: { params, response: { 204: z.undefined() } },
    },
    async ({ params: { id } }, reply) => {
      await deps.people.revoke(id);
      // BR-4: the revoked person's open sessions end now.
      await deps.sessions.destroyFor(id);
      return reply.code(204).send();
    },
  );
}

/**
 * Lets the house follow a saved AI change (provisioned keys). When that fails, the whole
 * AI part goes back, so no person is left half changed (review fix).
 */
interface AiSyncChange {
  readonly before: StoredPerson;
  readonly updated: StoredPerson;
  readonly by: string;
  readonly log: FastifyBaseLogger;
}

async function syncAi(deps: PeopleRouteDeps, change: AiSyncChange) {
  if (!deps.ai) return;
  try {
    await deps.ai.sync(change.updated, aiOf(change.updated));
  } catch (err) {
    await undoAi(deps, change);
    throw err;
  }
}

/** The whole AI part goes back; a failed undo is logged and never hides the first error. */
async function undoAi(deps: PeopleRouteDeps, change: AiSyncChange) {
  const { appAi, enforced, dailyResearches, paidFallback } = aiOf(
    change.before,
  );
  const ai = { appAi, enforced, dailyResearches, paidFallback };
  await deps.people
    .update(change.updated.id, { ai }, change.by)
    .catch((undo: unknown) =>
      change.log.error(
        {
          person: change.updated.id,
          kind: undo instanceof Error ? undo.name : 'unknown',
        },
        'could not undo a failed AI change',
      ),
    );
}

/** One app AI for several people or everyone, optionally the default too (KBC-022 AC-12). */
function registerAssignment(app: FastifyInstance, deps: PeopleRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/people/ai-assignment',
    {
      config: { access: MASTER },
      schema: {
        body: aiAssignmentRequestSchema,
        response: { 200: aiAssignmentResultSchema },
      },
    },
    async (request) => {
      const { personIds, appAi, setDefault, subscriptionTermsAccepted } =
        request.body;
      assertMayLend(deps, request, appAi);
      const by = viewerOf(request).person.email;
      const updated = await deps.people.assignAi(
        { ids: personIds, appAi, subscriptionTermsAccepted },
        by,
      );
      // The contract allows setDefault only with "all" and an AI that may be a default.
      const asDefault = defaultableAppAiSchema.safeParse(appAi);
      if (setDefault && asDefault.success)
        await deps.ai?.setDefault(asDefault.data, by);
      return { updated };
    },
  );
}

/** "Pessoas e permissões" (FR-3): masters only. */
export const peopleRoutes =
  (deps: PeopleRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerReads(app, deps);
    registerWrites(app, deps);
    registerAssignment(app, deps);
  };
