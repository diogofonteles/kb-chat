import { Injectable, signal } from '@angular/core';

/**
 * What a routed page tells the shell about its phone header row (v2 · celular: the avatar,
 * the page's name, the page's own icons, on the page's colour). The shell draws the row; a
 * page sets its colour so the row sits on the same gradient as the page's top, and clears it
 * when it goes. Root-provided, as RightPanel, so any routed page can reach it.
 */
@Injectable({ providedIn: 'root' })
export class PageHeader {
  private readonly color = signal<string | null>(null);
  /** The page's colour under its header ("#7a3d22"), or null for the plain background. */
  readonly tint = this.color.asReadonly();

  setTint(color: string | null): void {
    this.color.set(color);
  }
}
