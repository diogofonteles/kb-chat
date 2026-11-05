import type { MediaSettingsPort } from '../../ports/media-settings.js';

const CAP_SETTING = 'monthly-cap-usd';

/**
 * The media monthly cap (ADR 0022 §7, KBC-037 BR-2): the one the owner set, or the
 * configured default (MEDIA_MONTHLY_CAP_USD). The media AI and Groq share it.
 */
export function monthlyCapOf(
  settings: MediaSettingsPort,
  defaultUsd: number,
): number {
  const saved = settings.get(CAP_SETTING);
  const value = saved ? Number(saved.value) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : defaultUsd;
}

export function saveMonthlyCap(
  settings: MediaSettingsPort,
  input: { readonly usd: number; readonly by: string; readonly now: Date },
): void {
  settings.set({
    key: CAP_SETTING,
    value: String(input.usd),
    by: input.by,
    now: input.now,
  });
}
