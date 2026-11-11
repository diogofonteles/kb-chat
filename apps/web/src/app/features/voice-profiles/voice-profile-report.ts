import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {
  voiceProfileReportSchema,
  type VoiceConsentEntry,
} from '@kb-chat/contracts';
import {
  consentEvidenceUrl,
  voiceReportUrl,
} from '@core/media/voice-profiles-api.js';
import { METHOD_LABELS, SUBJECT_LABELS } from './consent-text.js';

/** "Perfis e consentimentos" (KBC-071 FR-5, AC-8), for the owner. */
@Component({
  selector: 'app-voice-profile-report',
  imports: [DatePipe],
  templateUrl: './voice-profile-report.html',
  styleUrls: ['../settings/settings-form.css', './voice-profiles.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceProfileReportView {
  /** Changes when something on the screen changed the report. */
  readonly version = input.required<number>();

  protected readonly report = httpResource(
    () => {
      this.version();
      return voiceReportUrl();
    },
    { parse: (body) => voiceProfileReportSchema.parse(body) },
  );
  protected readonly entries = computed(() =>
    this.report.hasValue()
      ? this.report.value().items.map((entry) => ({
          ...entry,
          methodLabel: METHOD_LABELS[entry.method](),
          subjectLabel: SUBJECT_LABELS[entry.subject](),
          evidenceUrl: consentEvidenceUrl(entry.id),
        }))
      : [],
  );

  protected track(entry: VoiceConsentEntry): string {
    return entry.id;
  }
}
