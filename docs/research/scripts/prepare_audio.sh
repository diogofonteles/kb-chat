#!/usr/bin/env bash
# Convert recordings of the media library (read-only originals) into 16 kHz mono WAV in the research dir.
# Usage: prepare_audio.sh <research_dir> <name>=<recording_id> [<name>=<recording_id> ...]
#   e.g. prepare_audio.sh ~/dev/personal/kb-chat-research joseluiz_ref=8ef7ed49-b61d-445f-833d-17009e56a0c7
# Source dir: $KB_CHAT_MEDIA_AUDIO (default ~/.kb-chat-media/audio), files <recording_id>.m4a.
# ffmpeg comes from PATH, falling back to /opt/homebrew/bin/ffmpeg. bash 3.2 compatible.
set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo "usage: $0 <research_dir> <name>=<recording_id> [...]" >&2
  exit 2
fi
OUT="$1/audio"
shift
SRC="${KB_CHAT_MEDIA_AUDIO:-$HOME/.kb-chat-media/audio}"
FFMPEG="$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)"
mkdir -p "$OUT"
for pair in "$@"; do
  name="${pair%%=*}"
  id="${pair#*=}"
  "$FFMPEG" -nostdin -loglevel error -y -i "$SRC/$id.m4a" -ac 1 -ar 16000 -c:a pcm_s16le "$OUT/$name.wav"
done
ls -la "$OUT"
