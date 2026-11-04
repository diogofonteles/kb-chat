import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import {
  CONSENT_ATTACHMENT_MIMES,
  MAX_CONSENT_ATTACHMENT_BYTES,
  MIN_PROFILE_SPEECH_MS,
  VOICE_CONSENT_METHODS,
  VOICE_CONSENT_PURPOSE,
  VOICE_CONSENT_TEXT_VERSION,
  collectionSpeakerListSchema,
  namedVoiceListSchema,
  type NamedVoice,
  type VoiceConsent,
  type VoiceConsentEvidence,
  type VoiceConsentMethod,
  type VoiceProfile,
  type VoiceSubject,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { collectionSpeakersUrl } from '@core/media/speakers-api.js';
import {
  VoiceProfilesApi,
  namedVoicesUrl,
} from '@core/media/voice-profiles-api.js';
import { METHOD_LABELS, consentParagraphs } from './consent-text.js';

type EvidenceKind = VoiceConsentEvidence['kind'];

/** The document chosen, read into memory for the request. */
interface Attachment {
  readonly fileName: string;
  readonly mime: (typeof CONSENT_ATTACHMENT_MIMES)[number];
  readonly data: string;
}

const isAcceptedMime = (mime: string): mime is Attachment['mime'] =>
  (CONSENT_ATTACHMENT_MIMES as readonly string[]).includes(mime);

const sourceKeyOf = (voice: NamedVoice): string =>
  `${voice.mediaId}:${voice.voice}`;

/** Today in the browser's zone, as `<input type=date>` wants it. */
const today = (): string => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
};

/**
 * Registering a profile (KBC-071 AC-1, BR-1): the speaker, then the consent, and only then the
 * voices it is made from. The text is on screen in full and the confirmation starts unchecked
 * (highlighted, specific consent; nothing pre-selected).
 */
