import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  inject,
  output,
} from '@angular/core';

/**
 * Tells when its element comes near the visible area (the next page loads as the person
 * scrolls, NFR-2). Without IntersectionObserver nothing is emitted: the element is a
 * button that loads the page when pressed.
 */
@Directive({ selector: '[appNearEnd]' })
export class NearEnd {
  readonly nearEnd = output();

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting))
            this.nearEnd.emit();
        },
        { rootMargin: '600px 0px' },
      );
      observer.observe(host.nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
