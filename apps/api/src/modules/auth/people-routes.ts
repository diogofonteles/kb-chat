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
  // Lending in the invitation is the owner's alone, as in the editor (KBC-031 BR-1).
  assertMayLend(deps, request, chosen?.ai.appAi);
  const invited = await deps.people.invite(email, inviter.email, chosen);
  // The house follows the AI it was given (provisioned keys), as after the editor; if it
  // cannot, the invitation is undone so that inviting again works.
  if (chosen)
    await deps.ai?.sync(invited, aiOf(invited)).catch(async (err: unknown) => {
      await deps.people
        .revoke(invited.id)
        .catch(() => request.log.error('could not undo a failed invitation'));
      throw err;
    });
  return sendEmail
    ? deps.invitations.afterInvite(invited, inviter, request.log)
    : invited;
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
    async (request) => {
      const { params, body } = request;
      // "Ver como outra pessoa" is the owner's to give (KBC-060 BR-1).
      if (body.canActAs !== undefined && !viewerOf(request).isOwner)
        throw new AppError(
          'FORBIDDEN',
          'Only the owner grants acting as a person',
        );
      assertKnownTopics(deps, body.topics);
      assertMayLend(deps, request, body.ai?.appAi);
      const by = viewerOf(request).person.email;
      const before = await deps.people.find(params.id);
      assertMayChangeLent(deps, request, { before, ai: body.ai });
      const updated = await deps.people.update(params.id, body, by);
      if (body.ai && before)
        await syncAi(deps, { before, updated, by, log: request.log });
      return view(deps, updated);
    },
  );
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
  const { profileId } = target;
  const { presets } = deps;
  if (!presets) throw new AppError('NOT_FOUND', 'Unknown invite profile');
  const preset = presets.presetFor({ profileId });
  const before = await deps.people.find(target.id);
  if (!preset || !before) throw new AppError('NOT_FOUND', 'Not found');
  assertKnownTopics(deps, preset.topics);
  const by = viewerOf(request).person.email;
  assertMayChangeLent(deps, request, { before, ai: preset.ai });
  const updated = await deps.people.applyPreset(before.id, preset, {
    by,
    withPreferences: !(await presets.hasSavedSettings(before)),
  });
  // The whole profile goes back when the house cannot follow its AI.
  await syncAi(deps, { before, updated, by, log: request.log }).catch(
    async (err: unknown) => {
      await deps.people
        .restore(before)
        .catch(() => request.log.error('could not undo a profile'));
      throw err;
    },
  );
  return updated;
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
