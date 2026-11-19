import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/** A thin v2 progress bar (decorative: the number next to it says the value). */
@Component({
  selector: 'ui-progress',
  template: `<span
    class="ui-progress__fill"
    [style.width.%]="percent()"
  ></span>`,
  host: { class: 'ui-progress', 'aria-hidden': 'true' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiProgress {
  /** 0 to 1. */
  readonly value = input(0);
  protected readonly percent = computed(
    () => Math.max(0, Math.min(1, this.value())) * 100,
  );
}
