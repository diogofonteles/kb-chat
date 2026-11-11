import { randomUUID } from 'node:crypto';
import {
  featureSchema,
  inviteProfileSchema,
  type InvitationPreset,
  type InvitePreset,
  type InviteProfile,
  type InviteProfileCreate,
  type InviteProfileUpdate,
  inviteProfileCreateSchema,
  inviteProfileUpdateSchema,
} from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { DocumentStorePort } from '../../ports/document-store.js';

/** invite-profiles.json (KBC-028). */
const documentSchema = z.object({
  version: z.literal(1).default(1),
  profiles: z.array(inviteProfileSchema).default([]),
});

const rawProfilesSchema = z
  .object({
    profiles: z.array(
      z
        .object({
          preset: z.object({ features: z.array(z.string()) }).loose(),
        })
        .loose(),
    ),
  })
  .loose();

const isKnownFeature = (name: string) => featureSchema.safeParse(name).success;

/**
 * The file without the feature names this image does not know (a newer image wrote them),
 * and those names, to warn about: as people.json since KBC-107, a profile still loads.
 */
function withKnownFeatures(raw: unknown): {
  readonly raw: unknown;
  readonly unknown: string[];
} {
  const parsed = rawProfilesSchema.safeParse(raw);
  if (!parsed.success) return { raw, unknown: [] };
  const names = parsed.data.profiles.flatMap((one) => one.preset.features);
  const profiles = parsed.data.profiles.map((one) => ({
    ...one,
    preset: {
      ...one.preset,
      features: one.preset.features.filter(isKnownFeature),
    },
  }));
  const unknown = [...new Set(names.filter((name) => !isKnownFeature(name)))];
  return { raw: { ...parsed.data, profiles }, unknown };
}

/** No levels is no key: a profile without levels reads in an older image (KBC-109). */
function compact(preset: InvitePreset): InvitePreset {
  if (preset.levels && Object.keys(preset.levels).length > 0) return preset;
  const { levels, ...rest } = preset;
  return levels ? rest : preset;
}
type ProfilesDocument = z.infer<typeof documentSchema>;

export interface InviteProfilesDeps {
  readonly store: DocumentStorePort;
  readonly newId?: () => string;
  readonly warn?: (message: string) => void;
}

/** Only one default (BR-3): marking one clears the others. */
const withDefault = (
  profiles: readonly InviteProfile[],
  id: string,
): InviteProfile[] =>
  profiles.map((profile) => ({ ...profile, isDefault: profile.id === id }));

/**
 * Reusable invitation presets (KBC-028): "Aluno", "Pesquisador", one of them the default. A
 * small JSON document in the state folder, written atomically, one change at a time.
 */
export class InviteProfilesService {
  private document: ProfilesDocument = { version: 1, profiles: [] };
  private writing: Promise<unknown> = Promise.resolve();
  /** An unreadable file is never overwritten: someone fixes it first (it holds the profiles). */
  private invalid = false;

  constructor(private readonly deps: InviteProfilesDeps) {}

  async load(): Promise<void> {
    const { raw, unknown } = withKnownFeatures(
      (await this.deps.store.read()) ?? {},
    );
    if (unknown.length > 0)
      this.deps.warn?.(
        `invite-profiles.json names features this version does not know; they are ignored: ${unknown.join(', ')}`,
      );
    const parsed = documentSchema.safeParse(raw);
    this.invalid = !parsed.success;
    if (this.invalid)
      this.deps.warn?.(
        'invite-profiles.json is invalid; profiles are off and the file is kept as it is',
      );
    this.document = parsed.success ? parsed.data : { version: 1, profiles: [] };
  }

  list(): readonly InviteProfile[] {
    return this.document.profiles;
  }

  find(id: string): InviteProfile {
    const profile = this.document.profiles.find((p) => p.id === id);
    if (!profile) throw new AppError('NOT_FOUND', 'Unknown invite profile');
    return profile;
  }

  /** The preset an invitation uses: the one sent, the profile named, the default, or none. */
  presetFor(request: {
    readonly preset?: InvitationPreset;
    readonly profileId?: string;
  }): InvitationPreset | undefined {
    if (request.preset) return request.preset;
    if (request.profileId) return this.find(request.profileId).preset;
    return this.document.profiles.find((p) => p.isDefault)?.preset;
  }

  async create(input: InviteProfileCreate): Promise<InviteProfile> {
    const { name, preset, isDefault } = inviteProfileCreateSchema.parse(input);
    const profile: InviteProfile = {
      id: this.deps.newId?.() ?? randomUUID(),
      name,
      preset: compact(preset),
      isDefault: false,
    };
    await this.change((profiles) => {
      const next = [...profiles, profile];
      return isDefault ? withDefault(next, profile.id) : next;
    });
    return this.find(profile.id);
  }

  async update(id: string, input: InviteProfileUpdate): Promise<InviteProfile> {
    const patch = inviteProfileUpdateSchema.parse(input);
    this.find(id);
    await this.change((profiles) => {
      const next = profiles.map((profile) =>
        profile.id === id
          ? {
              ...profile,
              ...(patch.name !== undefined && { name: patch.name }),
              ...(patch.preset !== undefined && {
                preset: compact(patch.preset),
              }),
              ...(patch.isDefault === false && { isDefault: false }),
            }
          : profile,
      );
      return patch.isDefault ? withDefault(next, id) : next;
    });
    return this.find(id);
  }

  /** Deleting the default leaves the house without one (BR-3). */
  async remove(id: string): Promise<void> {
    this.find(id);
    await this.change((profiles) => profiles.filter((p) => p.id !== id));
  }

  private change(
    apply: (profiles: readonly InviteProfile[]) => InviteProfile[],
  ): Promise<void> {
    if (this.invalid)
      return Promise.reject(
        new AppError('INTERNAL', 'invite-profiles.json is invalid'),
      );
    const run = this.writing.then(async () => {
      const next: ProfilesDocument = {
        version: 1,
        profiles: apply(this.document.profiles),
      };
      await this.deps.store.write(next);
      this.document = next;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }
}
