import { Injectable, inject, signal } from '@angular/core';
import { PlayerAnnouncer } from './player-announcer.js';

const CAPTIONS_KEY = 'kb-chat.player.captions';
const COLLAPSED_KEY = 'kb-chat.player.transcript-collapsed';
const SPEAKERS_KEY = 'kb-chat.player.show-speakers';

function storedOn(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'on';
  } catch {
    return false;
  }
}

/** On unless the person turned it off (KBC-065 FR-4: "Mostrar quem fala" starts on). */
function storedNotOff(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'off';
  } catch {
    return true;
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
  private readonly speakers = signal(storedNotOff(SPEAKERS_KEY));

  readonly captionsOn = this.captions.asReadonly();
  readonly transcriptCollapsed = this.collapsed.asReadonly();
  /** "Mostrar quem fala": names in the transcript and the subtitles (KBC-065 FR-4). */
  readonly speakersOn = this.speakers.asReadonly();

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

  toggleSpeakers(): void {
    const on = !this.speakers();
    this.speakers.set(on);
    store(SPEAKERS_KEY, on);
    this.announcer.say(
      on
        ? $localize`:@@player.announce.speakersOn:Quem fala aparece na transcrição e na legenda`
        : $localize`:@@player.announce.speakersOff:Quem fala não aparece mais`,
    );
  }

  setTranscriptCollapsed(collapsed: boolean): void {
    this.collapsed.set(collapsed);
    store(COLLAPSED_KEY, collapsed);
  }
}
