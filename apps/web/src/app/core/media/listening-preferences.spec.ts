import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MEDIA_COMPLETION_RATIO, MEDIA_SPEEDS } from '@kb-chat/contracts';
import { COMPLETION_RATIO, SPEEDS } from '@kb-chat/player-core';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { PREFERENCES_URL } from './listening-api.js';
import { ListeningPreferences } from './listening-preferences.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';

/** A whole answer of the account, when what it holds does not matter to the test. */
const ACCOUNT = {
  speed: 1,
  showRemaining: true,
  skipBackSec: 15,
  skipForwardSec: 30,
  skipSilences: false,
  wordHighlight: true,
};

function setup() {
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
    ],
  });
  return {
    preferences: TestBed.inject(ListeningPreferences),
    engine: TestBed.inject(MediaEngine),
    http: TestBed.inject(HttpTestingController),
    media,
  };
}

describe('ListeningPreferences (KBC-041 FR-1, BR-1)', () => {
  it('offers the same speeds and the same 95% rule as the API (one rule, two libraries)', () => {
    expect([...SPEEDS]).toEqual([...MEDIA_SPEEDS]);
    expect(COMPLETION_RATIO).toBe(MEDIA_COMPLETION_RATIO);
  });

  it('reads the account once and gives its speed to the engine', () => {
    const { preferences, engine, http } = setup();
    preferences.load();
    preferences.load();
    http.expectOne(PREFERENCES_URL).flush({
      speed: 1.25,
      showRemaining: false,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    expect(preferences.value()).toEqual({
      speed: 1.25,
      showRemaining: false,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    expect(engine.speed()).toBe(1.25);
  });

  it('plays the chosen speed at once and saves it to the account', () => {
    const { preferences, engine, http } = setup();
    preferences.setSpeed(1.5);
    expect(engine.speed()).toBe(1.5);
    const put = http.expectOne({ method: 'PUT', url: PREFERENCES_URL });
    expect(put.request.body).toEqual({ speed: 1.5 });
    put.flush({
      speed: 1.5,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
  });

  it('steps the speed one menu step, stopping at the ends (FR-5)', () => {
    const { preferences, http } = setup();
    preferences.stepSpeed(1);
    expect(preferences.value().speed).toBe(1.25);
    preferences.setSpeed(2);
    preferences.stepSpeed(1);
    expect(preferences.value().speed).toBe(2);
    http.match(PREFERENCES_URL).forEach((request) => request.flush({}));
  });

  it('switches between remaining time and total length, and remembers it', () => {
    const { preferences, http } = setup();
    preferences.toggleShowRemaining();
    expect(preferences.value().showRemaining).toBe(false);
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ showRemaining: false });
  });

  it('keeps the choice in use when the account cannot be read or saved', () => {
    const { preferences, http } = setup();
    preferences.setSpeed(1.75);
    http
      .expectOne({ method: 'PUT', url: PREFERENCES_URL })
      .flush(null, { status: 500, statusText: 'x' });
    expect(preferences.value().speed).toBe(1.75);
    preferences.load();
    http
      .expectOne({ method: 'GET', url: PREFERENCES_URL })
      .flush(null, { status: 500, statusText: 'x' });
    expect(preferences.value().speed).toBe(1.75);
  });

  it('reads again after a failed read, and never undoes a choice made meanwhile', () => {
    const { preferences, engine, http } = setup();
    preferences.load();
    http
      .expectOne({ method: 'GET', url: PREFERENCES_URL })
      .flush(null, { status: 500, statusText: 'x' });
    preferences.load();
    preferences.setSpeed(2);
    http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).flush({});
    http.expectOne({ method: 'GET', url: PREFERENCES_URL }).flush({
      speed: 0.75,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    expect(preferences.value().speed).toBe(2);
    expect(engine.speed()).toBe(2);
  });

  it('saves changes one after the other, so the account ends with the last one', () => {
    const { preferences, http } = setup();
    preferences.stepSpeed(1);
    preferences.stepSpeed(1);
    const first = http.match({ method: 'PUT', url: PREFERENCES_URL });
    expect(first.length).toBe(1);
    first[0]?.flush({
      speed: 1.25,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    const second = http.expectOne({ method: 'PUT', url: PREFERENCES_URL });
    expect(second.request.body).toEqual({ speed: 1.5 });
  });

  it('saves "Destacar palavra a palavra" to the account, on until turned off (KBC-045)', () => {
    const { preferences, http } = setup();
    expect(preferences.value().wordHighlight).toBe(true);
    preferences.setWordHighlight(false);
    expect(preferences.value().wordHighlight).toBe(false);
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ wordHighlight: false });
  });

  it('leaves a choice saved elsewhere alone when another one changes here (KBC-045 F-1)', () => {
    const { preferences, http } = setup();
    preferences.load();
    http.expectOne({ method: 'GET', url: PREFERENCES_URL }).flush({
      speed: 1,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: true,
      wordHighlight: true,
    });
    // Another tab or device turned the highlight off after this one read the account.
    preferences.setSpeed(1.5);
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ speed: 1.5 });
  });

  it('touches only the changed choice when the account could not be read', () => {
    const { preferences, http } = setup();
    preferences.load();
    http
      .expectOne({ method: 'GET', url: PREFERENCES_URL })
      .flush(null, { status: 500, statusText: 'x' });
    preferences.setSpeed(1.5);
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ speed: 1.5 });
  });

  it('shows the account over the defaults for what was not changed before it answered', () => {
    const { preferences, http } = setup();
    preferences.load();
    preferences.setSpeed(1.5);
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ speed: 1.5 });
    http.expectOne({ method: 'GET', url: PREFERENCES_URL }).flush({
      speed: 0.75,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: true,
      wordHighlight: false,
    });
    expect(preferences.value()).toMatchObject({
      speed: 1.5,
      skipSilences: true,
      wordHighlight: false,
    });
  });

  it('saves a failed choice again with the next change, the later one winning', () => {
    const { preferences, http } = setup();
    preferences.setWordHighlight(false);
    preferences.setSpeed(1.25);
    http
      .expectOne({ method: 'PUT', url: PREFERENCES_URL })
      .flush(null, { status: 500, statusText: 'x' });
    const second = http.expectOne({ method: 'PUT', url: PREFERENCES_URL });
    expect(second.request.body).toEqual({ wordHighlight: false, speed: 1.25 });
    second.flush(null, { status: 500, statusText: 'x' });
    preferences.setSpeed(1.5);
    const third = http.expectOne({ method: 'PUT', url: PREFERENCES_URL });
    expect(third.request.body).toEqual({ wordHighlight: false, speed: 1.5 });
    third.flush(ACCOUNT);
    preferences.setSkipBack(5);
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ skipBackSec: 5 });
  });

  it('keeps the skips the person chose and gives them in ms (KBC-043)', () => {
    const { preferences, http } = setup();
    expect(preferences.skipBackMs()).toBe(15_000);
    expect(preferences.skipForwardMs()).toBe(30_000);
    preferences.setSkipBack(5);
    expect(preferences.skipBackMs()).toBe(5_000);
    const put = http.expectOne({ method: 'PUT', url: PREFERENCES_URL });
    expect(put.request.body).toEqual({ skipBackSec: 5 });
    put.flush(ACCOUNT);
    preferences.setSkipForward(45);
    expect(preferences.skipForwardMs()).toBe(45_000);
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ skipForwardSec: 45 });
  });
});
