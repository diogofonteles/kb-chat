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

  /** ⋯ "Transcrever de novo" on the page asks the question (v2: no button of its own). */
  const open = async () => {
    fixture.componentInstance.ask();
    await fixture.whenStable();
  };
  const dialogOpen = () =>
    (fixture.nativeElement as HTMLElement)
      .querySelector('dialog')
      ?.hasAttribute('open') ?? false;

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
    await open();
    expect(dialogOpen()).toBe(true);
    expect(text()).toContain('O texto atual continua');
    http.expectNone(`/api/v1/media/${item.id}/transcription`);
    await press('Cancelar');
    expect(dialogOpen()).toBe(false);
    http.expectNone(`/api/v1/media/${item.id}/transcription`);
  });

  it('queues the job on the confirmation and hands the item back', async () => {
    await show();
    const queued: unknown[] = [];
    fixture.componentInstance.queued.subscribe((one) => queued.push(one));
    await open();
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
    await open();
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
    await open();
    const confirm = buttons().find(
      (one) => one.textContent?.trim() === 'Transcrever de novo',
    );
    confirm?.click();
    confirm?.click();
    await fixture.whenStable();
    http
      .expectOne(`/api/v1/media/${item.id}/transcription`)
      .flush({ ...item, canTranscribeAgain: false });
    await fixture.whenStable();
    expect(text()).not.toContain('Esta mídia mudou');
  });

  it('closes after the confirmation, for the page to give the focus back to ⋯ (WCAG 2.4.3)', async () => {
    await show();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => (closed += 1));
    fixture.componentInstance.queued.subscribe((one) =>
      fixture.componentRef.setInput('media', one),
    );
    await open();
    await press('Transcrever de novo');
    http
      .expectOne(`/api/v1/media/${item.id}/transcription`)
      .flush({ ...item, canTranscribeAgain: false });
    await fixture.whenStable();
    expect(dialogOpen()).toBe(false);
    expect(closed).toBe(1);
  });

  it('gives the focus back to the question when it could not be asked', async () => {
    await show();
    await open();
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
    // The page offers it in ⋯ only to who may ask (KBC-129); here nothing opens by itself.
    expect(dialogOpen()).toBe(false);
    expect(text()).not.toContain('A nova transcrição falhou');
  });
});
