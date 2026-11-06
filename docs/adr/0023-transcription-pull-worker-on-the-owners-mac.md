# 0023 — Transcription: a pull worker on the owner's Mac (mlx-whisper turbo with VAD and terms), Groq as a capped fallback, raw JSON as the source of truth

- Status: accepted (2026-10-28)
- Drivers: phase 2 plan v3; the owner's decision of 2026-10-28 (transcribe on the Mac, Groq as backup, noisy recordings searchable with a notice, monthly cap US$ 10); transcription pilot `docs/research/2026-10-28-transcription-pilot.md`; ADR 0022

## Context

The pilot transcribed 111 tracks (5.59 h of Portuguese lectures and sung "chamadas") in four variants and scored them against three ~10-minute excerpts the owner corrected by hand (WER, lower is better):

| Variant | Clean narrative | Several voices and chants | Clean, together | Noisy recording |
|---|---|---|---|---|
| Mac, mlx-whisper large-v3-turbo, no VAD, no terms | 13.9 % | 16.3 % | 15.2 % | 91.9 % |
| Mac, + Silero VAD, terms in every chunk, post-filter | 4.2 % | 11.2 % | 7.9 % | 75.4 % |
| Same, with 7 more terms | 6.2 % | 8.0 % | 7.1 % | 73.5 % |
| Groq whisper-large-v3-turbo, no VAD | 11.7 % | 13.9 % | 12.9 % | 80.6 % |
| Groq, VAD chunks, terms once per file | 13.0 % | 16.0 % | 14.5 % | 82.6 % |

The references were corrected starting from the second row's text, which favours it; the ranking holds, the exact gaps do not. Other findings: the Mac ran at 17× real time when idle (500 h ≈ 29 h of machine time); Groq's free tier allows 2 h of audio per hour and 8 h per day (500 h ≈ 57 days), paid at US$ 0.04/h with a 10 s minimum per request; terms in the prompt are what fix names ("Tiuaco" wrong in all 40 occurrences without it, right in all 40 with it; "Hoasca" from 0 to 43); classic hallucinated phrases appeared zero times, but repetition loops did (up to 33 tracks) and one 7-word loop passed the filter; VAD empties sung tracks (9 tracks under 40 % speech, 3 empty); on the noisy recording every variant invents sentences.

The Mac is behind NAT and not always on; the VM must not run speech recognition (ADR 0022).

## Decision

1. **Pull worker.** Transcription runs in a worker that leases `transcribe` jobs from the API over HTTPS (`/api/v1/media-worker/*`), the same protocol as the VM media worker (ADR 0022). The owner's Mac runs it; nothing on the Mac listens on the network. The worker downloads the job's 16 kHz mono FLAC, transcribes it locally, uploads the raw result, heartbeats while working and stops cleanly on SIGTERM (the lease expires and the job returns to the queue).
2. **Worker identity.** A master pairs a worker in the UI ("Transcritores"): the app shows a token once; the API stores only its hash (sealed store, ADR 0017), with a name, the job kinds it may lease, created and last-seen times, and a revoke action. A worker token reaches only the worker routes (no session, no other route), and only the audio of jobs it holds. The token on the Mac lives in the macOS Keychain or a 0600 file, never in the repository.
3. **The worker program.** `tools/transcriber/` in this repository: a Python package run with `uv` (mlx-whisper needs Python), with a `launchd` plist template to run it while the Mac is awake. Parameters are the pilot's, versioned in one config file:
   - model `mlx-community/whisper-large-v3-turbo`, `language=pt`, word timestamps;
   - Silero VAD 6.2: threshold 0.5, min speech 250 ms, min silence 1,000 ms, pad 300 ms, chunks ≤ 28 s; **when speech is under 40 % of the track, transcribe the whole track without VAD** (sung tracks);
   - temperatures (0.0, 0.2, 0.4, 0.6, 0.8, 1.0) with fallback, never a fixed 0; `condition_on_previous_text=False` per chunk;
   - the term list as comma-separated words in `initial_prompt` of **every** chunk (≤ 224 tokens), fetched from the API with its version (KBC-040);
   - the raw output (per chunk, with offsets) uploaded as is.

   KBC-040: masters edit the list; each change is a version with date and author. The API counts it with Whisper's own vocabulary (`apps/api/assets/`), over the exact prompt `build_prompt` sends, so the limit on the screen is the worker's. The worker fetches the list at the start of each job, and the API filters a result with the version that job used. Saving a list queues nothing.
