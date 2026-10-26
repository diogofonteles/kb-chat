import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';
import { z } from 'zod';

export const THEMES = ['auto', 'light', 'dark', 'esoteric'] as const;
const themeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof themeSchema>;

const STORAGE_KEY = 'kb-chat.theme';

/** Theme choice (KBC-005 BR-3): "auto" follows the system; the choice is remembered in this browser. */
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
