import type { VoicePrintVaultPort } from '../../ports/voice-print-vault.js';
import type { VoiceProfileStorePort } from '../../ports/voice-profile-store.js';
import type { VoiceRevocationListPort } from '../../ports/voice-revocation-list.js';

export interface VoicePrintReconcilerDeps {
  readonly profiles: Pick<
    VoiceProfileStorePort,
    'ids' | 'get' | 'report' | 'revoke'
  >;
  readonly prints: Pick<
    VoicePrintVaultPort,
    'ids' | 'remove' | 'removeUnfinished'
  >;
  readonly revocations: VoiceRevocationListPort;
  readonly now?: () => Date;
}

/** What a start found and fixed; nothing here names a person. */
export interface Reconciled {
  readonly reapplied: number;
  readonly orphans: number;
  readonly unfinished: number;
  readonly listLost: boolean;
}

/** Stands for the person in a reapplied revocation: the list keeps ids and nothing else. */
export const REAPPLIED_BY = 'lista de revogações';

/**
 * Puts things right when the API starts (KBC-071 BR-2, ADR 0032), after a restored backup or
 * a crash: a revocation the media database no longer has counts again, and no print, finished
 * or not, stays without its profile.
 */
export class VoicePrintReconciler {
  private readonly now: () => Date;

  constructor(private readonly deps: VoicePrintReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async reconcile(): Promise<Reconciled> {
    const { revocations, profiles, prints } = this.deps;
    const list = await revocations.read();
    const neverUsed = !list.complete && profiles.report().length === 0;
    if (neverUsed) await revocations.start();
    const reapplied = await this.reapply(list.ids);
    const orphans = await this.dropOrphans();
    const unfinished = await prints.removeUnfinished();
    return {
      reapplied,
      orphans,
      unfinished,
      listLost: !list.complete && !neverUsed,
    };
  }

  private async reapply(ids: readonly string[]): Promise<number> {
    const { profiles, prints } = this.deps;
    const back = ids.filter((id) => profiles.get(id) !== null);
    for (const profileId of back) {
      await prints.remove(profileId);
      profiles.revoke({ profileId, by: REAPPLIED_BY, now: this.now() });
    }
    return back.length;
  }

  private async dropOrphans(): Promise<number> {
    const { profiles, prints } = this.deps;
    const known = new Set(profiles.ids());
    const orphans = (await prints.ids()).filter((id) => !known.has(id));
    await Promise.all(orphans.map((id) => prints.remove(id)));
    return orphans.length;
  }
}
