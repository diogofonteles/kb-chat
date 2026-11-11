#!/usr/bin/env bash
# One heavy command at a time on this machine, across every worktree: gates and E2E wait
# here for their turn, then for the load to fall, so parallel agents do not stack up.
#
# Each run also gets a temp root of its own: TMPDIR for the command and everything it spawns,
# removed when it ends, however it ends. The root is named after its owner's pid, so a run only
# ever sweeps roots whose owner is gone, never the root of a run still alive in another
# worktree. The same applies to runs that skip this file (tools/test-temp.mjs).
#
#   tools/heavy.sh <command> [args...]
#
#   KBC_HEAVY_SKIP=1        run right away, still in a root of its own (CI skips all of this:
#                           it has a machine per job)
#   KBC_HEAVY_MAX_LOAD=<n>  the whole 1-minute load to stay under (default: the number of CPUs)
#   KBC_HEAVY_LOAD_WAIT=<s> the longest wait for the load, then it runs anyway (default 300)
#   KBC_HEAVY_WORKERS=<n>   the workers of each vitest in the run (VITEST_MAX_WORKERS, which wins
#                           when set): half the CPUs, a quarter when the load never fell, at least 2
#   KBC_HEAVY_LOCK=<dir>    the lock (default ~/.cache/kb-chat/heavy.lock)
#   KBC_HEAVY_TEMP=<dir>    where the runs' roots live (default ~/.cache/kb-chat/tmp, a short
#                           path: Chrome and Nx put sockets under TMPDIR)
#   KBC_HEAVY_MIN_FREE_GB=<n>  refuse to run with less free than this (default 30)
#   KBC_HEAVY_ASYNC_STDIO=1 leave Node's writes to a pipe asynchronous (the macOS default),
#                           without tools/blocking-stdio.cjs: a long log may then lose its end
#
# Each run starts by saying the commit it runs on and whether the tree is clean, so a log names
# what it proves. A command already inside the queue passes through (`pnpm gates` runs `pnpm test`). Turns
# are polled: whoever asks first after a release goes first, not strictly in order of arrival.
set -u

[ "$#" -gt 0 ] || {
  echo 'usage: tools/heavy.sh <command> [args...]' >&2
  exit 64
}

if [ -n "${CI:-}" ] || [ "${KBC_HEAVY_HELD:-}" = 1 ]; then
  exec "$@"
fi

here=$(cd "$(dirname "$0")" && pwd)
lock=${KBC_HEAVY_LOCK:-$HOME/.cache/kb-chat/heavy.lock}
temp=${KBC_HEAVY_TEMP:-$HOME/.cache/kb-chat/tmp}
min_free=${KBC_HEAVY_MIN_FREE_GB:-30}
poll=${KBC_HEAVY_POLL:-2}
say_every=30
mkdir -p "$(dirname "$lock")" "$temp"

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

# Roots whose owner died: a killed run has no teardown of its own.
sweep() {
  local dir pid swept=0
  for dir in "$temp"/*; do
    case ${dir##*/} in *.*) ;; *) continue ;; esac
    pid=${dir##*/}
    pid=${pid%%.*}
    case $pid in '' | *[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null && continue
    rm -rf "$dir" 2>/dev/null || continue
    swept=$((swept + 1))
  done
  [ "$swept" -eq 0 ] || echo "heavy: swept the temp of $swept dead runs"
}

revision() {
  local sha changed
  sha=$(git rev-parse HEAD 2>/dev/null) || {
    echo 'no commit (not a git checkout)'
    return 0
  }
  changed=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  case $changed in
    0) echo "$sha (clean)" ;;
    1) echo "$sha (dirty: 1 changed path)" ;;
    *) echo "$sha (dirty: $changed changed paths)" ;;
  esac
}

free_gb() {
  df -Pk "$temp" | awk 'NR == 2 { print int($4 / 1048576) }'
}

