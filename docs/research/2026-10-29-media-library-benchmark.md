# Media library benchmark — what Nova Alexandria takes from Spotify

Date: 2026-10-29. Request (owner, 2026-10-29, verbatim): "no caso dos audios e videos, deveremos ter uma interface como uma biblioteca de audio e video (vamos usar como modelo o spotfy) para navegarmos apenas naquela midia, poder criar playlists, salvar como favorito, salvar pra ouvir offline (pegue as features que temos no spotfy para que tenhamos tambem em nosso player), no caso teremos até mais coisas que o spotfy pois teremos a legenda em tempo real" — and: "isso deve valer para audio e video".

Scope: Spotify's library and player on desktop, mobile and the web player, read against our product: a study library of spoken lectures (1–2 h, pt-BR), audio and video, transcribed, with live subtitles, for a handful of invited people, on one Oracle Always Free VM (ADR 0010, 0022), media shared only among app users. The player itself was benchmarked the day before (`2026-10-28-player-benchmark.md`); this report covers the **library around the player**: browsing, collecting, ordering, continuing and offline.

Conventions:
- **[verified]**: confirmed on a primary source (Spotify Support, WebKit, MDN, Chrome docs), URL inline, read on 2026-10-29.
- **[observed]**: third-party report (press, forum); a trend, not a fact.
- **[assumption]**: not verified here; treat as a hypothesis.
- **Value** for this product: H (the owner asked for it or study depends on it), M (useful), L (nice to have). **VM cost**: what it adds to the single VM (CPU, disk, egress); "none" means rows in `media.db` only.

---

## 0. Summary

