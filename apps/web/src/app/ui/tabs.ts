import { Directive, ElementRef, inject } from '@angular/core';

const KEYS = new Set(['ArrowRight', 'ArrowLeft', 'Home', 'End']);

/**
 * The keyboard of a `role="tablist"` (WAI-ARIA APG Tabs, automatic activation): ← and →
 * move to the previous and next tab, wrapping, Home and End to the first and last; the tab
 * reached is chosen (its own click) and takes the focus, so a screen reader announces it
 * and the roving tabindex follows it (WCAG 2.1.1, 2.4.3).
 */
@Directive({
  selector: '[uiTablist]',
  host: { '(keydown)': 'onKeydown($event)' },
})
export class UiTablist {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected onKeydown(event: KeyboardEvent): void {
    if (!KEYS.has(event.key)) return;
    const tabs = [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>('[role="tab"]'),
    ].filter((tab) => !tab.hasAttribute('disabled'));
    const from = tabs.findIndex((tab) => tab === event.target);
    if (from < 0 || tabs.length === 0) return;
    event.preventDefault();
    const last = tabs.length - 1;
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? (from + 1) % tabs.length
            : (from - 1 + tabs.length) % tabs.length;
    const next = tabs[to];
    if (!next) return;
    next.click();
    next.focus();
  }
}
