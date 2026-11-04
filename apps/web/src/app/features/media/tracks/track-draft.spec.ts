import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DraftTrack, MediaEdit, ProposalRun } from '@kb-chat/contracts';
import type { Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { SAVE_DELAY_MS, TrackDraft } from './track-draft.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const URL = `/api/v1/media/${MEDIA}/edit`;
const APPROVE = `${URL}/approve`;
const PROPOSE = `${URL}/proposals`;
const POLL_MS = 5_000;
const JOURNAL = `kb-chat.track-draft..${MEDIA}`;

const track = (n: number, startMs: number, endMs: number): DraftTrack => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  runId: null,
  source: 'manual',
  edited: false,
  firstSegment: null,
  lastSegment: null,
  startMs,
  endMs,
  kind: 'qa',
  title: `Faixa ${n}`,
  askerVoice: null,
  answererVoice: null,
  askerSpeakerId: null,
  answererSpeakerId: null,
});

const edit = (
  tracks: DraftTrack[],
  version = 4,
  overrides: Partial<MediaEdit> = {},
): MediaEdit => ({
  mediaId: MEDIA,
  version,
  started: true,
  status: 'draft',
  step: 3,
  tracks,
  run: null,
  lastFailure: null,
  voices: [],
  approvedTracks: 0,
  transcriptChanged: false,
  ...overrides,
});

const RUN: ProposalRun = {
  id: '22222222-2222-4222-8222-222222222222',
  mediaId: MEDIA,
  status: 'running',
  model: 'stub',
  windowsTotal: 2,
  windowsDone: 0,
  tracks: 0,
  estimateUsd: 0.01,
  spentUsd: 0,
  failure: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  finishedAt: null,
};

/** Everything an observable said, to see that nothing came, or came twice. */
function heard<T>(source: Observable<T>): T[] {
  const said: T[] = [];
  source.subscribe({
    next: (value) => said.push(value),
    error: () => undefined,
  });
  return said;
}

