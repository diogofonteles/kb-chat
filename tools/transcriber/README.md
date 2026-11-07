# transcriber

The Nova Alexandria transcriber (KBC-036, [ADR 0023](../../docs/adr/0023-transcription-pull-worker-on-the-owners-mac.md)):
a pull worker that runs on the owner's Mac. It leases `transcribe` jobs from the API over
HTTPS, downloads the job's 16 kHz FLAC, transcribes it with mlx-whisper large-v3-turbo,
Silero VAD and the term list in every chunk, and uploads the raw result. Nothing on the Mac
listens on the network. The parameters live in [`src/transcriber/config.py`](src/transcriber/config.py)
(bump `PARAMETERS_VERSION` when changing one).

## Setup (Apple silicon Mac)

```bash
brew install uv ffmpeg
uv sync --project tools/transcriber          # first run downloads the model (~1.6 GB) on first job
```

Pair in the app: **Configurações → Transcritores → Parear transcritor**. The token is shown
once. On the Mac, run the command the screen shows and paste the token when asked:

```bash
uv run --project tools/transcriber transcriber pair --api-url https://<app-origin>
```

The API URL must be `https://` (plain `http://` is accepted only for `localhost`), and the
worker never follows a redirect, so the token is never sent anywhere else. The token goes to
the macOS Keychain (service `nova-alexandria-transcriber`, written through `security -i`, so it
is never in a process's arguments), and the API URL
and name to `~/Library/Application Support/nova-alexandria-transcriber/config.json` (0600).
Alternatively set `KB_CHAT_TRANSCRIBER_TOKEN_FILE` to a file with mode 0600; never keep the
token in the repository. `KB_CHAT_API_URL` and `KB_CHAT_TRANSCRIBER_NAME` override the config.

## Separating voices (KBC-064)

The same worker separates the voices of a transcribed recording ("Voz 1", "Voz 2"…) when
the `diarize` extra is installed and the transcriber is marked **Separa vozes** in
Transcritores. The engine is [Senko](https://github.com/narcotic-sh/senko) (MIT, commit
`1bcb090`, CoreML on Apple silicon), the best measured on our Portuguese recordings
(`docs/research/2026-11-03-audio-editing-test-speakers.md`): a few seconds per hour of audio.

```bash
uv sync --project tools/transcriber --extra diarize
```

Only start, end and a voice name per turn go to the API (ADR 0029 §1). The engine's voice
centroids stay in memory, are used only to join voices down to the number a person
announced (or 10), and are dropped when the job ends; nothing is written to disk.
`transcriber run --no-diarize` keeps the worker to transcriptions. The engine sits behind
the `Diarizer` protocol in [`src/transcriber/diarize.py`](src/transcriber/diarize.py), so
pyannote `community-1` can come in as another engine (it needs a Hugging Face token).

## Voice profiles (KBC-071)

**Biometric data: off unless you turn it on, at both ends.** The worker handles voice prints only with the `voiceprint` extra (ECAPA, SpeechBrain), and the API gives prints only to a transcriber marked **Perfis de voz** in Transcritores, which starts unmarked.

```bash
uv sync --project tools/transcriber --extra diarize --extra voiceprint
```

The API sends a print only for a profile with a recorded consent, in the collection of the job, during the lease. Prints stay in memory and are never logged or written to disk. The main arrays are zeroed when the job ends; the JSON a print arrives in and the float list of an upload are plain Python objects, released but not zeroed. With no profile for the job's collection, no vector is computed at all. The worker uploads only the closest profile and the score per voice. `transcriber run --no-voice-profiles` keeps the worker out of it. The first job downloads the model weights once from Hugging Face; no audio or print goes there.

A revocation reaches a running job: each heartbeat (15 s) names the prints held, and the arrays are zeroed as soon as the API answers that one was revoked, without waiting for the job, which stops at the next batch. With no answer from the API for 40 s they are zeroed too. A separation then goes on without the comparison; a print job stops with nothing uploaded. A suspended Mac does this when it wakes.

The recipe is the one measured in KBC-063, not a calibrated one (threshold 0.4 at the API; margin 0.1 and at least 10 s of speech here, in `config.py`).

## Track documents in the collection (KBC-099)

**kb spends on the owner's key: off unless you turn it on, at both ends.** With a vault path (`transcriber pair --vault ~/dev/personal/hermetismo`, or `KB_CHAT_VAULT`) and `kb` on PATH, the worker asks for `kb-publish` jobs, and the API gives them only to a transcriber marked **Publica no acervo** in Transcritores. A job carries a collection's rendered track documents; the worker takes `<vault>/.kb-chat-publish.lock`, writes each one under `<vault>/<collection>/raw/media/`, then runs `kb classify <collection>`, `kb link <collection>` and `kb index --topic <collection>`, each with `--budget` (what is left of the media monthly cap, at most US$ 0.50). A step that fails fails the job with kb's output; the files stay and the next job runs kb again. `transcriber run --no-kb-publish` keeps the worker out of it. The owner's `sync-vault.sh` takes the documents to production.

**Pending:** the commands follow ADR 0035 §3; the flags, the receipts' spend format and whether kb 0.0.12 classifies a file it did not ingest are checked by the owner's spike on a vault copy (it spends money). If it does not, the fallback is `kb ingest file --force` (ADR 0035 option 5).

## Run

```bash
uv run --project tools/transcriber transcriber run                  # until stopped
uv run --project tools/transcriber transcriber run --once           # at most one job
uv run --project tools/transcriber transcriber run --exit-when-idle # until the queue is empty
```

To run it while the Mac is awake, install the launchd agent (edit the two paths first):

```bash
cp tools/transcriber/launchd/com.nova-alexandria.transcriber.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.nova-alexandria.transcriber.plist
tail -f ~/Library/Logs/nova-alexandria-transcriber.log
launchctl bootout gui/$UID/com.nova-alexandria.transcriber          # stop it
```

SIGTERM (launchctl bootout, Ctrl-C) stops between chunks without uploading; the job's lease
expires and the API puts it back in the queue. A track transcribed whole (under 40 % speech,
no VAD) is one call to the model, so the stop waits for it: the plist gives it 300 s
(`ExitTimeOut`) before launchd kills it.

## Revoke

Revoke the transcriber on the **Transcritores** screen. Its next call gets 401 and the log
says `Token revogado; pareie de novo.`; it keeps polling slowly and picks up a new token
once you pair again (no restart needed).

## Development

```bash
cd tools/transcriber
uv run ruff check && uv run ruff format --check && uv run pytest
```

Tests use a fake model and a fake API; the sung-track test (AC-3) runs the real Silero VAD
on a synthetic signal. With the `diarize` extra on a Mac, `test_senko_two_voices.py` runs
the real Senko on a conversation synthesized with `say` (skipped elsewhere).
