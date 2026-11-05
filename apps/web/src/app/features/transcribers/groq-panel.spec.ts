import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { GroqSettings } from '@kb-chat/contracts';
import { GroqPanel } from './groq-panel.js';

const OFF: GroqSettings = {
  connected: false,
  mode: 'never',
  idleHours: 12,
  month: { spentUsd: 1.5, capUsd: 10 },
  canEditCap: true,
};

describe('GroqPanel (KBC-037)', () => {
  let fixture: ComponentFixture<GroqPanel>;
  let http: HttpTestingController;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent?.replace(/\s+/g, ' ') ?? '';

  const button = (name: string): HTMLButtonElement => {
    const found = [...root().querySelectorAll('button')].find(
      (one) => one.textContent?.trim() === name,
    );
    if (!found) throw new Error(`no button "${name}"`);
    return found;
  };

  async function open(settings: GroqSettings = OFF) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    fixture = TestBed.createComponent(GroqPanel);
    http = TestBed.inject(HttpTestingController);
    TestBed.tick();
    http.expectOne('/api/v1/media/groq').flush(settings);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  async function type(selector: string, value: string) {
    const field = root().querySelector<HTMLInputElement>(selector);
    if (!field) throw new Error(`no ${selector}`);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
  }

  const status = (index: number) =>
    root().querySelectorAll('[role="status"]')[index]?.textContent?.trim();

  afterEach(() => http.verify());

  it('starts in "Nunca", shows the month against the cap, and never a key (BR-1, FR-5)', async () => {
    await open();
    const never = root().querySelector<HTMLInputElement>(
      'input[value="never"]',
    );
    expect(never?.checked).toBe(true);
    expect(text()).toContain('US$ 1,50 de US$ 10,00');
    expect(root().querySelector<HTMLInputElement>('#groq-key')?.type).toBe(
      'password',
    );
  });

  it('tests a pasted key and says why Groq refused it (AC-5)', async () => {
    await open();
    await type('#groq-key', 'gsk_wrong');
    button('Testar conexão').click();
    await fixture.whenStable();
    const request = http.expectOne('/api/v1/media/groq/test');
    expect(request.request.body).toEqual({ key: 'gsk_wrong' });
    request.flush({ ok: false, reason: 'key-rejected' });
    await fixture.whenStable();
    expect(status(0)).toContain('A chave não foi aceita pelo Groq.');
  });

  it('says "Conectado" and empties the field when Groq accepts the key (FR-1)', async () => {
    await open();
    await type('#groq-key', 'gsk_valid');
    button('Testar conexão').click();
    await fixture.whenStable();
    http
      .expectOne('/api/v1/media/groq/test')
      .flush({ ok: true, settings: { ...OFF, connected: true } });
    await fixture.whenStable();
    expect(status(0)).toContain('Conectado.');
    expect(root().querySelector<HTMLInputElement>('#groq-key')?.value).toBe('');
    expect(text()).toContain('Chave conectada');
  });

  it('asks for a key before testing when none is connected, sending nothing', async () => {
    await open();
    button('Testar conexão').click();
    await fixture.whenStable();
    expect(status(0)).toContain('Cole a chave do Groq antes de testar.');
  });

  it('saves "parado há mais de N horas" with N, refusing N out of range', async () => {
    await open({ ...OFF, connected: true });
    root().querySelector<HTMLInputElement>('input[value="idle"]')?.click();
    await fixture.whenStable();
    await type('#groq-hours', '0');
    expect(text()).toContain('Use um número inteiro de 1 a 168.');
    button('Salvar modo').click();
    await fixture.whenStable();
    http.expectNone('/api/v1/media/groq/mode');
    await type('#groq-hours', '6');
    button('Salvar modo').click();
    await fixture.whenStable();
    const saved = http.expectOne('/api/v1/media/groq/mode');
    expect(saved.request.body).toEqual({ mode: 'idle', idleHours: 6 });
    saved.flush({ ...OFF, connected: true, mode: 'idle', idleHours: 6 });
    await fixture.whenStable();
    expect(status(1)).toContain('Modo salvo.');
  });

  it('lets the owner change the cap; another master only reads it (BR-2)', async () => {
    await open();
    await type('#groq-cap', '25');
    button('Salvar teto').click();
    await fixture.whenStable();
    const saved = http.expectOne('/api/v1/media/spend-cap');
    expect(saved.request.body).toEqual({ capUsd: 25 });
    saved.flush({ ...OFF, month: { spentUsd: 1.5, capUsd: 25 } });
    await fixture.whenStable();
    expect(text()).toContain('US$ 1,50 de US$ 25,00');
  });

  it('shows the cap without a field to a master who is not the owner', async () => {
    await open({ ...OFF, canEditCap: false });
    expect(root().querySelector('#groq-cap')).toBeNull();
    expect(text()).toContain('Só o dono muda o teto.');
  });

  it('says it could not save when the API fails', async () => {
    await open({ ...OFF, connected: true });
    button('Remover chave').click();
    await fixture.whenStable();
    http
      .expectOne('/api/v1/media/groq/key')
      .flush({}, { status: 500, statusText: 'Error' });
    await fixture.whenStable();
    expect(status(0)).toContain('Não consegui salvar. Tente de novo.');
  });
});
