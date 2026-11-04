import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LibraryItem, LibraryTrack } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import { aMediaItem, mediaId } from '../../../testing/media-fixtures.js';
import { TrackGroup } from './track-group.js';

const aTrack = (ordinal: number): LibraryTrack => ({
  ...aMediaItem({
    id: mediaId(ordinal),
    title: `Pergunta ${ordinal}`,
    durationMs: 65_000,
    parent: {
      id: mediaId(100),
      title: 'Palestra',
      startMs: 0,
      endMs: 65_000,
      ordinal,
      total: 2,
    },
  }),
  kind: 'audio',
  lastPlayedAt: null,
});

const recording: LibraryItem = {
  ...aMediaItem({ id: mediaId(100), title: 'Palestra' }),
  kind: 'audio',
  lastPlayedAt: null,
  tracks: [aTrack(1), aTrack(2)],
};

function setup(openByDefault = false, item = recording) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(TrackGroup);
  fixture.componentRef.setInput('item', item);
  fixture.componentRef.setInput('openByDefault', openByDefault);
  return fixture;
}

describe('TrackGroup (KBC-068 FR-5)', () => {
  it('shows the count closed, and the tracks in order once opened', async () => {
    const fixture = setup();
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    const toggle = root.querySelector('button');
    expect(toggle?.textContent).toContain('2 faixas');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('ol')).toBeNull();
    toggle?.click();
    await fixture.whenStable();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const links = [...root.querySelectorAll('a')].map((a) => a.textContent);
    expect(links).toEqual(['Pergunta 1', 'Pergunta 2']);
    expect(root.querySelector('a')?.getAttribute('href')).toBe(
      `/midia/${mediaId(1)}`,
    );
  });

  it('keeps the whole title of a track where a narrow screen cuts it', async () => {
    const fixture = setup(true);
    await fixture.whenStable();
    const link = fixture.nativeElement.querySelector('ol a');
    expect(link.getAttribute('title')).toBe('Pergunta 1');
  });

  it('opens by itself under a search', async () => {
    const fixture = setup(true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ol')).not.toBeNull();
  });

  it('shows where the person is in each track: heard, or where to continue', async () => {
    const heard = { ...aTrack(1), completedAt: '2026-11-01T00:00:00.000Z' };
    const begun = { ...aTrack(2), positionMs: 20_000 };
    const fixture = setup(true, { ...recording, tracks: [heard, begun] });
    await fixture.whenStable();
    const [first, second] = fixture.nativeElement.querySelectorAll('li');
    expect(first.textContent).toContain('✓ Ouvida');
    expect(second.textContent).toContain('Continuar de 0:20');
    expect(second.textContent).not.toContain('Em andamento');
  });

  it('plays a track at once', async () => {
    const fixture = setup(true);
    const played = vi.fn();
    fixture.componentInstance.played.subscribe(played);
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    root
      .querySelector<HTMLButtonElement>('button[aria-label="Ouvir Pergunta 2"]')
      ?.click();
    expect(played).toHaveBeenCalledWith(recording.tracks[1]);
  });
});