describe('TrackDraft (KBC-066)', () => {
  let scope: EnvironmentInjector;
  let draft: TrackDraft;
  let http: HttpTestingController;
  const one = track(1, 0, 10_000);
  const two = track(2, 10_000, 20_000);

  const open = (read: MediaEdit = edit([one, two])) => {
    draft.open(MEDIA);
    http.expectOne({ method: 'GET', url: URL }).flush(read);
  };
  const saves = () => http.expectOne({ method: 'PUT', url: URL });
  const reads = () => http.expectOne({ method: 'GET', url: URL });
  const noSave = () => http.expectNone({ method: 'PUT', url: URL });
  const noApproval = () => http.expectNone(APPROVE);
  const noRun = () => http.expectNone(PROPOSE);
  const change = (tracks: DraftTrack[] = [one]) => {
    draft.apply(tracks);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
  };
  const refuse = (status: number, details?: object) =>
    saves().flush(
      { error: { code: 'INTERNAL', message: 'no', details } },
      { status, statusText: 'No' },
    );
  const lose = () => saves().error(new ProgressEvent('error'));
  /** A save someone else got ahead of: the read after the 412 shows their draft. */
  const conflict = () => {
    change();
    refuse(412);
    reads().flush(edit([two], 9));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MEDIA_POLL_MS, useValue: POLL_MS },
      ],
    });
    scope = createEnvironmentInjector(
      [TrackDraft],
      TestBed.inject(EnvironmentInjector),
    );
    draft = scope.get(TrackDraft);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    http.verify();
  });

  describe('saving', () => {
    beforeEach(() => open());

    it('saves within a second of the last change, with the version it read (BR-6)', () => {
      draft.apply([one]);
      draft.apply([two]);
      vi.advanceTimersByTime(SAVE_DELAY_MS - 1);
      noSave();
      vi.advanceTimersByTime(1);
      const save = saves();
      expect(save.request.headers.get('If-Match')).toBe('"4"');
      expect(save.request.body.tracks.map((t: DraftTrack) => t.id)).toEqual([
        two.id,
      ]);
      save.flush({ version: 5 });
      expect(draft.saved()).toBe(true);
      expect(draft.announcement()).toBe('Rascunho salvo');
    });

    it('undoes and redoes, saving each state (AC-9)', () => {
      draft.apply([two]);
      draft.undo();
      expect(draft.tracks()).toEqual([one, two]);
      expect(draft.canRedo()).toBe(true);
      draft.redo();
      expect(draft.tracks()).toEqual([two]);
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      saves().flush({ version: 5 });
    });

    it('never has two saves at once; the newest state goes next', () => {
      change();
      const first = saves();
      change([two]);
      noSave();
      first.flush({ version: 5 });
      const second = saves();
      expect(second.request.headers.get('If-Match')).toBe('"5"');
      expect(second.request.body.tracks).toHaveLength(1);
      second.flush({ version: 6 });
    });

    it('waits without a network and sends when it comes back', () => {
      change();
      lose();
      expect(draft.phase().kind).toBe('offline');
      window.dispatchEvent(new Event('online'));
      saves().flush({ version: 5 });
      expect(draft.saved()).toBe(true);
    });

    it('takes more changes without a network, and tries again by itself', () => {
      change();
      lose();
      draft.apply([two]);
      expect(draft.phase().kind).toBe('offline');
      vi.advanceTimersByTime(5_000);
      const retried = saves();
      expect(retried.request.body.tracks).toHaveLength(1);
      expect(retried.request.body.tracks[0].id).toBe(two.id);
      retried.flush({ version: 5 });
    });

    it('stays stopped after a passing refusal until asked, and keeps the tracks (R-6)', () => {
      change();
      refuse(429);
      expect(draft.phase().kind).toBe('failed');
      expect(draft.tracks()).toEqual([one]);
      vi.advanceTimersByTime(60_000);
      noSave();
      draft.retry();
      saves().flush({ version: 5 });
      expect(draft.saved()).toBe(true);
    });

    it('saves again with the next change after a refusal', () => {
      change();
      refuse(500);
      change([two]);
      saves().flush({ version: 5 });
      expect(draft.saved()).toBe(true);
    });
  });

  describe('flush answers its caller and stores nothing (R-1)', () => {
    beforeEach(() => open());

    it('says saved at once with nothing to save', () => {
      expect(heard(draft.flush())).toEqual(['saved']);
    });

    it('sends what waits now, and says saved once, when it came back', () => {
      draft.apply([one]);
      const said = heard(draft.flush());
      expect(said).toEqual([]);
      saves().flush({ version: 5 });
      expect(said).toEqual(['saved']);
    });

    it('waits for the save in flight and for the newer one it leaves behind', () => {
      change();
      const first = saves();
      draft.apply([two]);
      const said = heard(draft.flush());
      first.flush({ version: 5 });
      expect(said).toEqual([]);
      saves().flush({ version: 6 });
      expect(said).toEqual(['saved']);
    });

    it('says conflict at once, without a save', () => {
      conflict();
      expect(heard(draft.flush())).toEqual(['conflict']);
      noSave();
    });

    it('says failed after a refusal', () => {
      draft.apply([one]);
      const said = heard(draft.flush());
      refuse(500);
      expect(said).toEqual(['failed']);
    });

    it('says offline and does not wait for the network', () => {
      draft.apply([one]);
      const said = heard(draft.flush());
      lose();
      expect(said).toEqual(['offline']);
    });

    it('tries once more when pressed after a refusal', () => {
      change();
      refuse(500);
      const said = heard(draft.flush());
      saves().flush({ version: 5 });
      expect(said).toEqual(['saved']);
    });
  });

  describe('approving (BR-1)', () => {
    beforeEach(() => open());

    it('approves what was just saved, with its version', () => {
      draft.apply([one]);
      const said = heard(draft.approve());
      noApproval();
      saves().flush({ version: 5 });
      const approval = http.expectOne(APPROVE);
      expect(approval.request.headers.get('If-Match')).toBe('"5"');
      approval.flush({ version: 6, tracks: 1 });
      expect(said).toEqual([{ kind: 'approved' }]);
      expect(draft.edit()?.status).toBe('approved');
      expect(draft.canEdit()).toBe(false);
      reads().flush(edit([one], 6, { status: 'approved', step: 4 }));
    });

    it.each([422, 429, 500, 503])(
      'stops on a save refused with %i and says so',
      (status) => {
        draft.apply([one]);
        const said = heard(draft.approve());
        refuse(status);
        noApproval();
        expect(said).toEqual([{ kind: 'stopped', result: 'failed' }]);
      },
    );

    it.each(['approved', 'proposal-running'])(
      'stops on a 409 %s, with a conflict to recover from (R-6)',
      (reason) => {
        draft.apply([one]);
        const said = heard(draft.approve());
        refuse(409, { reason });
        noApproval();
        expect(said).toEqual([{ kind: 'stopped', result: 'conflict' }]);
        expect(draft.phase()).toEqual({ kind: 'conflict', reason });
        expect(draft.tracks()).toEqual([one]);
      },
    );

    it('sends one approval for two presses on a change waiting to save (BUG-5)', () => {
      draft.apply([one]);
      const first = heard(draft.approve());
      const second = heard(draft.approve());
      saves().flush({ version: 5 });
      http.expectOne(APPROVE).flush({ version: 6, tracks: 1 });
      reads().flush(edit([one], 6, { status: 'approved', step: 4 }));
      expect(first).toEqual([{ kind: 'approved' }]);
      expect(second).toEqual([]);
    });

    it('sends one approval for two presses during a save already going (BUG-5)', () => {
      change();
      const first = heard(draft.approve());
      const second = heard(draft.approve());
      saves().flush({ version: 5 });
      http.expectOne(APPROVE).flush({ version: 6, tracks: 1 });
      reads().flush(edit([one], 6, { status: 'approved', step: 4 }));
      expect(first).toEqual([{ kind: 'approved' }]);
      expect(second).toEqual([]);
    });

    it('starts no run while an approval waits on its save (F-2)', () => {
      draft.apply([one]);
      const approval = heard(draft.approve());
      const run = heard(draft.propose());
      saves().flush({ version: 5 });
      noRun();
      http.expectOne(APPROVE).flush({ version: 6, tracks: 1 });
      reads().flush(edit([one], 6, { status: 'approved', step: 4 }));
      expect(approval).toEqual([{ kind: 'approved' }]);
      expect(run).toEqual([]);
    });

    it('sends no approval while a run waits on its save (F-2)', () => {
      draft.apply([one]);
      const run = heard(draft.propose());
      const approval = heard(draft.approve());
      saves().flush({ version: 5 });
      noApproval();
      http.expectOne(PROPOSE).flush(RUN);
      expect(run).toEqual([{ kind: 'started' }]);
      expect(approval).toEqual([]);
    });

    it('keeps the press on hold when something else asks to save', () => {
      change();
      heard(draft.approve());
      heard(draft.flush());
      expect(draft.approving()).toBe(true);
      draft.apply([two]);
      expect(draft.tracks()).toEqual([one]);
      saves().flush({ version: 5 });
      http.expectOne(APPROVE).flush({ version: 6, tracks: 1 });
      reads().flush(edit([one], 6, { status: 'approved', step: 4 }));
    });

    it('stops on a 412 and on a lost answer', () => {
      draft.apply([one]);
      const late = heard(draft.approve());
      refuse(412);
      reads().flush(edit([two], 9));
      expect(late).toEqual([{ kind: 'stopped', result: 'conflict' }]);
      noApproval();
    });

    it('never approves when the network returns (R-1)', () => {
      draft.apply([one]);
      const said = heard(draft.approve());
      lose();
      expect(said).toEqual([{ kind: 'stopped', result: 'offline' }]);
      window.dispatchEvent(new Event('online'));
      saves().flush({ version: 5 });
      noApproval();
    });

    it('never approves after a conflict, a reload and a saved change (BUG-1)', () => {
      conflict();
      expect(heard(draft.approve())).toEqual([
        { kind: 'stopped', result: 'conflict' },
      ]);
      heard(draft.reload());
      reads().flush(edit([two], 9));
      expect(draft.busy()).toBe(false);
      expect(draft.tracks()).toEqual([two]);
      change();
      saves().flush({ version: 10 });
      noApproval();
    });

    it('changes nothing while the press runs (I-5)', () => {
      draft.apply([one]);
      heard(draft.approve());
      expect(draft.approving()).toBe(true);
      expect(draft.canEdit()).toBe(false);
      draft.apply([two]);
      draft.undo();
      expect(draft.tracks()).toEqual([one]);
      saves().flush({ version: 5 });
      expect(draft.canEdit()).toBe(false);
      http.expectOne(APPROVE).flush({ version: 6, tracks: 1 });
      reads().flush(edit([one], 6, { status: 'approved', step: 4 }));
    });

    it('turns a late approval into a conflict', () => {
      const said = heard(draft.approve());
      http
        .expectOne(APPROVE)
        .flush({}, { status: 412, statusText: 'Precondition Failed' });
      expect(said).toEqual([{ kind: 'stopped', result: 'conflict' }]);
      expect(draft.phase()).toEqual({ kind: 'conflict', reason: 'stale' });
    });

    it('hands back what the server refuses, ready to approve again', () => {
      const problem = { trackId: one.id, ordinal: 1, problem: 'title' };
      const said = heard(draft.approve());
      http.expectOne(APPROVE).flush(
        {
          error: {
            code: 'TRACKS_INVALID',
            message: 'no',
            details: { problems: [problem] },
          },
        },
        { status: 422, statusText: 'Unprocessable' },
      );
      expect(said).toEqual([{ kind: 'invalid', problems: [problem] }]);
      expect(draft.busy()).toBe(false);
    });

    it('reads what happened when the approval`s answer is lost', () => {
      const said = heard(draft.approve());
      http.expectOne(APPROVE).error(new ProgressEvent('error'));
      expect(said).toEqual([{ kind: 'stopped', result: 'offline' }]);
      reads().flush(edit([one, two], 5, { status: 'approved', step: 4 }));
      expect(draft.edit()?.status).toBe('approved');
    });
  });

  describe('a paid run (KBC-067 BR-2)', () => {
    beforeEach(() => open());

    it('starts after the save, and the page reads only from then on', () => {
      draft.apply([one]);
      const said = heard(draft.propose());
      noRun();
      saves().flush({ version: 5 });
      http.expectOne(PROPOSE).flush(RUN);
      expect(said).toEqual([{ kind: 'started' }]);
      expect(draft.running()).toBe(true);
      expect(draft.canEdit()).toBe(false);
    });

    it('never starts after a conflict, a reload and a saved change (R-1)', () => {
      conflict();
      expect(heard(draft.propose())).toEqual([
        { kind: 'stopped', result: 'conflict' },
      ]);
      heard(draft.reload());
      reads().flush(edit([two], 9));
      change();
      saves().flush({ version: 10 });
      noRun();
    });

    it('never starts over a refused save (R-1)', () => {
      draft.apply([one]);
      const said = heard(draft.propose());
      refuse(500);
      noRun();
      expect(said).toEqual([{ kind: 'stopped', result: 'failed' }]);
    });

    it('says when the server refuses the run, and reads what stands', () => {
      const said = heard(draft.propose());
      http
        .expectOne(PROPOSE)
        .flush({}, { status: 409, statusText: 'Conflict' });
      expect(said).toHaveLength(1);
      expect(said[0]?.kind).toBe('refused');
      reads().flush(edit([one, two], 4));
    });
  });

  describe('a read while editing (R-3)', () => {
    const running = (tracks: DraftTrack[], version: number, windows = 1) =>
      edit(tracks, version, { run: { ...RUN, windowsDone: windows } });
    /** A run someone else started: the first read shows it. */
    const followRun = (read: MediaEdit = running([one], 4)) => {
      open(read);
      TestBed.tick();
    };

    it('takes a proposal`s tracks into a clean draft, and starts undo over', () => {
      followRun();
      vi.advanceTimersByTime(POLL_MS);
      reads().flush(running([one, two], 5));
      expect(draft.tracks()).toEqual([one, two]);
      expect(draft.canUndo()).toBe(false);
      vi.advanceTimersByTime(POLL_MS);
      reads().flush(edit([one, two], 6));
      expect(draft.running()).toBe(false);
      expect(draft.canEdit()).toBe(true);
    });

    it('goes on after a read that fails: the editor is not left read-only (R-5)', () => {
      followRun();
      vi.advanceTimersByTime(POLL_MS);
      reads().error(new ProgressEvent('error'));
      vi.advanceTimersByTime(POLL_MS);
      reads().flush(
        { error: { code: 'INTERNAL', message: 'no' } },
        { status: 500, statusText: 'No' },
      );
      vi.advanceTimersByTime(POLL_MS);
      reads().flush(edit([one], 5));
      expect(draft.running()).toBe(false);
      expect(draft.canEdit()).toBe(true);
    });

    it('never goes back to an older version', () => {
      followRun(running([one], 8));
      vi.advanceTimersByTime(POLL_MS);
      reads().flush(running([two], 7));
      expect(draft.tracks()).toEqual([one]);
      vi.advanceTimersByTime(POLL_MS);
      reads().flush(edit([one], 8));
      draft.apply([two]);
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      const save = saves();
      expect(save.request.headers.get('If-Match')).toBe('"8"');
      save.flush({ version: 9 });
    });

    it('never replaces changes waiting to be saved, nor moves their version', () => {
      open();
      draft.apply([one]);
      heard(draft.reopen());
      http
        .expectOne(`${URL}/reopen`)
        .flush({}, { status: 409, statusText: 'Conflict' });
      reads().flush(edit([two], 7));
      expect(draft.tracks()).toEqual([one]);
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      const save = saves();
      expect(save.request.headers.get('If-Match')).toBe('"4"');
      save.flush({ version: 5 });
    });

    it('keeps undo when a read brings nothing new', () => {
      open();
      change();
      saves().flush({ version: 5 });
      heard(draft.reopen());
      http
        .expectOne(`${URL}/reopen`)
        .flush({}, { status: 409, statusText: 'Conflict' });
      reads().flush(edit([one], 5));
      expect(draft.canUndo()).toBe(true);
    });

    it('never replaces the tracks of a conflict', () => {
      followRun(edit([one, two], 4));
      conflict();
      heard(draft.reopen());
      http
        .expectOne(`${URL}/reopen`)
        .flush({}, { status: 412, statusText: 'Late' });
      reads().flush(edit([two], 12));
      expect(draft.tracks()).toEqual([one]);
      expect(draft.phase().kind).toBe('conflict');
    });
  });

  describe('a lost answer is not a conflict with oneself (I-4)', () => {
    beforeEach(() => open());

    it('adopts the version when the server has what was sent', () => {
      change();
      lose();
      window.dispatchEvent(new Event('online'));
      refuse(412);
      reads().flush(edit([one], 5));
      expect(draft.saved()).toBe(true);
      change([two]);
      const next = saves();
      expect(next.request.headers.get('If-Match')).toBe('"5"');
      next.flush({ version: 6 });
    });

    it('sends the newer changes over what did arrive', () => {
      change();
      lose();
      draft.apply([two]);
      window.dispatchEvent(new Event('online'));
      refuse(412);
      reads().flush(edit([one], 5));
      const next = saves();
      expect(next.request.headers.get('If-Match')).toBe('"5"');
      expect(next.request.body.tracks[0].id).toBe(two.id);
      next.flush({ version: 6 });
      expect(draft.saved()).toBe(true);
    });

    it('is a conflict when the server has something else', () => {
      change();
      lose();
      window.dispatchEvent(new Event('online'));
      refuse(412);
      reads().flush(edit([two], 5));
      expect(draft.phase()).toEqual({ kind: 'conflict', reason: 'stale' });
    });

    it('is a conflict when the check itself cannot be read', () => {
      change();
      refuse(412);
      reads().error(new ProgressEvent('error'));
      expect(draft.phase().kind).toBe('conflict');
      expect(draft.tracks()).toEqual([one]);
    });
  });

  describe('a conflict', () => {
    beforeEach(() => open());

    it('stops the changes, keeps the tracks and offers only reloading (FR-10)', () => {
      conflict();
      expect(draft.phase()).toEqual({ kind: 'conflict', reason: 'stale' });
      expect(draft.canEdit()).toBe(false);
      draft.apply([two]);
      expect(draft.tracks()).toEqual([one]);
      vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
      noSave();
    });

    it('stays with the tracks to copy when the reload fails', () => {
      conflict();
      const failure = vi.fn();
      draft.reload().subscribe({ error: failure });
      reads().error(new ProgressEvent('error'));
      expect(failure).toHaveBeenCalledOnce();
      expect(draft.phase().kind).toBe('conflict');
      expect(draft.tracks()).toEqual([one]);
    });

    it('clears when reloaded, and what was kept goes with it', () => {
      conflict();
      expect(localStorage.getItem(JOURNAL)).not.toBeNull();
      heard(draft.reload());
      reads().flush(edit([two], 9));
      expect(draft.phase().kind).toBe('clean');
      expect(localStorage.getItem(JOURNAL)).toBeNull();
    });
  });

  describe('what this browser keeps (BR-6)', () => {
    const kept = (tracks: DraftTrack[], version = 4) =>
      localStorage.setItem(JOURNAL, JSON.stringify({ version, tracks }));

    it('keeps a change at once and forgets it once saved', () => {
      open();
      draft.apply([one]);
      expect(JSON.parse(localStorage.getItem(JOURNAL) ?? '')).toMatchObject({
        version: 4,
        tracks: [{ id: one.id }],
      });
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      saves().flush({ version: 5 });
      expect(localStorage.getItem(JOURNAL)).toBeNull();
    });

    it('holds a change made during a save over the version it will have', () => {
      open();
      change();
      const first = saves();
      draft.apply([two]);
      first.flush({ version: 5 });
      expect(JSON.parse(localStorage.getItem(JOURNAL) ?? '').version).toBe(5);
      saves().flush({ version: 6 });
    });

    it('sends what it held after a reload, on the same version', () => {
      kept([one]);
      open();
      expect(draft.tracks()).toEqual([one]);
      expect(draft.recovered()).toBe(true);
      const resumed = saves();
      expect(resumed.request.headers.get('If-Match')).toBe('"4"');
      resumed.flush({ version: 5 });
      expect(draft.saved()).toBe(true);
    });

    it('drops what the server already has', () => {
      kept([one, two], 3);
      open();
      noSave();
      expect(draft.recovered()).toBe(false);
      expect(localStorage.getItem(JOURNAL)).toBeNull();
    });

    it('survives a keepalive save that arrived first', () => {
      kept([one]);
      open();
      refuse(412);
      reads().flush(edit([one], 5));
      expect(draft.saved()).toBe(true);
    });

    it('shows it to copy when the server moved on, and sends nothing', () => {
      kept([one], 3);
      open();
      noSave();
      expect(draft.tracks()).toEqual([one]);
      expect(draft.phase()).toEqual({ kind: 'conflict', reason: 'stale' });
    });

    it('shows it to copy over an approved edit or a running proposal', () => {
      kept([one]);
      open(edit([one, two], 4, { status: 'approved', step: 4 }));
      noSave();
      expect(draft.phase()).toEqual({ kind: 'conflict', reason: 'approved' });
    });

    it('ignores what does not read as a draft', () => {
      localStorage.setItem(JOURNAL, '{"version":"x"');
      open();
      expect(draft.tracks()).toEqual([one, two]);
    });

    it('says when this browser cannot keep it, for the screen to tell the truth', () => {
      open();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      change();
      lose();
      expect(draft.phase()).toMatchObject({ kind: 'offline', kept: false });
      expect(draft.keptHere()).toBe(false);
    });

    it('sends at once when the page goes, in a request that outlives it', () => {
      open();
      draft.apply([one]);
      window.dispatchEvent(new Event('pagehide'));
      const save = saves();
      expect(save.request.keepalive).toBe(true);
      save.flush({ version: 5 });
    });

    it('sends at once when the page goes to the background', () => {
      open();
      draft.apply([one]);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      const save = saves();
      expect(save.request.keepalive).toBe(true);
      save.flush({ version: 5 });
    });

    it('sends at once when the screen goes, within the delay', () => {
      open();
      draft.apply([one]);
      scope.destroy();
      saves().flush({ version: 5 });
    });

    it('stops trying after the screen went, keeping what it holds', () => {
      open();
      change();
      lose();
      scope.destroy();
      vi.advanceTimersByTime(60_000);
      noSave();
      expect(localStorage.getItem(JOURNAL)).not.toBeNull();
    });

    it('holds a lost save that ends after the screen went', () => {
      open();
      change();
      const save = saves();
      scope.destroy();
      save.error(new ProgressEvent('error'));
      vi.advanceTimersByTime(60_000);
      noSave();
      expect(localStorage.getItem(JOURNAL)).not.toBeNull();
    });
  });

  it('says why the first read failed', () => {
    draft.open(MEDIA);
    http
      .expectOne({ method: 'GET', url: URL })
      .flush({}, { status: 403, statusText: 'Forbidden' });
    expect(draft.loaded()).toBe(false);
    expect(draft.readError()).not.toBeNull();
    expect(heard(draft.flush())).toEqual([]);
  });

  it('starts an edit with nothing changed ("Sair e continuar depois")', () => {
    open(edit([], 0, { started: false }));
    draft.touch();
    const said = heard(draft.flush());
    const save = saves();
    expect(save.request.headers.get('If-Match')).toBe('"0"');
    save.flush({ version: 1 });
    expect(said).toEqual(['saved']);
    expect(draft.edit()?.started).toBe(true);
  });

  it('reopens, then reads the facts', () => {
    open(edit([one], 6, { status: 'approved', step: 4 }));
    heard(draft.reopen());
    http.expectOne(`${URL}/reopen`).flush({ version: 7 });
    expect(draft.edit()?.status).toBe('draft');
    expect(draft.canEdit()).toBe(true);
    reads().flush(edit([one], 7, { transcriptChanged: true }));
    expect(draft.edit()?.transcriptChanged).toBe(true);
  });
});