@Component({
  selector: 'app-voice-profile-form',
  imports: [ReactiveFormsModule],
  templateUrl: './voice-profile-form.html',
  styleUrls: ['../settings/settings-form.css', './voice-profiles.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceProfileForm {
  private readonly api = inject(VoiceProfilesApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly view = inject(DOCUMENT).defaultView;

  /** The top-level collection. */
  readonly topic = input.required<string>();
  /** Speakers that already have a profile: a second one is refused. */
  readonly taken = input.required<readonly string[]>();
  readonly created = output<VoiceProfile>();
  readonly cancelled = output();

  protected readonly form = new FormGroup({
    speakerId: new FormControl('', {
      nonNullable: true,
      validators: Validators.required,
    }),
    subject: new FormControl<VoiceSubject>('living', { nonNullable: true }),
    grantedBy: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    grantedByRole: new FormControl('', { nonNullable: true }),
    grantedOn: new FormControl('', {
      nonNullable: true,
      validators: Validators.required,
    }),
    method: new FormControl<VoiceConsentMethod>('signed-paper', {
      nonNullable: true,
    }),
    evidenceKind: new FormControl<EvidenceKind>('attachment', {
      nonNullable: true,
    }),
    evidenceText: new FormControl('', { nonNullable: true }),
    confirmed: new FormControl(false, { nonNullable: true }),
  });
  protected readonly maxDate = today();
  protected readonly methods = VOICE_CONSENT_METHODS.map((id) => ({
    id,
    label: METHOD_LABELS[id](),
  }));
  protected readonly accepted = CONSENT_ATTACHMENT_MIMES.join(',');

  private readonly value = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });
  protected readonly subject = computed(() => this.value().subject ?? 'living');
  protected readonly deceased = computed(() => this.subject() === 'deceased');
  protected readonly evidenceKind = computed(
    () => this.value().evidenceKind ?? 'attachment',
  );
  protected readonly speakerId = computed(() => this.value().speakerId ?? '');
  protected readonly paragraphs = computed(() =>
    consentParagraphs(this.subject()),
  );
  protected readonly speakerList = httpResource(
    () => collectionSpeakersUrl(this.topic()),
    { parse: (body) => collectionSpeakerListSchema.parse(body) },
  );
  protected readonly speakers = computed(() => {
    const taken = this.taken();
    return this.speakerList.hasValue()
      ? this.speakerList
          .value()
          .items.filter((speaker) => !taken.includes(speaker.id))
      : [];
  });

  /** The consent was filled in: only now the voices appear (AC-1). */
  protected readonly step = signal<'consent' | 'sources'>('consent');
  protected readonly attachment = signal<Attachment | null>(null);
  protected readonly problem = signal('');
  protected readonly busy = signal(false);
  protected readonly copied = signal(false);
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());

  protected readonly voiceList = httpResource(
    () =>
      this.step() === 'sources' && this.speakerId()
        ? namedVoicesUrl(this.topic(), this.speakerId())
        : undefined,
    { parse: (body) => namedVoiceListSchema.parse(body) },
  );
  protected readonly voices = computed(() =>
    this.voiceList.hasValue()
      ? this.voiceList.value().items.map((voice) => ({
          ...voice,
          key: sourceKeyOf(voice),
          spoken: formatClock(voice.speakingMs),
        }))
      : [],
  );
  private readonly chosenVoices = computed(() =>
    this.voices().filter(({ key }) => this.chosen().has(key)),
  );
  /** Enough speech to calculate from. */
  protected readonly enough = computed(
    () =>
      this.chosenVoices().reduce((sum, one) => sum + one.speakingMs, 0) >=
      MIN_PROFILE_SPEECH_MS,
  );

  constructor() {
    // The role is asked only for a deceased person; its rule follows the choice.
    effect(() => {
      const role = this.form.controls.grantedByRole;
      role.setValidators(this.deceased() ? [Validators.required] : []);
      role.updateValueAndValidity({ emitEvent: false });
    });
  }

  protected continueToSources(event: Event): void {
    event.preventDefault();
    this.form.markAllAsTouched();
    const problem = this.consentProblem();
    this.problem.set(problem);
    if (!problem) this.step.set('sources');
  }

  protected backToConsent(): void {
    this.problem.set('');
    this.step.set('consent');
  }

  protected toggle(key: string, on: boolean): void {
    const next = new Set(this.chosen());
    if (on) next.add(key);
    else next.delete(key);
    this.chosen.set(next);
  }

  protected save(): void {
    const consent = this.consent();
    if (!consent) return;
    this.busy.set(true);
    this.problem.set('');
    this.api
      .create(this.topic(), {
        speakerId: this.speakerId(),
        sources: this.chosenVoices().map(({ mediaId, voice }) => ({
          mediaId,
          voice,
        })),
        consent,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (profile) => this.created.emit(profile),
        error: (err: unknown) => this.saveFailed(err),
      });
  }

  /** Reads the document into memory; only a saved consent keeps it, sealed. */
  protected chooseFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    this.attachment.set(null);
    if (!file) return;
    if (!isAcceptedMime(file.type) || file.size > MAX_CONSENT_ATTACHMENT_BYTES)
      return this.problem.set(
        $localize`:@@voiceConsent.badFile:Use um PDF, JPEG ou PNG de até 5 MB.`,
      );
    this.problem.set('');
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',')[1] ?? '';
      const mime = file.type as Attachment['mime'];
      this.attachment.set({ fileName: file.name, mime, data });
    };
    reader.readAsDataURL(file);
  }

  protected async copyText(): Promise<void> {
    const text = this.paragraphs().join('\n\n');
    try {
      await this.view?.navigator.clipboard.writeText(text);
      this.copied.set(true);
    } catch {
      this.copied.set(false);
    }
  }

  protected invalid(control: keyof typeof this.form.controls): boolean {
    const field = this.form.controls[control];
    return field.touched && field.invalid;
  }

  /** The first thing missing, in words (MA-23); empty when the consent can go on. */
  private consentProblem(): string {
    const { value } = this.form;
    if (!value.speakerId)
      return $localize`:@@voiceConsent.needSpeaker:Escolha a pessoa.`;
    if (this.form.invalid)
      return $localize`:@@voiceConsent.needFields:Preencha os campos do consentimento.`;
    if (!this.evidence())
      return $localize`:@@voiceConsent.needEvidence:Anexe o documento ou cole o texto do aceite.`;
    if (!value.confirmed)
      return $localize`:@@voiceConsent.needConfirmation:Confirme a autorização para continuar.`;
    return '';
  }

  private evidence(): VoiceConsentEvidence | null {
    const text = this.form.controls.evidenceText.value.trim();
    if (this.evidenceKind() === 'text')
      return text.length >= 10 ? { kind: 'text', text } : null;
    const file = this.attachment();
    return file && { kind: 'attachment', ...file };
  }

  private consent(): VoiceConsent | null {
    const evidence = this.evidence();
    if (!evidence) return null;
    const { subject, grantedBy, grantedByRole, grantedOn, method } =
      this.form.getRawValue();
    return {
      subject,
      grantedBy: grantedBy.trim(),
      grantedByRole: subject === 'deceased' ? grantedByRole.trim() : null,
      grantedOn,
      method,
      purpose: VOICE_CONSENT_PURPOSE,
      textVersion: VOICE_CONSENT_TEXT_VERSION,
      evidence,
    };
  }

  private saveFailed(err: unknown): void {
    this.busy.set(false);
    const status = err instanceof HttpErrorResponse ? err.status : 0;
    if (status === 422) {
      this.step.set('consent');
      return this.problem.set(
        $localize`:@@voiceConsent.refused:O consentimento não foi aceito. Confira os dados.`,
      );
    }
    this.problem.set(
      status === 409
        ? $localize`:@@voiceConsent.conflict:Esta pessoa já tem um perfil.`
        : $localize`:@@voiceConsent.failed:Não consegui cadastrar. Tente de novo.`,
    );
  }
}
