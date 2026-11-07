"""The vault and its index sent to production by themselves (KBC-100 FR-4, ADR 0035 §9).

After a publication the change is pending; `sync-vault.sh --hot` runs at most once every 30
minutes, only with a change pending, from the worker's own loop (never during a job). The
script takes the VM's deploy lock and caps deletions; `install-index.sh --hot` then swaps the
index without restarting the API. A failed sync keeps the change pending for the next turn.
"""

import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

SYNC_INTERVAL_S = 30 * 60
# rsync of a big vault plus the index snapshot; past this the run is given up.
SYNC_TIMEOUT_S = 60 * 60
REPORT_CHARS = 2_000


def run_script(command: list[str]) -> tuple[int, str]:
    """The real script, its output joined; never called by the tests."""
    try:
        done = subprocess.run(
            command, capture_output=True, text=True, timeout=SYNC_TIMEOUT_S, check=False
        )
    except subprocess.TimeoutExpired:
        return 124, f"sync-vault: timed out after {SYNC_TIMEOUT_S} s"
    except OSError as err:
        return 127, f"sync-vault: {err}"
    return done.returncode, (done.stdout + done.stderr).strip()


def _iso(seconds: float) -> str:
    return (
        datetime.fromtimestamp(seconds, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


@dataclass
class VaultSync:
    script: Path
    host: str
    vault: Path
    interval_s: float = SYNC_INTERVAL_S
    clock: Callable[[], float] = time.time
    runner: Callable[[list[str]], tuple[int, str]] = field(default=run_script)
    last_run: float | None = None
    pending: bool = False

    def mark_pending(self) -> None:
        self.pending = True

    def due(self) -> bool:
        if not self.pending:
            return False
        return self.last_run is None or self.clock() - self.last_run >= self.interval_s

    def command(self) -> list[str]:
        return [str(self.script), "--host", self.host, "--vault", str(self.vault), "--hot"]

    def run_if_due(self) -> dict | None:
        """The report of the sync it ran (for the API), or None when nothing was due."""
        if not self.due():
            return None
        started = self.clock()
        code, output = self.runner(self.command())
        self.last_run = self.clock()
        self.pending = code != 0
        return {
            "ok": code == 0,
            "detail": (output or f"exit {code}")[-REPORT_CHARS:],
            "startedAt": _iso(started),
            "finishedAt": _iso(self.last_run),
        }
