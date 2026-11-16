import type { Routes, UrlMatcher, UrlSegment } from '@angular/router';

/**
 * /configuracoes and /configuracoes/<section> as one route (KBC-131 BR-5): moving between
 * sections keeps the page (and its scroll), only the `section` parameter changes.
 */
export const settingsMatcher: UrlMatcher = (segments: UrlSegment[]) => {
  const [first, section, ...rest] = segments;
  if (first?.path !== 'configuracoes' || rest.length > 0) return null;
  const posParams: Record<string, UrlSegment> = section ? { section } : {};
  return { consumed: segments, posParams };
};

export const SETTINGS_ROUTES: Routes = [
  {
    matcher: settingsMatcher,
    title: $localize`:@@route.settingsTitle:Configurações — Nova Alexandria`,
    loadComponent: () =>
      import('./settings-page.js').then((m) => m.SettingsPage),
  },
];
