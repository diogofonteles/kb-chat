import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { DocumentRef } from '@kb-chat/contracts';
import { ResearchMessage } from './research-message.js';
import type { TrackOpening } from './track-opening.js';
import type { ResearchTurn } from './research-turn.js';

/** The "Pesquisa com IA" conversation: only the agent's answers, never search cards (BR-6). */
@Component({
  selector: 'app-research-thread',
  imports: [ResearchMessage],
  template: `
    @for (turn of turns(); track turn.id) {
      <app-research-message
        [turn]="turn"
        [last]="$last"
        (opened)="opened.emit($event)"
        (trackOpened)="trackOpened.emit($event)"
        (stopped)="stopped.emit()"
        (retried)="retried.emit()"
        (continued)="continued.emit()"
      />
    }
    <p class="visually-hidden" aria-live="polite">{{ announcement() }}</p>
  `,
  styles: `
    :host {
      display: grid;
      /* A wide answer (a table) scrolls in its own box, never widens the thread. */
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-8);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResearchThread {
  readonly turns = input.required<readonly ResearchTurn[]>();
  readonly opened = output<DocumentRef>();
  readonly trackOpened = output<TrackOpening>();
  readonly stopped = output();
  readonly retried = output();
  /** "Continuar varredura" on the last turn (KBC-030). */
  readonly continued = output();

  /**
   * Short live-region text: the streamed tokens are not announced, and errors already are
   * (role="alert" in the message).
   */
  protected readonly announcement = computed(() => {
    const last = this.turns().at(-1);
    const ready = last?.phase === 'done' && !last.interrupted && !last.restored;
    return ready ? $localize`:@@ai.ready:Resposta da IA pronta.` : '';
  });
}
