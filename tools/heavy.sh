#!/usr/bin/env bash
# One heavy command at a time on this machine, across every worktree: gates and E2E wait
# here for their turn, then for the load to fall, so parallel agents do not stack up.
#
#   tools/heavy.sh <command> [args...]
#
#   KBC_HEAVY_SKIP=1        run right away (CI skips by itself: it has a machine per job)
#   KBC_HEAVY_MAX_LOAD=<n>  the whole 1-minute load to stay under (default: the number of CPUs)
#   KBC_HEAVY_LOAD_WAIT=<s> the longest wait for the load, then it runs anyway (default 300)
#   KBC_HEAVY_LOCK=<dir>    the lock (default ~/.cache/kb-chat/heavy.lock)
#
# A command already inside the queue passes through (`pnpm gates` runs `pnpm test`). Turns
# are polled: whoever asks first after a release goes first, not strictly in order of arrival.
set -u

[ "$#" -gt 0 ] || {
  echo 'usage: tools/heavy.sh <command> [args...]' >&2
  exit 64
}

if [ -n "${CI:-}" ] || [ "${KBC_HEAVY_SKIP:-}" = 1 ] || [ "${KBC_HEAVY_HELD:-}" = 1 ]; then
  exec "$@"
fi

lock=${KBC_HEAVY_LOCK:-$HOME/.cache/kb-chat/heavy.lock}
poll=${KBC_HEAVY_POLL:-2}
say_every=30
mkdir -p "$(dirname "$lock")"

# macOS has no flock(1); mkdir is atomic on both systems.
take_lock() {
  mkdir "$lock" 2>/dev/null || return 1
  printf '%s\n%s\n%s\n' "$$" "$PWD" "$*" >"$lock/owner"
}

# A holder that died without releasing. A lock with no owner yet is one being taken: it gets
# one poll to write it.
stale() {
  local pid
  pid=$(sed -n 1p "$lock/owner" 2>/dev/null)
  [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null
}

load_now() {
  if [ -r /proc/loadavg ]; then
    cut -d' ' -f1 /proc/loadavg
  else
    sysctl -n vm.loadavg | awk '{print $2}'
  fi
}

# Whole numbers are enough for a limit, and the shell compares nothing else.
load_whole() {
  local load
  load=$(load_now)
  load=${load%%[.,]*}
  echo "${load:-0}"
}

cpus() {
  getconf _NPROCESSORS_ONLN
}

started=$(date +%s)
said=$started
until take_lock "$@"; do
  if stale; then
    echo "heavy: removing the lock of a process that died: $(sed -n 3p "$lock/owner" 2>/dev/null)"
    rm -rf "$lock"
    continue
  fi
  now=$(date +%s)
  if [ $((now - said)) -ge "$say_every" ] || [ "$said" -eq "$started" ]; then
    said=$((now + 1))
    echo "heavy: waiting $((now - started)) s for: $(sed -n 3p "$lock/owner" 2>/dev/null) ($(sed -n 2p "$lock/owner" 2>/dev/null))"
  fi
  sleep "$poll"
done

child=
release() {
  # The directory is ours only while the owner file says so.
  [ "$(sed -n 1p "$lock/owner" 2>/dev/null)" = "$$" ] && rm -rf "$lock"
}
stop() {
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
  wait "$child" 2>/dev/null
  release
  exit 143
}
trap release EXIT
trap stop INT TERM HUP

locked=$(date +%s)
max_load=${KBC_HEAVY_MAX_LOAD:-$(cpus)}
load_wait=${KBC_HEAVY_LOAD_WAIT:-300}
while [ "$(load_whole)" -ge "$max_load" ]; do
  now=$(date +%s)
  if [ $((now - locked)) -ge "$load_wait" ]; then
    echo "heavy: the load stayed above $max_load for $load_wait s; going ahead"
    break
  fi
  echo "heavy: load $(load_now) above $max_load, waiting"
  sleep "$((poll * 5))"
done

echo "heavy: waited $(($(date +%s) - started)) s; running: $*"
KBC_HEAVY_HELD=1 "$@" &
child=$!
wait "$child"
status=$?
exit "$status"
