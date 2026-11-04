#!/usr/bin/env bash
# Downloads pinned static ffmpeg and ffprobe builds. apt-get hung for 20 minutes on two CI
# runs; a release file from GitHub is one bounded request, and every attempt has a limit.
# 6.1.1 is what apt gave ubuntu-24.04, so the fixtures and the AAC encoder stay the same.
set -euo pipefail

target=$1
release=https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1
attempts=3

fetch() {
  local name=$1 sum=$2 try
  for try in $(seq 1 "$attempts"); do
    if curl --fail --location --silent --show-error --connect-timeout 15 --max-time 90 \
      --output "$target/$name.gz" "$release/$name-linux-x64.gz" &&
      echo "$sum  $target/$name.gz" | sha256sum --check --quiet; then
      gunzip --force "$target/$name.gz"
      chmod +x "$target/$name"
      return 0
    fi
    echo "::warning::$name download failed (attempt $try of $attempts)"
    sleep $((try * 5))
  done
  return 1
}

mkdir -p "$target"
fetch ffmpeg bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa
fetch ffprobe 25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067
