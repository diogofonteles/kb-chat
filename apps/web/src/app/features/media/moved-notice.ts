import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { RouterLink, type Params } from '@angular/router';
import type { MediaItem, Topic } from '@kb-chat/contracts';

/** An audio that went to another collection. */
export interface MediaMove {
  readonly topic: string;
  /** "<título> foi movido para o acervo <nome>." */
  readonly text: string;
}

export function mediaMoveOf(
  item: MediaItem,
  topics: readonly Topic[],
): MediaMove {
  const name =
    topics.find((topic) => topic.slug === item.topic)?.title ?? item.topic;
  return {
    topic: item.topic,
    text: $localize`:@@media.edit.moved:${item.title}:title: foi movido para o acervo ${name}:topic:.`,
  };
}

/**
 * Where an audio went, with a link there (KBC-050 FR-3). The page reads the text aloud in
 * its status region: this one only appears when there is something to show.
 */
@Component({
  selector: 'app-moved-notice',
  imports: [RouterLink],
  template: `
    @if (move(); as moved) {
      {{ moved.text }}
      <a
        [routerLink]="path()"
        [queryParams]="query()"
        (click)="opened.emit(moved.topic)"
        i18n="@@media.edit.openTopic"
        >Ver o acervo</a
      >
    }
  `,
  styles: `
    :host {
      display: block;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    :host(:empty) {
      display: none;
    }

    a {
      color: var(--color-accent-text, var(--color-accent));
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MovedNotice {
  readonly move = input.required<MediaMove | null>();
  /** Where the collection's list is. */
  readonly path = input.required<string>();
  readonly query = input<Params | null>(null);
  readonly opened = output<string>();
}
