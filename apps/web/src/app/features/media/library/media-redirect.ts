import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { ChatStore } from '@features/chat/chat-store.js';
import { filter, map, take } from 'rxjs';

/**
 * /midia for who has the library (KBC-051 FR-7): goes to /biblioteca with the collection
 * selected in the sidebar as the first filter, once the collections are known (a link
 * opened directly). A component, not a guard: the selected collection lives in the chat
 * page's store, which a route guard cannot reach.
 */
@Component({
  selector: 'app-media-redirect',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaRedirect {
  constructor() {
    const chat = inject(ChatStore);
    const router = inject(Router);
    toObservable(chat.topics.isLoading)
      .pipe(
        filter((loading) => !loading),
        take(1),
        map(() => chat.topicSlug()),
        takeUntilDestroyed(),
      )
      .subscribe((topic) => {
        void router.navigate(['/biblioteca'], {
          queryParams: topic ? { acervo: topic } : {},
          replaceUrl: true,
        });
      });
  }
}
