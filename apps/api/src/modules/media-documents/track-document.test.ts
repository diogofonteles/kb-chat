import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitFrontmatter, toCatalogEntry } from '../catalog/index.js';
import {
  renderTrackDocument,
  trackDocumentPath,
  type TrackDocumentInput,
} from './track-document.js';

const TRACK = '0b9c1f7e-1111-4a2b-8c3d-000000000001';
const RECORDING = '0b9c1f7e-1111-4a2b-8c3d-000000000002';

/** "O que é o ritmo?": track 3 of 12, 1:12 to 9:40 of the recording, four lines (AC-1). */
const RHYTHM: TrackDocumentInput = {
  topic: 'hermetismo',
  mediaId: TRACK,
  kind: 'track',
  title: 'O que é o ritmo?',
  recordingId: RECORDING,
  recordingTitle: 'Palestra de 12/03/2017',
  ordinal: 3,
  total: 12,
  startMs: 72_000,
  durationMs: 508_000,
  confidence: 'normal',
  authorship: 'mestre-laercio',
  author: 'Mestre Laércio',
  subjects: ['Ritmo', 'Polaridade'],
  segments: [
    { startMs: 0, endMs: 40_500, text: ' Pergunta sobre o ritmo.' },
    { startMs: 41_300, endMs: 70_000, text: ' O ritmo é a lei do pêndulo.' },
    {
      startMs: 70_000,
      endMs: 95_000,
      text: 'Tudo flui, para fora e para dentro.',
    },
    { startMs: 125_900, endMs: 140_000, text: 'Tudo tem suas marés.' },
  ],
};

const frontmatterOf = (markdown: string) =>
  splitFrontmatter(markdown).data as Record<string, unknown>;

