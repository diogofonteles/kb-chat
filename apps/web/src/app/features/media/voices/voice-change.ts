import type {
  CollectionSpeaker,
  CollectionSpeakerCreate,
} from '@kb-chat/contracts';
import { map, of, type Observable } from 'rxjs';
import type { SpeakerChoice } from './speaker-suggestions.js';

/** What a voice's name changes to. */
export interface VoiceChange {
  readonly speakerId: string | null;
  readonly audience: boolean;
}

/** A voice with no name. */
const NO_LABEL: VoiceChange = { speakerId: null, audience: false };

/** What a chosen option saves; a new name or an author becomes a speaker first. */
export function voiceChangeOf(
  choice: SpeakerChoice,
  register: (speaker: CollectionSpeakerCreate) => Observable<CollectionSpeaker>,
): Observable<VoiceChange> {
  if (choice.kind === 'speaker')
    return of({ speakerId: choice.id, audience: false });
  if (choice.kind === 'audience')
    return of({ speakerId: null, audience: true });
  if (choice.kind === 'none') return of(NO_LABEL);
  const speaker =
    choice.kind === 'new'
      ? { name: choice.name }
      : { name: choice.author.name, authorSlug: choice.author.slug };
  return register(speaker).pipe(
    map(({ id }) => ({ speakerId: id, audience: false })),
  );
}
