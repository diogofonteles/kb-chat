import { Injectable, inject, signal } from '@angular/core';
import { PlayerAnnouncer } from './player-announcer.js';

const CAPTIONS_KEY = 'kb-chat.player.captions';
const COLLAPSED_KEY = 'kb-chat.player.transcript-collapsed';

function storedOn(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'on';
  } catch {
    return false;
  }
}

function store(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    // Not remembered in a private window; still in use now.
  }
}

/**
 * The person's subtitles (CC) and whether the transcript column is hidden (KBC-038 FR-6,
 * FR-9): the same for every media, remembered in this browser. Subtitles start off.
 */
@Injectable({ providedIn: 'root' })
export class TranscriptPreferences {
  private readonly announcer = inject(PlayerAnnouncer);
  private readonly captions = signal(storedOn(CAPTIONS_KEY));
  private readonly collapsed = signal(storedOn(COLLAPSED_KEY));

  readonly captionsOn = this.captions.asReadonly();
  readonly transcriptCollapsed = this.collapsed.asReadonly();

  /** CC or C: on and off, said in the player's status region. */
  toggleCaptions(): void {
    const on = !this.captions();
    this.captions.set(on);
    store(CAPTIONS_KEY, on);
    this.announcer.say(
      on
        ? $localize`:@@player.announce.captionsOn:Legendas ligadas`
        : $localize`:@@player.announce.captionsOff:Legendas desligadas`,
    );
  }

  setTranscriptCollapsed(collapsed: boolean): void {
    this.collapsed.set(collapsed);
    store(COLLAPSED_KEY, collapsed);
  }
}
