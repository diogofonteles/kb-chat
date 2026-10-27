import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { TutorialFigure } from './tutorial-figure.js';
import { TUTORIAL_SECTIONS } from './tutorial-sections.js';

/**
 * The public "how to use" guide (KBC-032): every feature in short steps with real
 * screenshots, open with or without a session. `/tutorial#<section>` opens at that section
 * with the focus on its heading; the shell renders this page outside the router outlet, so
 * the router's own anchor scrolling would run before the page exists.
 */
@Component({
  selector: 'app-tutorial-page',
  imports: [RouterLink, TutorialFigure],
  templateUrl: './tutorial-page.html',
  styleUrl: './tutorial-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TutorialPage {
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly sections = TUTORIAL_SECTIONS;

  constructor() {
    afterNextRender(() => this.showSection(this.currentFragment()));
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.showSection(this.currentFragment()));
  }

  /**
   * Scrolls to a section and moves the focus to its heading, so keyboard and screen reader
   * users continue from there. Also runs on a click, as the router ignores a link to the
   * fragment it is already on.
   */
  protected showSection(id: string | null): void {
    if (!id) return;
    // Focus has no Angular API: the heading is looked up by id, inside this page only.
    const page = this.host.nativeElement;
    const heading = page.ownerDocument.getElementById(id);
    if (!heading || !page.contains(heading)) return;
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  }

  private currentFragment(): string | null {
    return this.router.parseUrl(this.router.url).fragment;
  }
}
