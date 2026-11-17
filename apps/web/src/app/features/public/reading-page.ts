import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';
import { UiButton } from '@ui/button.js';
import { UiLogo } from '@ui/logo.js';

/** A section of a reading page: the id of its h2 (its public anchor) and its index label. */
export interface ReadingSection {
  readonly id: string;
  readonly title: string;
}

/** The other public page, linked from the bar. */
export interface ReadingLink {
  readonly label: string;
  readonly path: string;
}

/**
 * The public reading page of v2 · Públicas (KBC-124 FR-5): a slim bar (logo, the other page,
 * "Entrar"), a gradient header (kicker, 64 title, meta), a fixed 240 index that marks the
 * section on screen and a 720 column. Below 1024 px the index is a row of chips. The page's
 * h2 carry the section ids; a choice in the index scrolls there and moves the focus.
 */
@Component({
  selector: 'app-reading-page',
  imports: [RouterLink, UiButton, UiLogo],
  templateUrl: './reading-page.html',
  styleUrl: './reading-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReadingPage {
  readonly titleId = input.required<string>();
  readonly heading = input.required<string>();
  readonly meta = input('');
  readonly path = input.required<string>();
  readonly sections = input.required<readonly ReadingSection[]>();
  readonly other = input.required<ReadingLink>();
  /** The index's own id, for "back to the contents" links (the tutorial's `#sumario`). */
  readonly indexId = input<string | null>(null);
  private readonly session = inject(SessionStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  /** The section on screen (the index marks it, AC-7). */
  protected readonly active = signal<string | null>(null);
  protected readonly signedIn = computed(
    () => this.session.state().kind === 'signed-in',
  );

  constructor() {
    afterNextRender(() => this.watchSections());
  }

  /**
   * Scrolls to a section and moves the focus to its heading. Also runs on a click, as the
   * router ignores a link to the fragment it is already on.
   */
  showSection(id: string | null): void {
    if (!id) return;
    // Focus has no Angular API: the heading is looked up by id, inside this page only.
    const page = this.host.nativeElement;
    const heading = page.ownerDocument.getElementById(id);
    if (!heading || !page.contains(heading)) return;
    this.active.set(id);
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  }

  /** The section whose heading crossed the top fifth of the screen last is the current one. */
  private watchSections(): void {
    const view = this.document.defaultView;
    if (!view || typeof view.IntersectionObserver === 'undefined') return;
    const observer = new view.IntersectionObserver(
      (entries) => {
        const seen = entries.filter((entry) => entry.isIntersecting);
        const last = seen.at(-1)?.target.id;
        if (last) this.active.set(last);
      },
      { rootMargin: '0px 0px -75% 0px' },
    );
    for (const { id } of this.sections()) {
      const heading = this.document.getElementById(id);
      if (heading) observer.observe(heading);
    }
    this.active.set(this.sections()[0]?.id ?? null);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }
}
