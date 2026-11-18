import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
  type TemplateRef,
} from '@angular/core';

/** What a page that draws its own header asks of the shell's top bar (v2 frames). */
export interface OwnPageHeader {
  /** The page's name on the phone's top row ("Biblioteca", the collection's title). */
  readonly title: string;
  /** A page under another: "←" to this address instead of the menu's avatar (celular). */
  readonly back: string | null;
  /** The page's icon buttons at the end of the phone's top row (search, upload). */
  readonly actions: TemplateRef<unknown> | null;
  /** The colour its own gradient starts from: the phone's top row takes it (no seam). */
  readonly tint?: string | null;
}

/**
 * What a routed page tells the shell about its header row (v2 · celular: the avatar, the
 * page's name, the page's own icons, on the page's colour). The shell draws the row.
 *
 * - A page with its own header (the library, a collection's album page: v2 · Mídia —
 *   Biblioteca e lista) claims it with `own()`: on a desktop the shell leaves out its
 *   collection bar, which those frames do not have; on a phone its top row says the page's
 *   name and holds the page's own icon buttons, beside the menu's avatar (or a "←").
 * - Any other page may set a colour (`setTint`) so the phone's row sits on the same gradient
 *   as the page's top, and clears it when it goes.
 *
 * Root-provided, as RightPanel, so any routed page can reach it.
 */
@Injectable({ providedIn: 'root' })
export class PageHeader {
  private readonly source = signal<Signal<OwnPageHeader> | null>(null);
  private readonly color = signal<string | null>(null);
  readonly current = computed(() => this.source()?.() ?? null);
  /** The page's colour under its header ("#7a3d22"), or null for the plain background. */
  readonly tint = this.color.asReadonly();

  /** For a page, in an injection context: the claim ends with the page. */
  own(header: Signal<OwnPageHeader>): void {
    this.source.set(header);
    inject(DestroyRef).onDestroy(() => {
      if (this.source() === header) this.source.set(null);
    });
  }

  setTint(color: string | null): void {
    this.color.set(color);
  }
}
