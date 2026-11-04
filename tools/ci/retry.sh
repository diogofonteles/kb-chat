#!/usr/bin/env bash
# Runs an install command with a limit on each attempt, so a hung mirror costs minutes and
# a new try instead of the whole job. Give the calling step a timeout-minutes above
# attempts x seconds.
#
#   tools/ci/retry.sh <attempts> <seconds per attempt> <command>...
set -uo pipefail

attempts=$1
seconds=$2
shift 2

status=1
for try in $(seq 1 "$attempts"); do
  timeout --kill-after=10 "$seconds" "$@"
  status=$?
  [ "$status" -eq 0 ] && exit 0
  echo "::warning::$1 failed with status $status (attempt $try of $attempts, limit ${seconds}s)"
done
exit "$status"