started=$(date +%s)
said=$started
until [ "${KBC_HEAVY_SKIP:-}" = 1 ] || take_lock "$@"; do
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
root=
# Each signal in turn to the run's process group, `<signal> <tenths of a second to wait>`,
# until nothing of it is left.
signal_run() {
  local tenths
  [ -n "$child" ] || return 0
  while [ "$#" -gt 0 ]; do
    kill "-$1" -- "-$child" 2>/dev/null || return 0
    tenths=$2
    shift 2
    while [ "$tenths" -gt 0 ]; do
      kill -0 -- "-$child" 2>/dev/null || return 0
      sleep 0.1
      tenths=$((tenths - 1))
    done
  done
}
# Every process under this one, however it left the group: Playwright's web servers lead
# groups of their own.
descendants() {
  ps -Ao pid=,ppid= | awk -v root="$1" '
    function walk(parent, n, ids, i) {
      n = split(kids[parent], ids, " ")
      for (i = 1; i <= n; i++) {
        print ids[i]
        walk(ids[i])
      }
    }
    { kids[$2] = kids[$2] " " $1 }
    END { walk(root) }'
}
# The processes in $@, TERM and then KILL after two seconds.
stop_processes() {
  local pid tenths=20
  [ "$#" -gt 0 ] || return 0
  kill -TERM "$@" 2>/dev/null
  while [ "$tenths" -gt 0 ]; do
    for pid in "$@"; do
      kill -0 "$pid" 2>/dev/null && break
      pid=
    done
    [ -n "$pid" ] || return 0
    sleep 0.1
    tenths=$((tenths - 1))
  done
  kill -KILL "$@" 2>/dev/null
}
release() {
  signal_run TERM 20 KILL 0
  [ -z "$root" ] || rm -rf "$root"
  # The directory is ours only while the owner file says so.
  [ "$(sed -n 1p "$lock/owner" 2>/dev/null)" = "$$" ] && rm -rf "$lock"
}
stop() {
  [ -n "$child" ] || exit 143
  local tree
  tree="$child $(descendants "$child")"
  # INT first: it is the stop Playwright and Nx tear their servers and workers down on.
  signal_run INT 100 TERM 20 KILL 0
  # shellcheck disable=SC2086 # one word per pid
  stop_processes $tree
  wait "$child" 2>/dev/null
  exit 143
}
trap release EXIT
trap stop INT TERM HUP

locked=$(date +%s)
max_load=${KBC_HEAVY_MAX_LOAD:-$(cpus)}
load_wait=${KBC_HEAVY_LOAD_WAIT:-300}
loaded=0
while [ "${KBC_HEAVY_SKIP:-}" != 1 ] && [ "$(load_whole)" -ge "$max_load" ]; do
  now=$(date +%s)
  if [ $((now - locked)) -ge "$load_wait" ]; then
    echo "heavy: the load stayed above $max_load for $load_wait s; going ahead"
    loaded=1
    break
  fi
  echo "heavy: load $(load_now) above $max_load, waiting"
  sleep "$((poll * 5))"
done

sweep
free=$(free_gb)
# Not a number on either side refuses too: an unknown free space is not enough free space.
if ! [ "$free" -ge "$min_free" ] 2>/dev/null; then
  echo "heavy: refusing to run: $free GB free on the disk of $temp, a heavy run needs $min_free GB." >&2
  echo "heavy: free some space first (KBC_HEAVY_MIN_FREE_GB moves the limit)." >&2
  exit 75
fi
root=$(mktemp -d "$temp/$$.XXXXXX") || exit 73

# Vitest's own default is a worker per CPU but one, in each suite: nx runs the API's and the
# web's at once, so a run alone asked for twice the machine, and a test's 5 s ran out on a
# machine already busy with other work. Half the CPUs per suite fills it once; a quarter when
# the load never fell. VITEST_MAX_WORKERS is the setting every vitest of the run reads.
workers=${KBC_HEAVY_WORKERS:-$(($(cpus) / (loaded ? 4 : 2)))}
[ "$workers" -ge 2 ] 2>/dev/null || workers=2
workers=${VITEST_MAX_WORKERS:-$workers}

if [ "${KBC_HEAVY_SKIP:-}" != 1 ]; then
  echo "heavy: waited $(($(date +%s) - started)) s; running: $*"
  # The log then names what it proves: the commit, and whether the tree carried more than it.
  echo "heavy: at $(revision)"
  echo "heavy: $workers vitest workers per suite"
fi
# A process group of its own, so that everything the command spawns can be stopped with it.
# Not under a terminal: a background group is stopped the moment it touches the terminal, as
# Nx's TUI does, and there the group of this shell already gets the terminal's signals.
# The daemon would outlive the run in a TMPDIR that is gone; Chrome on macOS ignores TMPDIR.
(: </dev/tty) 2>/dev/null || set -m
# Node's writes to a pipe are blocking, as on Linux: see tools/blocking-stdio.cjs.
node_options=${NODE_OPTIONS:-}
[ "${KBC_HEAVY_ASYNC_STDIO:-}" = 1 ] ||
  node_options="--require \"$here/blocking-stdio.cjs\"${node_options:+ $node_options}"
KBC_HEAVY_HELD=1 KBC_TEST_TEMP=$root TMPDIR=$root MAC_CHROMIUM_TMPDIR=$root NX_DAEMON=false \
  NODE_OPTIONS="$node_options" VITEST_MAX_WORKERS=$workers \
  "$@" </dev/null &
child=$!
set +m
wait "$child"
status=$?
exit "$status"
