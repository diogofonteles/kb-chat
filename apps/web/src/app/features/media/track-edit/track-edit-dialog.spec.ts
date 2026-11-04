import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { TrackEditView } from '@kb-chat/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrackEditDialog } from './track-edit-dialog.js';

const ID = '11111111-1111-4111-8111-111111111111';
const RECORDING = '22222222-2222-4222-8222-222222222222';

const view = (over: Partial<TrackEditView> = {}): TrackEditView => ({
  mediaId: ID,
  recordingId: RECORDING,
  recordingTitle: 'Gravação',
  topic: 'hermetismo',
  version: 3,
  title: 'Título antigo',
  summary: null,
  ordinal: 1,
  startMs: 0,
  endMs: 60_000,
  recordingDurationMs: 600_000,
  asker: { voice: null, speakerId: null, name: null },
  answerer: { voice: 1, speakerId: null, name: 'Maria' },
  cut: 'none',
  locked: false,
  tracks: [],
  ...over,
});

describe('TrackEditDialog (KBC-073)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function close() {
      this.removeAttribute('open');
    };
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(track = view()) {
    const fixture = TestBed.createComponent(TrackEditDialog);
    fixture.componentRef.setInput('track', track);
    TestBed.tick();
    http.expectOne('/api/v1/topics/hermetismo/speakers').flush({ items: [] });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const field = (label: string) => {
      const found = root.querySelector<HTMLInputElement>(`#${label}`);
      if (!found) throw new Error(label);
      return found;
    };
    return { fixture, root, field };
  }

  it('sends only what changed, with the version it read', async () => {
    const { fixture, field, root } = await open();
    const title = field('track-title');
    title.value = 'Título novo';
    title.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    root.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    const request = http.expectOne(`/api/v1/media/${ID}`);
    expect(request.request.body).toEqual({ title: 'Título novo' });
    expect(request.request.headers.get('If-Match')).toBe('"3"');
    request.flush(null, { status: 500, statusText: 'x' });
  });

  it('BR-10: a 412 shows the other title and keeps what was typed', async () => {
    const { fixture, field, root } = await open();
    const title = field('track-title');
    title.value = 'O meu';
    title.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    root.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    http
      .expectOne(`/api/v1/media/${ID}`)
      .flush(null, { status: 412, statusText: 'Precondition Failed' });
    await fixture.whenStable();
    http
      .expectOne(`/api/v1/media/${ID}/track-edit`)
      .flush(view({ title: 'O dela', version: 4 }));
    await fixture.whenStable();

    expect(root.textContent).toContain('O dela');
    expect(field('track-title').value).toBe('O meu');
  });

  it('offers the whole recording only for a role with a voice', async () => {
    const { fixture, field, root } = await open();
    expect(root.textContent).not.toContain('Em toda a gravação');

    const answerer = field('track-answerer');
    answerer.value = 'José';
    answerer.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(root.textContent).toContain('Em toda a gravação');

    answerer.value = 'Maria';
    answerer.dispatchEvent(new Event('input'));
    const asker = field('track-asker');
    asker.value = 'Pedro';
    asker.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(root.textContent).not.toContain('Em toda a gravação');
  });
});
