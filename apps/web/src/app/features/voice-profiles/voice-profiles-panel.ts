import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  topicListSchema,
  voiceProfileListSchema,
  type VoiceProfile,
} from '@kb-chat/contracts';
import { topicsUrl } from '@core/api/kb-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import {
  VoiceProfilesApi,
  voiceProfilesUrl,
} from '@core/media/voice-profiles-api.js';
import { STATUS_LABELS } from './consent-text.js';
import { VoiceProfileForm } from './voice-profile-form.js';
import { VoiceProfileReportView } from './voice-profile-report.js';

/** What the live region says after an action (UP-01), in words. */
interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

/**
 * "Perfis de voz" (KBC-071, ADR 0032): for a master granted it by name. The profiles of a
 * top-level collection, the form that asks for the consent first, revoking, and the owner's
 * report. Nothing on this screen ever holds a voice print (BR-5).
 */
@Component({
  selector: 'app-voice-profiles-panel',
  imports: [DatePipe, VoiceProfileForm, VoiceProfileReportView],
  templateUrl: './voice-profiles-panel.html',
  styleUrls: ['../settings/settings-form.css', './voice-profiles.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceProfilesPanel {
  private readonly api = inject(VoiceProfilesApi);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly isOwner = computed(
    () => this.session.me()?.isOwner === true,
  );
  private readonly topicList = httpResource(() => topicsUrl(), {
    parse: (body) => topicListSchema.parse(body),
  });
  /** Only top-level collections: a sub-collection uses its parent's profiles (BR-4). */
  protected readonly collections = computed(() =>
    this.topicList.hasValue()
      ? this.topicList.value().items.filter((topic) => topic.parent === null)
      : [],
  );
  /** Starts on the app's default collection, as the sidebar does. */
  protected readonly topic = linkedSignal(() => {
    const preferred = this.topicList.hasValue()
      ? this.topicList.value().defaultSlug
      : null;
    const collections = this.collections();
    return (
      collections.find(({ slug }) => slug === preferred)?.slug ??
      collections[0]?.slug ??
      ''
    );
  });
  protected readonly list = httpResource(
    () => (this.topic() ? voiceProfilesUrl(this.topic()) : undefined),
    { parse: (body) => voiceProfileListSchema.parse(body) },
  );
  protected readonly items = computed<VoiceProfile[]>(() =>
    this.list.hasValue() ? this.list.value().items : [],
  );
  protected readonly noTranscriber = computed(
    () => this.list.hasValue() && this.list.value().transcriber !== 'on',
  );
  protected readonly taken = computed(() =>
    this.items().map(({ speakerId }) => speakerId),
  );
  protected readonly statusOf = (profile: VoiceProfile): string =>
    STATUS_LABELS[profile.status]();
  protected readonly adding = signal(false);
  protected readonly confirming = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  /** Read again after a revocation. */
  protected readonly reportVersion = signal(0);

  protected chooseTopic(event: Event): void {
    this.topic.set((event.target as HTMLSelectElement).value);
    this.adding.set(false);
    this.confirming.set(null);
  }

  protected created(profile: VoiceProfile): void {
    this.adding.set(false);
    this.settle({
      kind: 'ok',
      text: $localize`:@@voiceProfiles.created:Consentimento registrado. Calculando o perfil de ${profile.speakerName}:name:.`,
    });
  }

  protected askRevoke(id: string): void {
    this.confirming.set(id);
    this.focus(`[data-cancel-revoke="${id}"]`);
  }

  protected cancelRevoke(id: string): void {
    this.confirming.set(null);
    this.focus(`[data-revoke="${id}"]`);
  }

  protected revokeLabelOf(profile: VoiceProfile): string {
    return $localize`:@@voiceProfiles.revokeLabel:Revogar o consentimento de ${profile.speakerName}:name:`;
  }

  protected revoke(profile: VoiceProfile): void {
    this.busy.set(true);
    this.notice.set(null);
    this.api
      .revoke(profile.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.confirming.set(null);
          this.reportVersion.update((version) => version + 1);
          this.settle({
            kind: 'ok',
            text: $localize`:@@voiceProfiles.revoked:Consentimento revogado. O perfil de ${profile.speakerName}:name: foi apagado.`,
          });
          this.focus('[data-list-title]');
        },
        error: () =>
          this.settle({
            kind: 'error',
            text: $localize`:@@voiceProfiles.revokeFailed:Não consegui revogar. Tente de novo.`,
          }),
      });
  }

  protected recalculate(profile: VoiceProfile): void {
    this.busy.set(true);
    this.notice.set(null);
    this.api
      .recalculate(profile.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.settle(null),
        error: () =>
          this.settle({
            kind: 'error',
            text: $localize`:@@voiceProfiles.recalculateFailed:Não consegui pedir o cálculo. Tente de novo.`,
          }),
      });
  }

  private settle(notice: Notice | null): void {
    this.busy.set(false);
    this.notice.set(notice);
    this.list.reload();
  }

  /** The focus never falls to the page when what held it goes away (WCAG 2.4.3). */
  private focus(selector: string): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }
}
