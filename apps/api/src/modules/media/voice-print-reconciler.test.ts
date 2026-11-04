import { describe, expect, it, vi } from 'vitest';
import type { StoredVoiceProfile } from '../../ports/voice-profile-store.js';
import type { VoiceRevocations } from '../../ports/voice-revocation-list.js';
import {
  REAPPLIED_BY,
  VoicePrintReconciler,
  type VoicePrintReconcilerDeps,
} from './voice-print-reconciler.js';

const AT = new Date('2026-11-04T12:00:00.000Z');
const WHOLE: VoiceRevocations = { ids: [], complete: true, startedAt: null };
const LOST: VoiceRevocations = { ...WHOLE, complete: false };

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
      oldestConsentAt: () =>
        (input.consents ?? 1) > 0 ? '2026-10-01T00:00:00.000Z' : null,
      revoke,
    },
    prints: {
      ids: () => Promise.resolve([...(input.prints ?? [])]),
      remove,
      removeUnfinished: () => Promise.resolve(0),
    },
    revocations: {
      add: () => Promise.resolve(),
      read: () => Promise.resolve(input.list ?? WHOLE),
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
      list: { ...WHOLE, ids: ['back', 'gone'] },
    });
    expect((await reconciler.reconcile()).reapplied).toBe(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith({
      profileId: 'back',
      by: REAPPLIED_BY,
      now: AT,
    });
    expect(remove).toHaveBeenCalledWith('back');
  });

  it('leaves the list of a library with no consent alone: a disk may be on its way back', async () => {
    const { reconciler, start } = reconcilerWith({ list: LOST, consents: 0 });
    expect((await reconciler.reconcile()).listLost).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('says the list is lost when consents exist without it, and never starts it', async () => {
    const { reconciler, start } = reconcilerWith({
      list: LOST,
      consents: 1,
    });
    expect((await reconciler.reconcile()).listLost).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('says the list is lost when it is younger than the consents', async () => {
    const { reconciler } = reconcilerWith({
      list: { ...WHOLE, startedAt: '2026-11-01T00:00:00.000Z' },
    });
    expect((await reconciler.reconcile()).listLost).toBe(true);
  });

  it('a list marked lost still reapplies the ids it has', async () => {
    const { reconciler, revoke } = reconcilerWith({
      profiles: ['back'],
      list: { ...LOST, ids: ['back'] },
    });
    await reconciler.reconcile();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
