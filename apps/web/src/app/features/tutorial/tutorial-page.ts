import {
  ReadingPage,
  type ReadingLink,
} from '@features/public/reading-page.js';
import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  inject,
  viewChild,
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
  imports: [RouterLink, TutorialFigure, ReadingPage],
  templateUrl: './tutorial-page.html',
  styleUrl: './tutorial-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TutorialPage {
  private readonly router = inject(Router);
  private readonly reading = viewChild(ReadingPage);

  protected readonly sections = TUTORIAL_SECTIONS;
  protected readonly title = $localize`:@@tutorial.title:Como usar a Nova Alexandria`;
  protected readonly intro = $localize`:@@tutorial.intro:Um passo a passo curto, com imagens das telas, de tudo o que dá para fazer na Nova Alexandria: entrar, buscar nos documentos, pesquisar com ajuda da inteligência artificial (IA) e ajustar o app do seu jeito. Leia na ordem ou pule direto para o que precisa. Nas imagens, as letras (A, B, C…) marcam o que a legenda logo abaixo explica.`;
  protected readonly other: ReadingLink = {
    label: $localize`:@@reading.privacy:Privacidade`,
    path: '/privacidade',
  };

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
    this.reading()?.showSection(id);
  }

  private currentFragment(): string | null {
    return this.router.parseUrl(this.router.url).fragment;
  }
}
