import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { libraryHomeSchema, type MediaItem } from '@kb-chat/contracts';
import { LIBRARY_HOME_URL } from '@core/media/library-api.js';
import { mediaPagePath } from '@core/media/media-api.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { RightPanel } from '@features/shell/right-panel.js';
import { UiCover, UiIcon, UiIconButton, UiTablist } from '@ui/index.js';
import { NowPlayingPanel } from './now-playing-panel.js';
import { PlayerAbout } from './player-about.js';
import { PlayerPanelTabs, type PlayerPanelTab } from './player-panel-tab.js';

interface Listed {
  readonly id: string;
  readonly title: string;
  readonly author: string;
}

/**
 * The player's right panel (v2 · Mídia — Player, lib.js panelTabs and nowPlaying queue):
 * "Sobre | Fila | Ouvidas" with the ✕. Sobre is the page's "Sobre este áudio" on the
 * player page and "Tocando agora" elsewhere; Fila is what plays now and what is in
 * progress to continue ("A seguir", the library's "Continuar ouvindo": the app keeps no
 * other queue, BR-4); Ouvidas is the library's "Ouvidas recentemente".
 */
@Component({
  selector: 'app-player-panel',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    NowPlayingPanel,
    PlayerAbout,
    UiCover,
    UiIcon,
    UiIconButton,
    UiTablist,
  ],
  template: `
    <div class="tabs">
      <div
        uiTablist
        role="tablist"
        class="tablist"
        aria-label="Painel do player"
        i18n-aria-label="@@player.panel.tabs"
      >
        @for (one of tabList; track one.id) {
          <button
            type="button"
            role="tab"
            class="tab"
            [id]="'player-tab-' + one.id"
            aria-controls="player-tab-panel"
            [attr.aria-selected]="tabs.tab() === one.id"
            [attr.tabindex]="tabs.tab() === one.id ? 0 : -1"
            (click)="tabs.tab.set(one.id)"
          >
            {{ one.label }}
          </button>
        }
      </div>
      <button
        uiIconButton
        type="button"
        class="close"
        aria-label="Fechar o painel"
        i18n-aria-label="@@player.panel.close"
        (click)="panel.close()"
      >
        <ui-icon name="close" [size]="18" />
      </button>
    </div>
    <div
      id="player-tab-panel"
      role="tabpanel"
      class="tab-panel"
      [attr.aria-labelledby]="'player-tab-' + tabs.tab()"
    >
      @switch (tabs.tab()) {
        @case ('about') {
          @if (media(); as current) {
            <app-player-about [media]="current" [canEdit]="canEdit()" />
          } @else {
            <app-now-playing-panel [embedded]="true" />
          }
        }
        @case ('queue') {
          <h3 i18n="@@player.panel.nowPlaying">Tocando agora</h3>
          @if (source(); as playing) {
            <a class="item now" [routerLink]="pathOf(playing.id)">
              <ui-cover [title]="playing.title" [size]="48" />
              <span class="words">
                <span class="name">{{ playing.title }}</span>
                <span class="by">{{ playing.artist ?? othersLabel }}</span>
              </span>
            </a>
          } @else {
            <p class="quiet" i18n="@@nowPlaying.idle">Nada tocando agora.</p>
          }
          <h3 i18n="@@player.panel.next">A seguir</h3>
          <ng-container
            *ngTemplateOutlet="list; context: { $implicit: next() }"
          />
        }
        @case ('recent') {
          <h3 i18n="@@library.recents">Ouvidas recentemente</h3>
          <ng-container
            *ngTemplateOutlet="list; context: { $implicit: recent() }"
          />
        }
      }
    </div>
    <ng-template #list let-items>
      @if (items.length) {
        <ul class="items">
          @for (one of items; track one.id) {
            <li>
              <a class="item" [routerLink]="pathOf(one.id)">
                <ui-cover [title]="one.title" [size]="48" />
                <span class="words">
                  <span class="name">{{ one.title }}</span>
                  <span class="by">{{ one.author }}</span>
                </span>
              </a>
            </li>
          }
        </ul>
      } @else if (home.hasValue()) {
        <p class="quiet" i18n="@@player.panel.none">Nada por aqui ainda.</p>
      }
    </ng-template>
  `,
  styleUrl: './player-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlayerPanel {
  /** The player page's media: Sobre is then "Sobre este áudio". */
  readonly media = input<MediaItem | null>(null);
  readonly canEdit = input(false);
  protected readonly panel = inject(RightPanel);
  protected readonly tabs = inject(PlayerPanelTabs);
  private readonly engine = inject(MediaEngine);
  protected readonly source = this.engine.source;
  protected readonly othersLabel = $localize`:@@authorship.others:Outros autores`;
  protected readonly tabList: readonly {
    readonly id: PlayerPanelTab;
    readonly label: string;
  }[] = [
    { id: 'about', label: $localize`:@@player.panel.about:Sobre` },
    { id: 'queue', label: $localize`:@@player.panel.queue:Fila` },
    { id: 'recent', label: $localize`:@@player.panel.recent:Ouvidas` },
  ];

  protected readonly home = httpResource(
    () => (this.tabs.tab() === 'about' ? undefined : LIBRARY_HOME_URL),
    { parse: (body) => libraryHomeSchema.parse(body) },
  );
  private listed(items: readonly MediaItem[], skipPlaying: boolean): Listed[] {
    const playing = skipPlaying ? this.source()?.id : undefined;
    return items
      .filter((one) => one.id !== playing)
      .map((one) => ({
        id: one.id,
        title: one.title,
        author: one.author?.name ?? this.othersLabel,
      }));
  }
  protected readonly next = computed(() =>
    this.home.hasValue()
      ? this.listed(this.home.value().continueListening, true)
      : [],
  );
  protected readonly recent = computed(() =>
    this.home.hasValue()
      ? this.listed(this.home.value().recentlyPlayed, false)
      : [],
  );

  protected pathOf(id: string): string {
    return mediaPagePath(id);
  }
}