1. Spotify's library is four ideas: **one place for everything you saved** (Your Library, with filter chips, sort, search, grid/list and pins), **a liked list that is a playlist** (Liked Songs), **user playlists** (folders, custom order, collaborators) and **a queue that decides what plays next** (queue, shuffle, repeat, autoplay). Offline is a fifth: **download a playlist and it stays in sync**, with limits per device and a periodic online check.
2. Everything in those five ideas fits a study library and costs almost nothing on the VM: the data are per-person rows in `media.db` (ADR 0022). The exceptions are offline (egress and a service worker, the first one in the app) and live multi-person features (Jam), which we drop.
3. What does **not** fit: recommendation and taste features (DJ, Smart Shuffle, Daylist, Radio, autoplay of "similar" tracks), social discovery (friend activity, public profiles, Wrapped, follow), ads, Canvas loops, lossless/equalizer. They need a catalogue far bigger than ours, an ML budget we do not have, or public sharing the owner ruled out.
4. Offline on the **web** is not Spotify offline: Safari has no Background Fetch, storage is evictable unless persisted, and a downloaded file is not encrypted at rest. We can still deliver it well with a service worker, chunked resumable downloads into IndexedDB, Range answered from the chunks, a storage estimate before each download and a server-side grant that expires (ADR 0026).
5. We already exceed Spotify on the **player** (live subtitles, clickable transcript with in-transcript search, word-by-word highlight, bookmarks with notes, search in speech at the exact minute, skip silences, configurable skips, cross-device resume). The library should surface those: "Continuar ouvindo" with the position, "Meus marcadores", and media in search.
6. Result: 9 new work items, KBC-051 to KBC-059, each behind its own permission (owner's rule of 2026-10-28), each valid for audio and video.

---

## 1. Feature inventory

### 1.1 Your Library (navigation only in media)

| Spotify feature | Source | Fit for a study library | Value | VM cost | Decision | Item |
|---|---|---|---|---|---|---|
| "Your Library" as a dedicated section in the side menu (desktop/web) and the tab bar (mobile) | [verified] https://support.spotify.com/us/article/your-library/ | The owner asked to "navigate only in that media": a home of its own, apart from the document chat | H | none | **Keep** — "Biblioteca" item in the sidebar, route of its own | KBC-051 |
| Filter chips at the top (Playlists, Podcasts, Artists, Downloaded…), combinable on desktop | [verified] https://support.spotify.com/us/article/sort-and-filter/ | Our attributes: kind (audio/video), listening state, authorship/author, collection/sub-collection, downloaded | H | none | **Adapt** — chips: Áudio/Vídeo, Não ouvidas/Em andamento/Ouvidas, Favoritas, Baixadas, Autoria, Sub-acervo | KBC-051 (+052, 056) |
| Sort: Recents, Recently added, Alphabetical, Creator; custom order for playlists (desktop sets it, all devices show it); sort and filter remembered | [verified] same | Recents and recently added matter most; duration matters for lectures (pick a 20-min one) | H | none | **Keep** + duration sort; remembered per person | KBC-051, KBC-055 |
| Search inside the library | [verified] same | Title search exists on T14 (KBC-034); transcript search exists (KBC-039) | H | none | **Keep** — "Buscar na biblioteca" (title, author); a link to "buscar na fala" | KBC-051 |
| Grid ↔ list view | [verified] same | Lectures rarely have artwork; a grid of identical covers is noise | M | none | **Adapt** — list by default; compact grid with a generated cover (initials + collection colour) | KBC-051 |
| Pin to top (up to 4 on mobile — [assumption]) | [verified] pin: same article | Pin a study playlist or the favourites | M | none | **Keep** — pin up to 4 | KBC-055 |
| Recently played / Recents (last 50 on desktop queue panel) | [verified] https://support.spotify.com/us/article/recent-activity/ | "Ouvidas recentemente" is a strong return path for study | H | none | **Keep** — last 50, clearable | KBC-051 |
| "Jump back in" / continue listening on Home; episode progress bar | [assumption] observed in the app | We store positions (KBC-041); the list already shows "Continuar de 23:10" | H | none | **Keep** — "Continuar ouvindo" row at the top | KBC-051 |
| Mark as played / unplayed (podcasts) | [observed] https://gizmodo.com/spotify-how-to-listen-to-manage-podcasts-new-episodes-1848744764 ; Apple Podcasts: https://support.apple.com/en-mt/guide/iphone/iph4003ecb12/ios | Students skip lectures they heard elsewhere or want to hear again | H | none | **Keep** — "Marcar como ouvida/não ouvida", also in bulk | KBC-051 |

### 1.2 Favourites and playlists

| Spotify feature | Source | Fit | Value | VM cost | Decision | Item |
|---|---|---|---|---|---|---|
| Liked Songs: one tap (+ / ✓) saves to a built-in list | [verified] https://support.spotify.com/us/article/your-library/ | Asked by the owner ("salvar como favorito") | H | none | **Keep** — ♥ "Favoritar" on the row, the player, the mini-player and media search results; list "Favoritas" at the top of the library lists | KBC-052 |
| "Make this a playlist" from a filtered Liked Songs | [verified] same | Nice shortcut | L | none | **Adapt** — "Criar playlist com estas" from any filtered list | KBC-054 |
| Create, rename, describe, delete playlists; add from the ⋯ menu anywhere | [verified] your-library and create-playlists articles | Asked by the owner | H | none | **Keep** | KBC-054 |
| Reorder by drag; remove; custom cover | [verified] play-queue (drag) and collaborative articles | Order is the point of a study playlist ("curso em 8 aulas") | H | none | **Keep** reorder with drag **and** keyboard (Move up/down), **drop** custom cover upload (storage, moderation) | KBC-054 |
| Recover deleted playlists for 90 days; Ctrl/Cmd+Z undo | [verified] https://support.spotify.com/us/article/save-recover-playlists/ | Undo matters; 90-day recovery is overkill | M | none | **Adapt** — "Desfazer" for 8 s (UP-07), soft delete kept 30 days, restored by a master on request | KBC-054 |
| Playlist folders, nested | [verified] https://support.spotify.com/us/article/playlist-folders/ | Useful once a person has >10 playlists (per course, per year) | M | none | **Adapt** — one level of folders (same limit as sub-collections, KBC-048) | KBC-055 |
| Collaborative playlists by invite link (valid 7 days); remove collaborator | [verified] https://support.spotify.com/us/article/collaborative-playlists/ | Study groups; but only among app users and never by public link | M | none | **Adapt** — share with named app users (or a group, KBC-047): "pode ouvir" or "pode editar"; no link | KBC-058 |
| Public playlists on profile, social recommendations | [verified] listening privacy articles (index) | Media is shared only among app users | — | — | **Drop** | — |
| Mixes, Daylist, Prompted/AI playlists, "playlists by mood" | [verified] index of support articles | Our catalogue is hundreds of lectures, not 100 M tracks; "mood" means subject here | L | AI cost | **Drop now**; a subject-based list ("Palestras sobre Cabala") belongs to phase C (AI over media, ADR 0024 §4) | — |

### 1.3 Queue and continuous playback

| Spotify feature | Source | Fit | Value | VM cost | Decision | Item |
|---|---|---|---|---|---|---|
| Play queue: add to queue, reorder by drag, remove, clear (desktop asks to confirm) | [verified] https://support.spotify.com/us/article/play-queue/ | Plan a study session ("these 3 lectures, then stop") | H | none | **Keep** — "Tocar a seguir", "Adicionar à fila", panel "A seguir" | KBC-053 |
| Next / previous track, also on the lock screen | [assumption] standard Media Session `nexttrack`/`previoustrack` | Needed once there is a queue | H | none | **Keep** | KBC-053 |
| Shuffle: "Fewer repeats" vs "Standard" styles | [verified] https://support.spotify.com/us/article/shuffle-play/ | Lectures are usually ordered; shuffle is for reviewing a playlist | M | none | **Adapt** — one shuffle, each item once before any repeats | KBC-053 |
| Smart Shuffle (mixes recommendations into a playlist) | [verified] same | Needs recommendations | — | — | **Drop** | — |
| Repeat off / all / one | [assumption] standard in the app | Repeat one helps memorising a passage | M | none | **Keep** | KBC-053 |
| Autoplay "similar" tracks after the end of a list | [verified] https://support.spotify.com/us/article/autoplay/ | We keep the *continuation* within the list, not "similar" | M | none | **Adapt** — "Continuar com a próxima da lista" (on by default inside a list), stop at the end | KBC-053 |
| Jam / Listening Party (shared queue, host controls) | [verified] https://support.spotify.com/us/article/jam/ | Group study is real, but needs live sync (WebSocket) and conflicts with "each person's pace" | L | persistent connections | **Drop** (revisit in phase D) | — |
| Spotify Connect (control another device) | [verified] index | Single device per session is enough | L | — | **Drop** | — |

### 1.4 Offline

| Spotify feature | Source | Fit | Value | VM cost | Decision | Item |
|---|---|---|---|---|---|---|
| Download songs, playlists, podcasts; up to 10,000 items on each of up to 5 devices; go online every 30 days | [verified] https://support.spotify.com/us/article/listen-offline/ ; https://www.spotify.com/us/premium/features/offline-downloads/ | Asked by the owner; lectures on a commute or abroad | H | egress per download | **Adapt** — per item and per playlist/favourites; up to 5 devices per person; revalidate every 30 days; size cap per device | KBC-056, KBC-057 |
| Downloads stored encrypted on iPhone; cache can be cleared; free up space by removing downloads | [verified] https://support.spotify.com/us/article/storage-information/ | A browser cannot encrypt at rest in a way the user cannot read; storage is the browser's | M | none | **Adapt** — show space used and free, remove one or all; document the at-rest limit in ADR 0026 | KBC-056 |
| "Downloaded" filter in the library | [verified] sort-and-filter | Needed offline | H | none | **Keep** | KBC-056 |
| Offline Backup (auto playlist of cached tracks) | [verified] https://support.spotify.com/us/article/offline-backup/ | Our cache is not a library | L | — | **Drop** | — |
| Auto-remove played downloads ([observed] users asking for it: https://community.spotify.com/forum/en/discussion/5188815/auto-delete-played-and-or-downloaded-podcast-episodes) | forum | Frees space on phones | M | none | **Adapt** — optional "Remover baixadas depois de ouvidas" (off by default) | KBC-057 |
| Download over Wi-Fi only / download quality | [assumption] app settings | The Network Information API is missing in Safari, so "Wi-Fi only" cannot be honest on iPhone | L | — | **Drop** for now; audio is already small (≈30 MB/h) | — |

### 1.5 Player and "Now Playing" (already covered by KBC-034…046)

| Spotify feature | Source | Status here |
|---|---|---|
| Now Playing view, mini-player bar, lock-screen controls | [verified] now-playing article (index) | Done: T15, KBC-041 |
| Playback speed for podcasts, sleep timer | player benchmark §1.3 | Done: KBC-041, KBC-046 |
| Lyrics / "Read along" synced transcript | player benchmark §1.3 (Spotify web player does not sync it for audio-only podcasts, reported 2026-09-02) | Ours: KBC-038 (subtitles + clickable transcript), KBC-045 (word by word) — beyond Spotify |
| Podcast chapters (manual or automatic) | [verified] https://support.spotify.com/us/creators/article/episode-chapters/ | Phase B (tracks and chapters), already planned |
| Video podcasts, switch to audio-only | [assumption] in the app; the video-settings article did not state it | Video arrives in KBC-035; "só o áudio" offered as a download option in KBC-056 (smaller file) |
| Share a moment / link | index (Share from Spotify) | Ours: "Copiar link deste minuto" (KBC-038), only for app users |
| Keyboard shortcuts | [verified] keyboard-shortcuts article (index) | Done: KBC-041 |
| Canvas, ads, equalizer, lossless, crossfade, volume normalisation | index | **Drop**: no value for spoken lectures, or browser-limited |
| Listening stats / Wrapped | index | **Drop now**; "horas estudadas na semana" could be a later item if the owner wants it |

### 1.6 Artists / creators → authors and collections

| Spotify feature | Fit | Value | Decision | Item |
|---|---|---|---|---|
| Artist and show pages (all works, follow) | Our "artist" is the author (KBC-049 makes authors free-text per collection) and the collection | M | **Adapt** — author page in the library (all media of an author the person can see, total hours, play all); no "follow" (no new-release feed in a closed library) | KBC-059 |

---

## 2. What we already have (do not rebuild)

| Capability | Item |
|---|---|
| Own player, audio and video ready (engine + features + views) | KBC-034, ADR 0025 |
| Speed, volume, shortcuts, lock screen, resume across devices, mini-player, "ouvida" at 95 % | KBC-041 |
| Configurable skips, sleep timer, skip silences | KBC-043, KBC-046, KBC-044 |
| Bookmarks with notes, "Meus marcadores" | KBC-042 |
| Subtitles, clickable transcript, word by word, link to a minute | KBC-038, KBC-045 |
| Media in search at the exact minute | KBC-039 |
| Video 720p, resumable upload, quotas | KBC-035 |
| Collections, sub-collections, free authors, edit details | KBC-048, KBC-049, KBC-050 (PR #47) |
| Groups with permissions | KBC-047 (draft) |

## 3. What we have beyond Spotify

1. **Live subtitles over audio and video**, drawn by our overlay from WebVTT, the same in every theme (ADR 0025). Spotify shows lyrics for music and "Read along" for some podcasts only on mobile.
2. **Clickable transcript with search inside it** and "Tocar daqui" (KBC-038), and **word by word** (KBC-045).
3. **Bookmarks with private notes** and a cross-media list (KBC-042). Spotify has no bookmarks.
4. **Search in speech** across the whole library at the exact minute (KBC-039, ADR 0024).
5. **Skip silences** from a precomputed map (KBC-044) and **configurable skips** (KBC-043).
6. In the library, these become: "Continuar ouvindo" with the minute, the bookmarks count on each row, and offline downloads that **include subtitles and transcript**, so reading along works offline too (KBC-056).

---

## 4. Offline on the web: constraints that shape ADR 0026

| Fact | Source | Consequence |
|---|---|---|
| Background Fetch (downloads that continue with the app closed) is Chromium only; Safari and Firefox lack it | [verified] https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API | Downloads run while the page is open; resumable in 8 MB chunks so a closed tab or lost network resumes from the last chunk |
| Safari 17+: an origin may use up to ~60 % of disk in the browser (and in a Home Screen web app); other apps ~15 %; overall 80 %; no more permission prompt | [verified] https://webkit.org/blog/14403/updates-to-storage-policy/ ; https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria | Space is rarely the limit; we still check `navigator.storage.estimate()` before each download and cap each device |
| Storage is evictable unless the origin is in persistent mode; an origin with an active page is excluded | [verified] same WebKit post | Ask `navigator.storage.persist()` on the first download; show "pode ser apagado pelo navegador" when not granted; detect evicted chunks and offer "Baixar de novo" |
| Safari deletes script-writable storage of a site not used for 7 days of browser use (not for Home Screen web apps) | [assumption] WebKit's 2020 "Full third-party cookie blocking and more" post, not re-read today | Recommend "Adicionar à tela de início" on iPhone in the downloads screen |
| A service worker must answer media Range requests itself when serving from storage (`206`, `Content-Range`) | [verified] https://web.dev/articles/sw-range-requests ; https://developer.chrome.com/docs/workbox/modules/workbox-range-requests | The service worker builds the partial response from the stored chunks; tested in Chrome and WebKit |
| Files saved by a web app are readable by whoever controls the device; no DRM for our renditions | [assumption] general platform knowledge | Acceptable: media is shared among app users only and streaming already lets a user save it; the grant expiry and remote revoke delete it from the app, not from a forensic copy |

VM cost of offline: disk none (no new renditions); CPU none (static Range reads, Caddy without compression for media); **egress**: 1 h of audio ≈ 29.6 MB, 1 h of 720p video ≈ 400 MB (ADR 0022, KBC-035). With 10 TB of free egress a month (ADR 0010), 20 people downloading 50 h of audio each is 30 GB; 20 people downloading 20 h of video each is 160 GB — under 2 % of the allowance. The VM's single disk-read path is the limit, so downloads are limited to 2 per person at a time and use the same Range route as streaming.

## 5. Proposed items (all audio and video, each with its own permission)

| ID | Title | Permission |
|---|---|---|
| KBC-051 | Biblioteca: home de mídia com continuar, recentes, filtros, ordenação e marcar como ouvida | `media-library` ("Biblioteca de mídia") |
| KBC-052 | Favoritos | `media-favorites` ("Favoritar mídias") |
| KBC-053 | Fila "A seguir", anterior/próxima, aleatório, repetir e continuar com a próxima | `media-queue` ("Fila e reprodução contínua") |
| KBC-054 | Playlists | `media-playlists` ("Criar playlists") |
| KBC-055 | Pastas de playlists, ordem própria e fixar no topo | `media-library-organize` ("Organizar a Biblioteca") |
| KBC-056 | Baixar para ouvir offline (núcleo: service worker, download retomável, tocar sem rede, expiração) | `media-offline` ("Baixar para ouvir offline") |
| KBC-057 | Offline de playlists e favoritas, sincronização e limpeza automática | `media-offline-lists` ("Baixar playlists e favoritas") |
| KBC-058 | Compartilhar playlists com pessoas do app (ouvir ou editar) | `media-playlist-sharing` ("Compartilhar playlists") |
| KBC-059 | Página do autor na Biblioteca | `media-authors` ("Páginas de autor") |

## 6. Gaps and assumptions of this research

- Spotify features not in a Support article (Jump back in, pin limit, repeat modes, audio-only switch for video podcasts) are marked [assumption]; none drives a business rule here; our defaults are recorded in each item.
- No usability test yet: the library labels ("Biblioteca", "A seguir", "Baixadas") enter the phase-2 test with 1–2 colleagues (`docs/product/context.md`, ## Research).
- Real-device checks of offline playback (iPhone Safari and Home Screen app, Android Chrome) are mandatory before production (phase-2 quality bar).
