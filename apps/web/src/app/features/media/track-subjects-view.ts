import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { trackSubjectsSchema } from '@kb-chat/contracts';
import { trackSubjectsUrl } from '@core/media/track-subjects-api.js';

/** A track's subjects on its page, read-only, for who classifies (KBC-069; listeners: KBC-070). */
@Component({
  selector: 'app-track-subjects-view',
  template: `
    @if (shown(); as track) {
      <section
        class="view"
        aria-label="Assuntos da faixa"
        i18n-aria-label="@@subjects.ofTrack"
      >
        <ul>
          @for (subject of track.subjects; track subject.name) {
            <li [class.missing]="subject.missing">
              @if (subject.missing) {
                <span aria-hidden="true">⚠ </span>
              }
              {{ subject.name }}
              @if (subject.missing) {
                <span class="note" i18n="@@subjects.missing"
                  >Assunto não encontrado no acervo</span
                >
              }
            </li>
          }
        </ul>
        @if (track.summary) {
          <p>{{ track.summary }}</p>
        }
      </section>
    }
  `,
  styles: `
    .view {
      display: grid;
      gap: var(--space-2);
    }
    ul {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    ul:empty {
      display: none;
    }
    li {
      padding: var(--space-1) var(--space-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    li.missing {
      border-color: var(--color-danger);
    }
    .note {
      display: block;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    p {
      margin: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackSubjectsView {
  readonly mediaId = input.required<string>();

  private readonly read = httpResource(() => trackSubjectsUrl(this.mediaId()), {
    parse: (body) => trackSubjectsSchema.parse(body),
  });
  /** Nothing to show, or a failed read: the page stays as it was, the track plays. */
  protected readonly shown = computed(() => {
    if (!this.read.hasValue()) return null;
    const track = this.read.value();
    return track.subjects.length > 0 || track.summary ? track : null;
  });
}
