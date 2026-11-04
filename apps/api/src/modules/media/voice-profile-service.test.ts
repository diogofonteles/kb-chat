import { describe, expect, it, vi } from 'vitest';
import type { VoicePrintVaultPort } from '../../ports/voice-print-vault.js';
import type { VoiceProfileStorePort } from '../../ports/voice-profile-store.js';
import {
  VoiceProfileService,
  type VoiceProfileServiceDeps,
} from './voice-profile-service.js';

const serviceWith = (input: {
  profiles: readonly string[];
  prints: readonly string[];
}) => {
  const remove = vi.fn<VoicePrintVaultPort['remove']>(() => Promise.resolve());
  const service = new VoiceProfileService({
    profiles: { ids: () => [...input.profiles] } as VoiceProfileStorePort,
    prints: {
      ids: () => Promise.resolve([...input.prints]),
      remove,
    } as unknown as VoicePrintVaultPort,
  } as unknown as VoiceProfileServiceDeps);
  return { service, remove };
};

describe('VoiceProfileService.dropOrphanPrints (ADR 0032)', () => {
  it('removes a print with no profile, as after restoring an older backup', async () => {
    const { service, remove } = serviceWith({
      profiles: ['kept'],
      prints: ['kept', 'orphan'],
    });
    expect(await service.dropOrphanPrints()).toBe(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith('orphan');
  });

  it('touches nothing when every print has its profile', async () => {
    const { service, remove } = serviceWith({
      profiles: ['kept'],
      prints: ['kept'],
    });
    expect(await service.dropOrphanPrints()).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
});
