import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

/** A file the browser takes this long to measure is treated as unreadable. */
const READ_TIMEOUT_MS = 8_000;

/** Reads an audio file's length in the browser; null when it cannot. */
export type AudioLengthReader = (file: Blob) => Observable<number | null>;

/** The metadata alone: nothing of the file leaves the browser (KBC-072 BR-4). */
const readWithAudioElement: AudioLengthReader = (file) =>
  new Observable<number | null>((subscriber) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const finish = (ms: number | null) => {
      subscriber.next(ms);
      subscriber.complete();
    };
    const timer = setTimeout(() => finish(null), READ_TIMEOUT_MS);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () =>
      finish(
        Number.isFinite(audio.duration)
          ? Math.round(audio.duration * 1000)
          : null,
      );
    audio.onerror = () => finish(null);
    audio.src = url;
    return () => {
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
  });

export const AUDIO_LENGTH_READER = new InjectionToken<AudioLengthReader>(
  'AUDIO_LENGTH_READER',
  { providedIn: 'root', factory: () => readWithAudioElement },
);
