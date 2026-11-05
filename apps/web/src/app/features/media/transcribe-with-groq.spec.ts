import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { MediaItem } from '@kb-chat/contracts';
import { aMediaItem, aTranscription } from '../../testing/media-fixtures.js';
import { TranscribeWithGroq } from './transcribe-with-groq.js';

describe('TranscribeWithGroq (KBC-037)', () => {
  let fixture: ComponentFixture<TranscribeWithGroq>;
  let http: HttpTestingController;
  const root = () => fixture.nativeElement as HTMLElement;
  const button = (name: string) =>
    [...root().querySelectorAll('button')].find(
      (one) => one.textContent?.trim() === name,
    );

  async function open(media: MediaItem) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(TranscribeWithGroq);
    fixture.componentRef.setInput('media', media);
    await fixture.whenStable();
  }

  const waiting = aMediaItem({
    canUseGroq: true,
    durationMs: 3_600_000,
    transcription: aTranscription({ status: 'waiting', transcriber: 'off' }),
  });

  afterEach(() => http.verify());

  it('is not offered when Groq may not take the item', async () => {
    await open(aMediaItem());
    expect(button('Transcrever com Groq')).toBeUndefined();
  });

  it('asks first, with the estimate, and sends once on confirm', async () => {
    await open(waiting);
    const sent: MediaItem[] = [];
    fixture.componentInstance.sent.subscribe((item) => sent.push(item));
    button('Transcrever com Groq')?.click();
    await fixture.whenStable();
    expect(root().textContent?.replace(/\s+/g, ' ')).toContain(
      'Custa cerca de US$ 0,04',
    );
    const confirm = button('Transcrever com Groq');
    confirm?.click();
    confirm?.click();
    await fixture.whenStable();
    const request = http.expectOne(
      `/api/v1/media/${waiting.id}/transcription/groq`,
    );
    const routed = {
      ...waiting,
      canUseGroq: false,
      transcription: aTranscription({ status: 'waiting', route: 'groq' }),
    };
    request.flush(routed);
    await fixture.whenStable();
    expect(sent).toEqual([routed]);
  });

  it('says the monthly cap was reached when the API refuses for it (AC-3)', async () => {
    await open(waiting);
    button('Transcrever com Groq')?.click();
    await fixture.whenStable();
    button('Transcrever com Groq')?.click();
    await fixture.whenStable();
    http
      .expectOne(`/api/v1/media/${waiting.id}/transcription/groq`)
      .flush(
        { error: { code: 'MEDIA_SPEND_CAP', message: 'cap' } },
        { status: 429, statusText: 'Too Many Requests' },
      );
    await fixture.whenStable();
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      'Teto mensal de mídia atingido',
    );
  });
});