4. **Raw JSON is the source of truth.** The API stores the raw result as a file next to the database and derives, in the API (not in the worker), the normalized segments and words, the post-filter and the confidence. Changing the post-filter or the subtitle rules re-derives without transcribing again. Each transcript has a version; re-transcribing (new terms, new model) adds a version and the newest becomes current. Only a master's click re-transcribes (KBC-040). An empty result never replaces a transcript that has words: the attempt ends as failed and the text stays.
5. **Post-filter (in the API, versioned).** Drop blocked phrases (pt/en "obrigado por assistir", "inscreva-se", English prefixes, prompt leaks); collapse character loops `(.{1,24})\1{3,}` and **word n-grams of 1 to 12 words repeated 3 or more times in a row** (the pilot's missed loop had 7 words); an isolated "obrigado" only when `no_speech_prob ≥ 0.8` is dropped.
6. **Confidence.** Each transcript gets `confidence: normal | low`. Low when the share of words in segments with `avg_logprob < −1.0` or `compression_ratio > 2.4` passes 30 %, or when the post-filter removed more than 10 % of the words. Thresholds are calibrated on the pilot's 111 tracks in KBC-036 so that the noisy excerpt's tracks are low and the clean ones are normal; the calibration is recorded in the item. A low-confidence transcript stays searchable and playable with subtitles, and every place that shows it says "Transcrição automática de baixa confiança" (owner's decision 2026-10-28).
7. **Groq fallback (KBC-037).** A second provider adapter, run by the VM media worker, used only when a master turns it on (never by default) and for the jobs they choose ("Transcrever com Groq": one item, or "quando o Mac estiver parado há mais de N horas"). The key is pasted in the UI and sealed. It sends VAD chunks of ≤ 28 s with the terms in each request (the pilot sent one file per track, which is why its terms barely worked). Every request is reserved against the media monthly cap (ADR 0022, default US$ 10), counting the 10 s minimum; the free tier's limits (20 requests/min, 7,200 s/h, 28,800 s/day) are honoured by a pacer, and a 429 waits for its `retry-after`.

   KBC-037: the VM worker leases only the transcriptions routed to Groq (`jobs.route`), finds speech with ffmpeg `silencedetect` (-35 dB, 1 s pauses, 300 ms padding, spans under 250 ms dropped; fixed 28 s windows under 40 % of speech), and sends each chunk as 16 kHz FLAC to `/api/v1/media-worker/jobs/:id/groq/chunks`. The API, which alone holds the key (ADR 0017: a worker never receives an AI key), paces the free tier in memory, reserves the request in the media ledger, prompts with the job's term list and answers Groq's words in the Mac's raw shape, or 429 with `retry-after`. A cap reached, a refused key, Groq turned off or a Groq job out of attempts gives the job back to the paired transcriber (`jobs.hold` says why), with the attempts it had before Groq took it (`jobs.transcriber_attempts`): Groq never spends the Mac's. A key Groq refuses is marked and left unused until a master tests or pastes one; a sealed key that no longer opens is reported, never a 500. The mode, the sealed key and the owner's cap live in `media_settings`.

   The VM has one slot, so Groq never holds up a conversion: its transcriptions come last in the VM's lease, a Groq job is handed back (still Groq's, without spending an attempt) when a conversion or a cut waits, and a wait longer than a minute hands it back too, the VM taking no Groq job until it is over. Each chunk Groq transcribed is kept (`groq_chunks`, by job, span and term list version) until its job ends, so a new lease pays only the chunks still missing. The cap's estimate for routing counts what is already routed and not transcribed; an item of unknown length is not routed.
8. **Subtitles.** WebVTT from word timestamps: a new cue at a silence ≥ 0.5 s or a sentence end, cues ≤ 6 s and ≤ 84 characters, a stretched word capped at 1.2 s, segment timestamps when words are missing.

## Options considered

1. **Mac pull worker, Groq as capped fallback (chosen).** Lowest error and most correct names in the pilot, no cost, no inbound port on the Mac.
2. **Groq first.** Fast per file and no machine to keep awake, but higher error, terms that barely helped, and the free tier makes 500 h take ~57 days; paid, US$ 18–20 per 500 h.
3. **Transcribe on the VM.** Measured: too slow and wrong on names.
4. **The Mac pushes to the VM over SSH (like `sync-vault.sh`).** Reuses SSH, but couples the job lifecycle to scripts and gives no leases, retries or status in the UI.
5. **A GPU machine for rent per batch.** Fast for big imports; kept as a later option for video in bulk (phase B).

## Consequences

- Good: names and terms improve by editing a list, without code; transcripts can be re-derived.
- Bad: jobs wait while the Mac sleeps; the UI shows "Aguardando o transcritor" with the last time a worker was seen, and masters can switch the item to Groq.
- Bad: a second language (Python) in the repository, limited to `tools/transcriber/`, with its own lint and tests in CI (ruff, pytest with a fake model).
- Noisy recordings remain poor; they are flagged, not fixed. Later tests: whisper large-v3 (not turbo) and noise reduction before recognition.
- Threats: a leaked worker token can read the audio of jobs it leases and post a false transcript for them; mitigated by revoke, last-seen time, scope to worker routes and one job at a time. The worker never receives the vault, sessions or AI keys.
- Compliance: contract tests of the worker protocol (lease, heartbeat, upload, lease expiry) with a fake worker; post-filter and confidence unit tests with the pilot's loops and the noisy excerpt as fixtures; the WER script of the pilot kept as a manual check when parameters change.
