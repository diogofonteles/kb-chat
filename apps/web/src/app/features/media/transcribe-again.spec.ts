import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { aMediaItem, aTranscription } from '../../testing/media-fixtures.js';
import { TranscribeAgain } from './transcribe-again.js';

describe('TranscribeAgain (KBC-040 FR-3)', () => {
  let fixture: ComponentFixture<TranscribeAgain>;
  let http: HttpTestingController;
  const item = aMediaItem({
    canTranscribeAgain: true,
    transcription: aTranscription({ status: 'done', version: 1 }),
  });
  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const buttons = () => [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
  ];
  const press = async (name: string, at = 0) => {
    buttons()
      .filter((one) => one.textContent?.trim() === name)
      [at]?.click();
    await fixture.whenStable();
  };

  async function show(media = item) {
    ({ fixture } = await render(TranscribeAgain, {
      inputs: { media },
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }));
    http = TestBed.inject(HttpTestingController);
  }

  afterEach(() => http.verify());

  it('never asks the API on the first click: a person confirms', async () => {
    await show();
    await press('Transcrever de novo');
    expect(text()).toContain('O texto atual continua');
    http.expectNone(`/api/v1/media/${item.id}/transcription`);
    await press('Cancelar');
    expect(buttons().map((one) => one.textContent?.trim())).toEqual([
      'Transcrever de novo',
    ]);
  });

  it('queues the job on the confirmation and hands the item back', async () => {
    await show();
    const queued: unknown[] = [];
    fixture.componentInstance.queued.subscribe((one) => queued.push(one));
    await press('Transcrever de novo');
    await press('Transcrever de novo');
    const after = {
      ...item,
      canTranscribeAgain: false,
      transcription: aTranscription({ status: 'waiting', version: 1 }),
    };
    http.expectOne(`/api/v1/media/${item.id}/transcription`).flush(after);
    await fixture.whenStable();
    expect(queued).toEqual([after]);
  });

  it('says why it could not be asked', async () => {
    await show();
    await press('Transcrever de novo');
    await press('Transcrever de novo');
    http
      .expectOne(`/api/v1/media/${item.id}/transcription`)
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'no' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(text()).toContain('Esta mídia mudou');
  });

  it('sends one request for a double click on the confirmation', async () => {
    await show();
    await press('Transcrever de novo');
    const confirm = buttons()[0];
    confirm?.click();
    confirm?.click();
    await fixture.whenStable();
    http
      .expectOne(`/api/v1/media/${item.id}/transcription`)
      .flush({ ...item, canTranscribeAgain: false });
    await fixture.whenStable();
    expect(text()).not.toContain('Esta mídia mudou');
  });

  it('keeps the focus in place after the confirmation (WCAG 2.4.3)', async () => {
    await show();
    fixture.componentInstance.queued.subscribe((one) =>
      fixture.componentRef.setInput('media', one),
    );
    await press('Transcrever de novo');
    await press('Transcrever de novo');
    http
      .expectOne(`/api/v1/media/${item.id}/transcription`)
      .flush({ ...item, canTranscribeAgain: false });
    await fixture.whenStable();
    expect(document.activeElement).toBe(fixture.nativeElement);
  });

  it('gives the focus back to the question when it could not be asked', async () => {
    await show();
    await press('Transcrever de novo');
    buttons()[0]?.focus();
    await press('Transcrever de novo');
    http
      .expectOne(`/api/v1/media/${item.id}/transcription`)
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'no' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(document.activeElement?.textContent?.trim()).toBe('Cancelar');
  });

  it('says a failed attempt kept the text', async () => {
    await show({
      ...item,
      transcription: aTranscription({
        status: 'done',
        version: 1,
        lastAttemptFailed: true,
      }),
    });
    expect(text()).toContain(
      'A nova transcrição falhou. O texto atual foi mantido.',
    );
  });

  it('shows nothing to whoever may not ask', async () => {
    await show({ ...item, canTranscribeAgain: false });
    expect(buttons()).toEqual([]);
  });
});
