import { TestBed } from '@angular/core/testing';
import { PlayerAnnouncer } from './player-announcer.js';
import { TranscriptPreferences } from './transcript-preferences.js';

describe('TranscriptPreferences (KBC-038 FR-6, FR-9)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('starts with subtitles off and the transcript shown', () => {
    const preferences = TestBed.inject(TranscriptPreferences);
    expect(preferences.captionsOn()).toBe(false);
    expect(preferences.transcriptCollapsed()).toBe(false);
  });

  it('remembers both choices in this browser, for every media', () => {
    const first = TestBed.inject(TranscriptPreferences);
    first.toggleCaptions();
    first.setTranscriptCollapsed(true);
    TestBed.resetTestingModule();
    const again = TestBed.inject(TranscriptPreferences);
    expect(again.captionsOn()).toBe(true);
    expect(again.transcriptCollapsed()).toBe(true);
  });

  it('says the subtitles changed in the player status region', () => {
    const preferences = TestBed.inject(TranscriptPreferences);
    const announcer = TestBed.inject(PlayerAnnouncer);
    preferences.toggleCaptions();
    expect(announcer.message()).toBe('Legendas ligadas');
    preferences.toggleCaptions();
    expect(announcer.message()).toBe('Legendas desligadas');
  });

  it('shows who speaks by default and remembers turning it off (KBC-065 FR-4)', () => {
    const first = TestBed.inject(TranscriptPreferences);
    expect(first.speakersOn()).toBe(true);
    first.toggleSpeakers();
    expect(first.speakersOn()).toBe(false);
    TestBed.resetTestingModule();
    expect(TestBed.inject(TranscriptPreferences).speakersOn()).toBe(false);
  });

  it('still works when the browser keeps nothing (a private window)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const preferences = TestBed.inject(TranscriptPreferences);
    expect(preferences.captionsOn()).toBe(false);
    expect(preferences.speakersOn()).toBe(true);
    preferences.toggleCaptions();
    expect(preferences.captionsOn()).toBe(true);
  });
});
