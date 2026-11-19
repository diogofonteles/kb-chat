import { httpResource } from '@angular/common/http';
import { Injectable, computed, inject } from '@angular/core';
import { mediaListSchema } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { MediaEngine } from '@core/media/media-engine.js';
import { mediaListUrl } from '@core/media/media-api.js';
import { ChatStore } from '@features/chat/chat-store.js';

/**
 * The audio rule of v2 (docs/design/redesign-v2.md, KBC-125 BR-2): the player bar, the mini
 * player, the pinned media items, the "Áudios" chip and the media tabs of the phone nav only
 * show when the collection in use has audio or something is playing. Provided by the chat
 * page, next to the ChatStore whose collection it reads.
 */
@Injectable()
export class AudioPresence {
  private readonly session = inject(SessionStore);
  private readonly engine = inject(MediaEngine);
  private readonly chat = inject(ChatStore);
  /** Who listens to media at all (the server's media on and "Ouvir mídia"). */
  readonly listens = computed(
    () => this.session.me()?.media === true && this.session.can('media'),
  );
  /** The media of the collection in use; asked only of who listens. */
  private readonly media = httpResource(
    () => {
      const slug = this.chat.topicSlug();
      return this.listens() && slug ? mediaListUrl(slug) : undefined;
    },
    { parse: (body) => mediaListSchema.parse(body) },
  );
  readonly playing = computed(() => this.engine.source() !== null);
  /** The collection in use has audio (any media, or tracks it shows as documents). */
  readonly collectionHasAudio = computed(() => {
    if (!this.listens()) return false;
    if ((this.chat.topic()?.trackCount ?? 0) > 0) return true;
    return this.media.hasValue() && this.media.value().items.length > 0;
  });
  /** The audio rule itself. */
  readonly shown = computed(() => this.playing() || this.collectionHasAudio());
}
