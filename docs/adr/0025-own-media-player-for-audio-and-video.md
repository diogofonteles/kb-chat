# 0025 — An own media player component for audio now and video later

- Status: accepted
- Date: 2026-10-28
- Deciders: the owner (Diogo Fonteles)
- Related: ADR 0022 (streaming), ADR 0023 (transcripts, words and subtitles), KBC-034, KBC-041, KBC-042 to KBC-046, KBC-035 (video)

## Context

Phase 2 needs a player for 1–2 h spoken lectures that people study: a synced, searchable transcript, subtitles, speed, resume across devices, a mini-player that survives navigation, lock-screen controls and, by the owner's decision on 2026-10-28, bookmarks with notes, configurable skip intervals, silence skipping, word-by-word highlighting and a sleep timer. The owner also asked that the same player serve video later (KBC-035 converts video to H.264 720p).

The benchmark (`docs/research/2026-10-28-player-benchmark.md`) found that the open-source players merged into Video.js 10 (stable on 2026-10-01); its audio player has no text tracks, a fixed speed list without 0.75×, no Media Session metadata and no persistence, and Media Chrome, Vidstack and Plyr are being retired. No library offers a synced transcript, cross-device resume or a mini-player across routes.

## Decision

1. **Build our own player in `apps/web`, in layers that do not know whether the media is audio or video.**
   - **Engine** (`MediaEngine`): one app-wide service that owns a single `HTMLMediaElement` and turns its events into signals (`state`, `currentTime`, `duration`, `buffered`, `rate`, `volume`, `error`). State comes only from media events, never from the `play()` call; stale loads are dropped by a sequence number; the source is cleared with `removeAttribute('src')` + `load()`. It depends on the `HTMLMediaElement` interface only, so an `<audio>` and a `<video>` are interchangeable.
   - **Features** as small services on top of the engine, each with its own tests: speed and preferences, resume, keyboard shortcuts, Media Session, status announcer, sleep timer, silence skipping, bookmarks, transcript sync (segments and words).
   - **Views**: the full player, the mini-player and the transcript panel. The full player has a media area slot: empty for audio, the `<video>` element for video. Moving the single element between the full player and the mini-player never recreates it (playback must not cut).
2. **Video-ready from KBC-034.** Nothing in the engine or features may assume audio: no audio-only APIs (the volume test works for both), timings in ms from the media element, captions drawn by our own overlay from WebVTT cues so they look the same over audio and video. KBC-035 adds only the video-specific parts: the video surface with `aspect-ratio` reserved from the first paint, poster, fullscreen (`F`), picture-in-picture where supported, and the caption overlay positioned over the picture.
3. **Silence skipping uses a precomputed silence map, not live audio analysis.** The media worker runs ffmpeg `silencedetect` (the pilot measured 18 s per hour of audio on the VM) and the API stores the intervals per rendition. The player seeks over intervals longer than the configured minimum and reports the time saved. Live Web Audio analysis was rejected: it needs the element routed through an `AudioContext` (background playback and iOS quirks), costs CPU on phones and does not help video.
4. **Word timings come from the stored words (ADR 0023).** The word highlight uses binary search on word start times and interpolates between `timeupdate` events with `requestAnimationFrame` only while playing.
5. **Per-person data lives in `media.db`** (ADR 0022): `playback`, `media_preferences` (speed, skip intervals, silence skipping, word highlight, time display), `bookmarks` (media, person, position ms, note, created, updated) and `media_silences` (rendition, start ms, end ms).

## Options considered

1. **Own component in layers (chosen).** Covers every requirement, uses our tokens and themes directly, small bundle, video-ready by design.
2. **Video.js 10 web components.** Newest and smallest library, but misses text tracks in audio, 0.75×, Media Session and persistence today; theming beyond 8 CSS properties means editing its skin.
3. **Media Chrome or Vidstack.** Cover more, but are being retired.

## Consequences

- We own the hard edge cases; the quality bar of phase 2 (mutation tests on the engine and feature services, E2E in Google Chrome and WebKit, real devices before production) is the mitigation. Revisit if Video.js 10 closes its issues #3039, #1404 and #3042.
- KBC-035 must not change the engine or the features, only add the video view; a test runs the engine's contract suite against both an `<audio>` and a `<video>` element from KBC-034 on.
- The media worker gains a `silences` step after transcoding (KBC-044); old media get it through a backfill job.

## Compliance

- An engine contract test suite that runs against `<audio>` and `<video>`.
- A lint boundary: feature services and views import the engine through its public API only.
- Unit tests per feature service with fake timers and a fake media element; Stryker mutation score ≥ 80 % on the engine and feature services.
