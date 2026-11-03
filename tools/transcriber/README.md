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

The token goes to the macOS Keychain (service `nova-alexandria-transcriber`), and the API URL
and name to `~/Library/Application Support/nova-alexandria-transcriber/config.json` (0600).
Alternatively set `KB_CHAT_TRANSCRIBER_TOKEN_FILE` to a file with mode 0600; never keep the
token in the repository. `KB_CHAT_API_URL` and `KB_CHAT_TRANSCRIBER_NAME` override the config.

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
expires and the API puts it back in the queue.

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
on a synthetic signal.
