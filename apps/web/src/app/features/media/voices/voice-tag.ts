import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { voiceLookOf } from './voice-changes.js';

/**
 * "Voz N" (KBC-064 FR-5, AC-8): the text a screen reader reads, with a coloured shape
 * beside it so voices tell apart at a glance; the colour never stands alone (WCAG 1.4.1).
 * Used in the voices block and, with KBC-038, at each change of voice in the transcript,
 * where a named voice shows who it is (KBC-065).
 */
@Component({
  selector: 'app-voice-tag',
  template: `<span
      class="mark"
      [attr.data-shape]="look().shape"
      [class.hollow]="look().hollow"
      [style.--voice-color]="color()"
      aria-hidden="true"
    ></span>
    @if (main()) {
      <span class="star" aria-hidden="true">✦</span
      ><span class="visually-hidden" i18n="@@media.author.mainPrefix"
        >Autor principal:&nbsp;</span
      >
    }
    <span class="name">{{ label() }}</span>`,
  styleUrl: './voice-tag.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'voice-tag' },
})
export class VoiceTag {
  readonly voice = input.required<number>();
  /** Who it is (KBC-065 FR-4); without it, "Voz N". */
  readonly name = input<string | null>(null);
  /** The collection's main author: ✦ before the name (BR-2). */
  readonly main = input(false);
  protected readonly look = computed(() => voiceLookOf(this.voice()));
  protected readonly color = computed(
    () => `var(--color-voice-${this.look().tone})`,
  );
  protected readonly label = computed(
    () => this.name() ?? $localize`:@@voices.voice:Voz ${this.voice()}:number:`,
  );
}
