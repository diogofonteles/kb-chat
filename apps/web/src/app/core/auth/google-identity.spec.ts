import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  GIS_SCRIPT_URL,
  GoogleIdentity,
  type GoogleAccountsId,
} from './google-identity.js';

interface GoogleGlobal {
  google?: { accounts: { id: GoogleAccountsId } };
}

const fakeAccounts: GoogleAccountsId = {
  initialize: () => undefined,
  renderButton: () => undefined,
  disableAutoSelect: vi.fn(),
};

const scripts = () =>
  [...document.head.querySelectorAll('script')].filter(
    (s) => s.src === GIS_SCRIPT_URL,
  );

function setup() {
  for (const script of scripts()) script.remove();
  delete (window as GoogleGlobal).google;
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  });
  return TestBed.inject(GoogleIdentity);
}

describe('GoogleIdentity (ADR 0008)', () => {
  it('loads the Google Identity Services script once and hands out google.accounts.id', () => {
    const google = setup();
    const received: GoogleAccountsId[] = [];
    google.accounts$.subscribe((accounts) => received.push(accounts));
    google.accounts$.subscribe((accounts) => received.push(accounts));

    expect(scripts()).toHaveLength(1);
    (window as GoogleGlobal).google = { accounts: { id: fakeAccounts } };
    scripts()[0]?.onload?.(new Event('load'));

    expect(received).toEqual([fakeAccounts, fakeAccounts]);
    google.disableAutoSelect();
    expect(fakeAccounts.disableAutoSelect).toHaveBeenCalled();
  });

  it('uses the script already on the page', () => {
    const google = setup();
    (window as GoogleGlobal).google = { accounts: { id: fakeAccounts } };
    let received: GoogleAccountsId | undefined;
    google.accounts$.subscribe((accounts) => (received = accounts));

    expect(received).toBe(fakeAccounts);
    expect(scripts()).toHaveLength(0);
  });

  it('fails when the script cannot load', () => {
    const errors: unknown[] = [];
    setup().accounts$.subscribe({ error: (err: unknown) => errors.push(err) });
    scripts()[0]?.onerror?.(new Event('error'));
    expect(errors).toHaveLength(1);
  });

  it('fails when the script loads but Google does not start', () => {
    const errors: unknown[] = [];
    setup().accounts$.subscribe({ error: (err: unknown) => errors.push(err) });
    scripts()[0]?.onload?.(new Event('load'));
    expect(errors).toHaveLength(1);
  });
});
