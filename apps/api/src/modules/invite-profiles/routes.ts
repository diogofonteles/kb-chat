import {
  inviteProfileCreateSchema,
  inviteProfileListSchema,
  inviteProfileUpdateSchema,
  inviteProfileViewSchema,
  type InvitePreset,
  type InviteProfile,
  type InviteProfileView,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { RouteAccess } from '../auth/index.js';
import type { InviteProfilesService } from './invite-profiles-service.js';

const MASTER: RouteAccess = { master: true };

/** Every collection slug in the vault: a profile only grants those (as the people editor). */
type Topics = () => readonly string[];

/** What the access-levels module checks on a profile's levels (KBC-109). */
export interface ProfileLevelRules {
  /** BR-1, BR-5: 400 unless each level names a scaled collection the preset reaches. */
  assertPresetLevels(preset: InvitePreset): void;
  /** FR-4: the levels the profile keeps that no longer exist. */
  staleLevels(preset: InvitePreset): Record<string, string>;
}

interface ProfileRouteDeps {
  readonly profiles: InviteProfilesService;
  readonly topics: Topics;
  readonly levels?: ProfileLevelRules;
}

function assertPreset(deps: ProfileRouteDeps, preset?: InvitePreset) {
  assertKnownTopics(deps.topics, preset);
  if (!preset?.levels || Object.keys(preset.levels).length === 0) return;
  if (!deps.levels)
    throw new AppError('VALIDATION_FAILED', 'Levels are not available');
  deps.levels.assertPresetLevels(preset);
}

const viewOf = (
  deps: ProfileRouteDeps,
  profile: InviteProfile,
): InviteProfileView => ({
  ...profile,
  staleLevels: deps.levels?.staleLevels(profile.preset) ?? {},
});

function assertKnownTopics(topics: Topics, preset?: { topics: string[] }) {
  const known = new Set(topics());
  const unknown = (preset?.topics ?? []).filter((topic) => !known.has(topic));
  if (unknown.length > 0)
    throw new AppError('VALIDATION_FAILED', 'Unknown collection', {
      details: { topics: unknown },
    });
}
const params = z.object({ id: z.uuid() });

function registerReads(app: FastifyInstance, deps: ProfileRouteDeps) {
  const { profiles } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get(
    '/api/v1/invite-profiles',
    {
      config: { access: MASTER },
      schema: { response: { 200: inviteProfileListSchema } },
    },
    async () => ({ items: profiles.list().map((one) => viewOf(deps, one)) }),
  );
  routes.post(
    '/api/v1/invite-profiles',
    {
      config: { access: MASTER },
      schema: {
        body: inviteProfileCreateSchema,
        response: { 201: inviteProfileViewSchema },
      },
    },
    async (request, reply) => {
      assertPreset(deps, request.body.preset);
      const created = await profiles.create(request.body);
      return reply.code(201).send(viewOf(deps, created));
    },
  );
}

function registerWrites(app: FastifyInstance, deps: ProfileRouteDeps) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.put(
    '/api/v1/invite-profiles/:id',
    {
      config: { access: MASTER },
      schema: {
        params,
        body: inviteProfileUpdateSchema,
        response: { 200: inviteProfileViewSchema },
      },
    },
    async (request) => {
      assertPreset(deps, request.body.preset);
      return viewOf(
        deps,
        await deps.profiles.update(request.params.id, request.body),
      );
    },
  );
}

function registerDelete(app: FastifyInstance, profiles: InviteProfilesService) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.delete(
    '/api/v1/invite-profiles/:id',
    {
      config: { access: MASTER },
      schema: { params, response: { 204: z.undefined() } },
    },
    async (request, reply) => {
      await profiles.remove(request.params.id);
      return reply.code(204).send();
    },
  );
}

/** "Perfis de convite" (KBC-028): masters only. */
export const inviteProfilesRoutes =
  (deps: ProfileRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerReads(app, deps);
    registerWrites(app, deps);
    registerDelete(app, deps.profiles);
  };
