import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ChatStore } from '@features/chat/chat-store.js';

/**
 * /midia for who has the library (KBC-051 FR-7): goes to /biblioteca with the collection
 * selected in the sidebar as the first filter. A component, not a guard: the selected
 * collection lives in the chat page's store, which a route guard cannot reach.
 */
@Component({
  selector: 'app-media-redirect',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaRedirect {
  constructor() {
    const topic = inject(ChatStore).topicSlug();
    void inject(Router).navigate(['/biblioteca'], {
      queryParams: topic ? { acervo: topic } : {},
      replaceUrl: true,
    });
  }
}
