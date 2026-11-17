import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';
import { THEMES, themeSchema, type Theme } from '@kb-chat/contracts';

export { THEMES, type Theme };

const STORAGE_KEY = 'kb-chat.theme';

/**
 * The themes a person picks from (KBC-124 BR-4): "auto" is not one of them, it is what
 * nobody chose and shows as "Escuro (revisado)".
 */
export const THEME_CHOICES = [
  'revised',
  'system',
  'light',
  'dark',
  'esoteric',
] as const satisfies readonly Theme[];
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const THEME_LABELS: Record<ThemeChoice, () => string> = {
  revised: () => $localize`:@@theme.revised:Escuro (revisado)`,
  system: () => $localize`:@@theme.auto:Automático (claro/escuro)`,
  light: () => $localize`:@@theme.light:Claro`,
  dark: () => $localize`:@@theme.dark:Escuro`,
  esoteric: () => $localize`:@@theme.esoteric:Esotérico`,
};

/** The choice a theme shows as: "auto" (not chosen) is the revised theme (D2). */
export const shownTheme = (theme: Theme): ThemeChoice =>
  theme === 'auto' ? 'revised' : theme;

/**
 * Theme choice (KBC-005 BR-3): remembered in this browser. With nothing chosen ("auto"), the
 * page has no data-theme and shows the revised theme, the v2 default (KBC-124 D2); "system"
 * follows the operating system between light and dark.
 */
@Injectable({ providedIn: 'root' })
export class ThemeStore {
  private readonly document = inject(DOCUMENT);
  private readonly state = signal<Theme>(this.read());
  readonly theme = this.state.asReadonly();

  constructor() {
    effect(() => {
      const theme = this.state();
      const root = this.document.documentElement;
      if (theme === 'auto') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', theme);
      this.write(theme);
    });
  }

  set(theme: Theme): void {
    this.state.set(theme);
  }

  private read(): Theme {
    try {
      const parsed = themeSchema.safeParse(
        this.document.defaultView?.localStorage.getItem(STORAGE_KEY),
      );
      return parsed.success ? parsed.data : 'auto';
    } catch {
      return 'auto';
    }
  }

  private write(theme: Theme): void {
    try {
      this.document.defaultView?.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage unavailable: the theme lasts for this page only.
    }
  }
}
