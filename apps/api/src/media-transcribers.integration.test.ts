import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteTranscriberStore } from './adapters/sqlite/sqlite-transcriber-store.js';
import { TranscriberService } from './modules/media/index.js';

const T0 = new Date('2026-11-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const VM_TOKEN = 'the-vm-worker-token-of-at-least-32-chars';
let clock: Date;
let store: SqliteTranscriberStore;
let service: TranscriberService;

const later = (ms: number) => (clock = new Date(clock.getTime() + ms));

beforeEach(() => {
  clock = T0;
  store = new SqliteTranscriberStore(
    openMediaDatabase(':memory:', MEDIA_MIGRATIONS),
  );
  service = new TranscriberService({
    store,
    tokenKey: Buffer.alloc(32, 3),
    vmToken: VM_TOKEN,
    now: () => clock,
  });
});
afterEach(() => (clock = T0));

describe('TranscriberService (KBC-036)', () => {
  it('names the VM worker by its token, for conversions, measures and cuts only', () => {
    expect(service.identify(VM_TOKEN)).toEqual({
      leaseName: null,
      kinds: ['transcode', 'silences', 'waveform', 'cut'],
    });
    expect(service.identify('')).toBeNull();
    expect(service.identify('not-a-paired-token')).toBeNull();
  });

  it('names a paired transcriber by its token, for transcriptions only', () => {
    const { token, transcriber } = service.pair({
      name: 'Mac',
      pairedBy: 'owner',
    });
    expect(service.identify(token)).toEqual({
      leaseName: `transcriber:${transcriber.id}`,
      kinds: ['transcribe'],
    });
    expect(service.identify(`${token}x`)).toBeNull();
  });

  it('a token hashed with another key opens nothing', () => {
    const { token } = service.pair({ name: 'Mac', pairedBy: 'owner' });
    const other = new TranscriberService({
      store,
      tokenKey: Buffer.alloc(32, 4),
      vmToken: VM_TOKEN,
    });
    expect(other.identify(token)).toBeNull();
  });

  it('is on while a transcriber was seen within the hour, then off since then (FR-1)', () => {
    expect(service.presence()).toEqual({ transcriber: 'none', offSince: null });
    const { token } = service.pair({ name: 'Mac', pairedBy: 'owner' });
    expect(service.presence()).toEqual({
      transcriber: 'off',
      offSince: T0.toISOString(),
    });
    later(5_000);
    service.identify(token);
    const seenAt = clock.toISOString();
    expect(service.presence()).toEqual({ transcriber: 'on', offSince: null });
    later(2 * HOUR);
    service.pair({ name: 'Mac novo', pairedBy: 'owner' });
    // Off since the last time one was seen, not since the newest pairing.
    expect(service.presence()).toEqual({
      transcriber: 'off',
      offSince: seenAt,
    });
  });

  it('records a visit at most every 10 s', () => {
    const { token, transcriber } = service.pair({
      name: 'Mac',
      pairedBy: 'owner',
    });
    service.identify(token);
    later(3_000);
    service.identify(token);
    expect(service.list()[0]?.lastSeenAt).toBe(T0.toISOString());
    later(10_000);
    service.identify(token);
    expect(service.list()).toMatchObject([
      { id: transcriber.id, lastSeenAt: clock.toISOString(), online: true },
    ]);
  });

  it('refuses to revoke an unknown transcriber', () => {
    expect(() =>
      service.revoke('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    ).toThrow(/Unknown transcriber/);
  });
});
