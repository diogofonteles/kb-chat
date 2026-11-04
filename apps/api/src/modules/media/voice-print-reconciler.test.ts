import type { VoiceConsentEntry } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { StoredVoiceProfile } from '../../ports/voice-profile-store.js';
import type { VoiceRevocations } from '../../ports/voice-revocation-list.js';
import {
  REAPPLIED_BY,
  VoicePrintReconciler,
  type VoicePrintReconcilerDeps,
} from './voice-print-reconciler.js';

const AT = new Date('2026-11-04T12:00:00.000Z');

const reconcilerWith = (input: {
  profiles?: readonly string[];
  prints?: readonly string[];
  list?: VoiceRevocations;
  consents?: number;
}) => {
  const known = new Set(input.profiles ?? []);
  const revoke = vi.fn(({ profileId }: { profileId: string }) =>
    known.delete(profileId),
  );
  const remove = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
  const start = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const deps: VoicePrintReconcilerDeps = {
    profiles: {
      ids: () => [...known],
      get: (id) => (known.has(id) ? ({ id } as StoredVoiceProfile) : null),
      report: () =>
        Array.from(
          { length: input.consents ?? 1 },
          () => ({}) as VoiceConsentEntry,
        ),
      revoke,
    },
    prints: {
      ids: () => Promise.resolve([...(input.prints ?? [])]),
      remove,
      removeUnfinished: () => Promise.resolve(0),
    },
    revocations: {
      add: () => Promise.resolve(),
      read: () => Promise.resolve(input.list ?? { ids: [], complete: true }),
      start,
    },
    now: () => AT,
  };
  return {
    reconciler: new VoicePrintReconciler(deps),
    revoke,
    remove,
    start,
  };
};

describe('VoicePrintReconciler (ADR 0032)', () => {
  it('removes a print with no profile, as after restoring an older backup', async () => {
    const { reconciler, remove } = reconcilerWith({
      profiles: ['kept'],
      prints: ['kept', 'orphan'],
    });
    expect((await reconciler.reconcile()).orphans).toBe(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith('orphan');
  });

  it('touches nothing when every print has its profile', async () => {
    const { reconciler, remove, revoke } = reconcilerWith({
      profiles: ['kept'],
      prints: ['kept'],
    });
    expect(await reconciler.reconcile()).toEqual({
      reapplied: 0,
      orphans: 0,
      unfinished: 0,
      listLost: false,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('BR-2: revokes again a profile on the list that a restore brought back', async () => {
    const { reconciler, remove, revoke } = reconcilerWith({
      profiles: ['back', 'kept'],
      prints: ['back'],
      list: { ids: ['back', 'gone'], complete: true },
    });
    expect((await reconciler.reconcile()).reapplied).toBe(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith({
      profileId: 'back',
      by: REAPPLIED_BY,
      now: AT,
    });
    expect(remove).toHaveBeenCalledWith('back');
  });

  it('starts the list of a library with no consent yet', async () => {
    const { reconciler, start } = reconcilerWith({
      list: { ids: [], complete: false },
      consents: 0,
    });
    expect((await reconciler.reconcile()).listLost).toBe(false);
    expect(start).toHaveBeenCalledOnce();
  });

  it('says the list is lost when consents exist without it, and never starts it', async () => {
    const { reconciler, start } = reconcilerWith({
      list: { ids: [], complete: false },
      consents: 1,
    });
    expect((await reconciler.reconcile()).listLost).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('a list marked lost still reapplies the ids it has', async () => {
    const { reconciler, revoke } = reconcilerWith({
      profiles: ['back'],
      list: { ids: ['back'], complete: false },
    });
    await reconciler.reconcile();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
