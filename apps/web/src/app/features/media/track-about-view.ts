import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { trackAboutSchema } from '@kb-chat/contracts';
import { mediaUrl } from '@core/media/media-api.js';

/**
 * "Assuntos" and the summary on a track's page, for who listens (KBC-070, T15): accepted
 * subjects only. A chip opens the search filtered by it, for who may search.
 */
@Component({
  selector: 'app-track-about-view',
  template: `
    @if (shown(); as about) {
      <section
        class="about"
        aria-label="Assuntos da faixa"
        i18n-aria-label="@@subjects.ofTrack"
      >
        @if (about.subjects.length > 0) {
          <div class="subjects">
            <span class="title" i18n="@@panel.concepts">Assuntos:</span>
            <ul>
              @for (subject of about.subjects; track subject.key) {
                <li>
                  @if (canSearch()) {
                    <button
                      type="button"
                      class="chip"
                      [attr.aria-label]="labelOf(subject.name)"
                      (click)="subjectChosen.emit(subject.name)"
                    >
                      {{ subject.name }}
                    </button>
                  } @else {
                    <span class="chip">{{ subject.name }}</span>
                  }
                </li>
              }
            </ul>
          </div>
        }
        @if (about.summary) {
          <p>{{ about.summary }}</p>
        }
      </section>
    }
  `,
  styles: `
    .about {
      display: grid;
      gap: var(--space-2);
      margin-top: var(--space-2);
    }
    .subjects {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
    .title {
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    ul {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      min-width: 0;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      min-width: 0;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      overflow-wrap: anywhere;
      padding: var(--space-1) var(--space-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: transparent;
      color: var(--color-text);
      font: inherit;
      text-align: left;
    }
    button.chip {
      min-height: var(--target);
      cursor: pointer;
    }
    button.chip:hover {
      border-color: var(--color-accent);
    }
    p {
      margin: 0;
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackAboutView {
  readonly mediaId = input.required<string>();
  readonly canSearch = input(false);
  readonly subjectChosen = output<string>();

  private readonly read = httpResource(
    () => `${mediaUrl(this.mediaId())}/about`,
    { parse: (body) => trackAboutSchema.parse(body) },
  );
  /** Nothing to show, or a failed read: the page stays as it was, the track plays. */
  protected readonly shown = computed(() => {
    if (!this.read.hasValue()) return null;
    const about = this.read.value();
    return about.subjects.length > 0 || about.summary ? about : null;
  });

  protected labelOf(name: string): string {
    return $localize`:@@trackAbout.search:Buscar por ${name}:subject:`;
  }
}