describe('renderTrackDocument (KBC-099 AC-1, ADR 0035 §2)', () => {
  it('writes the app keys, the authorship, the title, the recording line and anchored paragraphs', () => {
    const { markdown, fingerprint, path } = renderTrackDocument(RHYTHM);
    expect(path).toBe(`raw/media/${RECORDING}/${TRACK}.md`);
    expect(frontmatterOf(markdown)).toEqual({
      title: 'O que é o ritmo?',
      type: 'source',
      stage: 'raw',
      source_kind: 'media-transcript',
      source_path: `media/hermetismo/${RECORDING}/${TRACK}`,
      author_group: 'mestre-laercio',
      author: 'Mestre Laércio',
      kb_chat_media_id: TRACK,
      kb_chat_media_kind: 'track',
      kb_chat_recording_id: RECORDING,
      kb_chat_recording_title: 'Palestra de 12/03/2017',
      kb_chat_track_ordinal: 3,
      kb_chat_tracks_total: 12,
      kb_chat_start_ms: 72_000,
      kb_chat_duration_ms: 508_000,
      kb_chat_confidence: 'normal',
      kb_chat_subjects: ['Ritmo', 'Polaridade'],
      kb_chat_render: 1,
      kb_chat_fingerprint: fingerprint,
    });
    expect(splitFrontmatter(markdown).body).toBe(
      [
        '',
        '# O que é o ritmo?',
        '',
        'Gravação: Palestra de 12/03/2017 · faixa 3 de 12 · Mestre Laércio · 8:28',
        '',
        '[0:00] Pergunta sobre o ritmo.',
        '',
        '[0:41] O ritmo é a lei do pêndulo.',
        '',
        '[1:10] Tudo flui, para fora e para dentro.',
        '',
        '[2:05] Tudo tem suas marés.',
        '',
      ].join('\n'),
    );
  });

  it('is deterministic: the same track gives the same file and fingerprint', () => {
    const first = renderTrackDocument(RHYTHM);
    const again = renderTrackDocument(structuredClone(RHYTHM));
    expect(again).toEqual(first);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('any change to what is rendered changes the fingerprint', () => {
    const base = renderTrackDocument(RHYTHM).fingerprint;
    const changed = [
      { ...RHYTHM, title: 'O ritmo' },
      { ...RHYTHM, author: null, authorship: 'outros-autores' as const },
      { ...RHYTHM, subjects: [] },
      { ...RHYTHM, segments: RHYTHM.segments.slice(1) },
    ].map((input) => renderTrackDocument(input).fingerprint);
    for (const one of changed) expect(one).not.toBe(base);
  });

  it('writes one anchored paragraph per segment, a named speaker before the speech', () => {
    const long = 'palavra '.repeat(80).trim();
    const { markdown } = renderTrackDocument({
      ...RHYTHM,
      segments: [
        { startMs: 0, endMs: 10_000, text: long, speaker: 'Ana' },
        { startMs: 41_000, endMs: 50_000, text: 'segue Ana', speaker: 'Ana' },
        { startMs: 61_000, endMs: 70_000, text: 'fala Bia', speaker: 'Bia' },
        { startMs: 3_725_000, endMs: 3_726_000, text: 'uma hora' },
      ],
    });
    const paragraphs = splitFrontmatter(markdown)
      .body.trim()
      .split('\n\n')
      .filter((line) => line.startsWith('['));
    expect(paragraphs).toEqual([
      `[0:00] **Ana:** ${long}`,
      '[0:41] **Ana:** segue Ana',
      '[1:01] **Bia:** fala Bia',
      '[1:02:05] uma hora',
    ]);
  });

  it('keeps a written time in the speech from passing for an anchor', () => {
    const { markdown } = renderTrackDocument({
      ...RHYTHM,
      segments: [{ startMs: 0, endMs: 1_000, text: 'veja [2:30] e\nisto' }],
    });
    expect(splitFrontmatter(markdown).body).toContain(
      '[0:00] veja (2:30) e isto',
    );
  });

  it('a recording without tracks is one document under its own id', () => {
    expect(
      trackDocumentPath({
        kind: 'recording',
        recordingId: RECORDING,
        mediaId: RECORDING,
      }),
    ).toBe(`raw/media/${RECORDING}/${RECORDING}.md`);
  });

  it('round-trips through the catalog as the same track', () => {
    const { markdown, fingerprint, path } = renderTrackDocument(RHYTHM);
    const entry = toCatalogEntry(path, frontmatterOf(markdown));
    expect(entry.media).toMatchObject({
      mediaId: TRACK,
      ordinal: 3,
      total: 12,
      fingerprint,
    });
    expect(entry.authorship).toBe('mestre-laercio');
  });

  it('property: every paragraph starts with an anchor, anchors never go back, nothing is lost', () => {
    const segment = fc
      .record({
        gapMs: fc.integer({ min: 0, max: 90_000 }),
        lengthMs: fc.integer({ min: 1, max: 60_000 }),
        text: fc.stringMatching(/^[a-zà-ú ,.?]{1,120}$/),
        speaker: fc.option(fc.constantFrom('Ana', 'Bia'), { nil: null }),
      })
      .filter((one) => one.text.trim().length > 0);
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 1, maxLength: 40 }),
        (drawn) => {
          let at = 0;
          const segments = drawn.map((one) => {
            const startMs = at + one.gapMs;
            at = startMs + one.lengthMs;
            return { startMs, endMs: at, text: one.text, speaker: one.speaker };
          });
          const input = { ...RHYTHM, segments };
          const { markdown, fingerprint } = renderTrackDocument(input);
          expect(renderTrackDocument(input).fingerprint).toBe(fingerprint);
          const paragraphs = splitFrontmatter(markdown)
            .body.split('\n\n')
            .map((one) => one.trim())
            .filter(
              (one) =>
                one && !one.startsWith('#') && !one.startsWith('Gravação'),
            );
          const seconds = paragraphs.map((one) => {
            const clock = /^\[((?:\d+:)?\d+:\d{2})\] /.exec(one)?.[1];
            expect(clock).toBeDefined();
            return (clock ?? '')
              .split(':')
              .reduce((sum, part) => sum * 60 + Number(part), 0);
          });
          expect([...seconds].sort((a, b) => a - b)).toEqual(seconds);
          const words = (text: string) => text.split(/\s+/).filter(Boolean);
          const spoken = segments.flatMap((one) => words(one.text));
          const written = paragraphs.flatMap((one) =>
            words(one.replace(/^\[[^\]]+\] (\*\*[^*]+:\*\* )?/, '')),
          );
          expect(written).toEqual(spoken);
          expect(paragraphs).toHaveLength(segments.length);
        },
      ),
    );
  });
});
