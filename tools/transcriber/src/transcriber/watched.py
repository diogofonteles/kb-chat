"""A long local step runs to its end; only one that stopped working is ended (KBC-190).

kb, kb-map and QMD run here for as long as their work takes: a `kb link` over a whole
collection takes more than an hour, and it keeps nothing when it is cut in the middle, so a
fixed limit made it start over at every attempt. What is watched is the work instead: a step
whose processes used no CPU and started none for `STALL_S` is stuck, and it ends with
everything it started.

The step stays in the worker's process group: when launchd ends the worker (an uninstall, a
reinstall, the kill after `ExitTimeOut`), the step ends with it and never writes the vault
after its lock is gone. Its own processes are found by their parents instead.
"""

import contextlib
import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from contextvars import ContextVar
from pathlib import Path
from typing import IO, Final

# A step with no work for this long is stuck (no CPU in any of its processes, none new).
STALL_S: Final = 20 * 60
POLL_S: Final = 15.0
# After the step's processes end, how long its output may still take to arrive: one that
# left the step (a daemon holding the pipe) never holds the worker.
DRAIN_S: Final = 5.0
PS: Final = "/bin/ps"

Stop = Callable[[], bool]
_STOP: ContextVar[Stop | None] = ContextVar("step_stop", default=None)


class StepEnded(Exception):
    """The step was ended: stuck, or past the fixed limit of a download. What it had said
    before is kept (kb's receipts, where it was)."""

    def __init__(self, reason: str, stdout: str = "", stderr: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.stdout = stdout
        self.stderr = stderr

    @property
    def output(self) -> str:
        """What the step said, then why it was ended."""
        said = (self.stdout + self.stderr).strip()
        return f"{said}\n{self.reason}" if said else self.reason


class StepStopped(StepEnded):
    """The job stopped (a shutdown or a lost lease): the step ended with it."""


@contextlib.contextmanager
def stopped_by(stop: Stop) -> Iterator[None]:
    """Every step run inside ends when `stop()` turns true (the job's shutdown or lost lease)."""
    token = _STOP.set(stop)
    try:
        yield
    finally:
        _STOP.reset(token)


def cpu_seconds(text: str) -> float | None:
    """`ps`'s CPU time ("[dd-][hh:]mm:ss[.ss]") in seconds; None when it is not one."""
    days, _, clock = text.strip().rpartition("-")
    try:
        parts = [float(part) for part in clock.split(":")]
        whole_days = int(days) if days else 0
    except ValueError:
        return None
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + part
    return seconds + whole_days * 86_400


def _tree(root: int) -> dict[int, float] | None:
    """CPU seconds of the root and every live process under it; None when `ps` cannot say."""
    try:
        listed = subprocess.run(
            [PS, "-A", "-o", "pid=,ppid=,time="],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if listed.returncode != 0:
        return None
    children: dict[int, list[int]] = {}
    spent: dict[int, float] = {}
    for line in listed.stdout.splitlines():
        fields = line.split()
        if len(fields) != 3 or not fields[0].isdigit() or not fields[1].isdigit():
            continue
        cpu = cpu_seconds(fields[2])
        if cpu is None:
            continue
        pid, parent = int(fields[0]), int(fields[1])
        spent[pid] = cpu
        children.setdefault(parent, []).append(pid)
    found: dict[int, float] = {}
    waiting = [root]
    while waiting:
        pid = waiting.pop()
        if pid in found or pid not in spent:
            continue
        found[pid] = spent[pid]
        waiting.extend(children.get(pid, []))
    return found


def _worked(before: dict[int, float], now: dict[int, float]) -> bool:
    """A new process, or more CPU in one already there."""
    return any(pid not in before or spent > before[pid] for pid, spent in now.items())


def _signal(pids: set[int], sig: signal.Signals) -> None:
    for pid in pids:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, sig)


def _end_tree(root: int) -> None:
    """Freezes the root and all under it (a frozen process starts none), then kills them all:
    nothing is left to go on writing."""
    frozen: set[int] = set()
    for _ in range(20):
        tree = _tree(root)
        found = set(tree) if tree is not None else {root}
        new = found - frozen
        if not new:
            break
        _signal(new, signal.SIGSTOP)
        frozen |= new
    _signal(frozen | {root}, signal.SIGKILL)


class _Output:
    """The step's output, read as it comes (a full pipe never blocks the step)."""

    def __init__(self, streams: tuple[IO[bytes], IO[bytes]]) -> None:
        self._chunks: tuple[list[bytes], list[bytes]] = ([], [])
        self._readers = [
            threading.Thread(target=self._read, args=(stream, chunks), daemon=True)
            for stream, chunks in zip(streams, self._chunks, strict=True)
        ]
        for reader in self._readers:
            reader.start()

    @staticmethod
    def _read(stream: IO[bytes], chunks: list[bytes]) -> None:
        with contextlib.suppress(OSError, ValueError):
            while chunk := os.read(stream.fileno(), 65_536):
                chunks.append(chunk)

    def drain(self, wait_s: float) -> tuple[str, str]:
        """What arrived until the pipes closed, or until `wait_s` passed."""
        until = time.monotonic() + wait_s
        for reader in self._readers:
            reader.join(max(0.0, until - time.monotonic()))
        out, err = (b"".join(chunks).decode("utf-8", "replace") for chunks in self._chunks)
        return out, err


def run_watched(
    command: list[str],
    *,
    timeout: float | None = None,
    cwd: Path | str | None = None,
    env: dict[str, str] | None = None,
    stall_s: float = STALL_S,
    poll_s: float = POLL_S,
    drain_s: float = DRAIN_S,
) -> subprocess.CompletedProcess:
    """Runs a command until it ends. It is ended, with all it started (uv starts kb-map, which
    starts kb, which starts qmd), only when it did no work for `stall_s`, when the job stops
    (`stopped_by`), or, with a `timeout` (downloads only), past it. Raises StepEnded then."""
    name = Path(command[0]).name
    stop = _STOP.get()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if process.stdout is None or process.stderr is None:  # pragma: no cover (both are pipes)
        raise RuntimeError("the step's output is not piped")
    output = _Output((process.stdout, process.stderr))
    started = last_work = time.monotonic()
    seen: dict[int, float] = {}

    def ended(kind: type[StepEnded], reason: str) -> StepEnded:
        _end_tree(process.pid)
        process.wait()
        return kind(reason, *output.drain(drain_s))

    try:
        while True:
            wait = poll_s
            if timeout is not None:
                wait = max(0.01, min(poll_s, started + timeout - time.monotonic()))
            try:
                process.wait(timeout=wait)
                break
            except subprocess.TimeoutExpired:
                pass
            now = time.monotonic()
            if stop is not None and stop():
                raise ended(StepStopped, f"{name}: stopped with the job")
            if timeout is not None and now - started > timeout:
                raise ended(StepEnded, f"{name}: took more than {timeout:.0f} s")
            tree = _tree(process.pid)
            # Without ps nothing is known: it is never ended for that.
            if tree is None or _worked(seen, tree):
                last_work = now
            if tree is not None:
                seen = tree
            if now - last_work >= stall_s:
                raise ended(StepEnded, f"{name}: stalled, no work for {stall_s:.0f} s; stopped")
        stdout, stderr = output.drain(drain_s)
    finally:
        for stream in (process.stdout, process.stderr):
            with contextlib.suppress(OSError):
                stream.close()
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
