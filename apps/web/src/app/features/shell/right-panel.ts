import { Injectable, signal, type Type } from '@angular/core';

/** The widths of the v2 right panel: 340 ("Tocando agora", Fila) or 460 (a source open). */
export type RightPanelWidth = 'narrow' | 'source';

export interface RightPanelContent {
  readonly component: Type<unknown>;
  readonly inputs?: Record<string, unknown>;
  readonly width: RightPanelWidth;
  /** The panel's accessible name ("Tocando agora", "Fila"). */
  readonly label: string;
}

/**
 * The optional right panel of the v2 shell (KBC-125 FR-1): an area puts a component there
 * ("Tocando agora", the Fila, a source) and takes it away; the shell draws the panel next
 * to the main one on desktop and over it on a phone. The conversation's own document panel
 * still wins while it is open. Root-provided, so a routed page can open it.
 */
@Injectable({ providedIn: 'root' })
export class RightPanel {
  private readonly state = signal<RightPanelContent | null>(null);
  readonly content = this.state.asReadonly();

  open(content: RightPanelContent): void {
    this.state.set(content);
  }

  close(): void {
    this.state.set(null);
  }
}
