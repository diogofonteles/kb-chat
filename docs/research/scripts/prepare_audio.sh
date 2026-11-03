#!/usr/bin/env bash
# Convert the 4 test recordings (read-only originals) into 16 kHz mono WAV in the research dir.
# Usage: prepare_audio.sh [research_dir]   (bash 3.2 compatible)
set -euo pipefail
OUT="${1:-$HOME/dev/personal/kb-chat-research}/audio"
SRC="$HOME/.kb-chat-media/audio"
mkdir -p "$OUT"
while read -r name id; do
  /opt/homebrew/bin/ffmpeg -nostdin -loglevel error -y -i "$SRC/$id.m4a" -ac 1 -ar 16000 -c:a pcm_s16le "$OUT/$name.wav"
done <<'LIST'
joseluiz_ref 8ef7ed49-b61d-445f-833d-17009e56a0c7
joseluiz_test 2d3a3fdf-f409-4cad-b4a0-b648e1c249d6
monteiro_ref 18469445-ca74-4d36-8e69-f368fc78018e
monteiro_test c78d227f-76b8-4337-9012-f913ed7a2819
LIST
ls -la "$OUT"
