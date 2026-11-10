"""The transcriber in the background: a macOS LaunchAgent (KBC-114 FR-7, ADR 0023 amendment).

`transcriber service install` writes
`~/Library/LaunchAgents/br.com.nova-alexandria.transcriber.plist`
and loads it with `launchctl bootstrap`. The owner wants it on only when needed: launchd runs
`transcriber run --exit-when-idle` once at login (RunAtLoad), never keeps it alive; it drains
the queue and exits, and the API on the same Mac starts it again (`launchctl kickstart`) when a
job waits. Its log is under
`~/Library/Logs/nova-alexandria-transcriber/`. The plist carries the vault (`KB_CHAT_VAULT`)
and a PATH that finds uv, kb and ffmpeg; never the token, which stays in the Keychain.
launchctl is reached through `Launchctl`, so tests use a fake one.
"""

import plistlib
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

# The label the owner's Mac already runs (installed by hand on 2026-11-09): installing again
# updates that agent, never a second one.
LABEL = "br.com.nova-alexandria.transcriber"
# The label of the template before KBC-114: an agent left under it is taken out on install.
LEGACY_LABELS = ("com.nova-alexandria.transcriber",)
LOG_FOLDER = "nova-alexandria-transcriber"
LOG_FILE = "service.log"
BASE_PATH = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")
# The tools the worker runs: uv runs it, kb publishes (KBC-099), ffmpeg decodes.
TOOLS = ("uv", "kb", "ffmpeg")
LAUNCHCTL = "/bin/launchctl"
# After a bootout, launchd is asked every POLL_S, for at most SETTLE_S, until the label goes.
POLL_S = 0.25
SETTLE_S = 10.0
# A bootstrap refused (error 5 while launchd settles) is tried this many times in all.
BOOTSTRAP_TRIES = 3
RETRY_S = 1.0
# This checkout: tools/transcriber/src/transcriber → the repository's root.
REPO = Path(__file__).resolve().parents[4]


class ServiceError(Exception):
    """The agent could not be installed or loaded: the message says why."""


class Launchctl(Protocol):
    def run(self, args: list[str]) -> tuple[int, str]: ...


class LaunchctlCli:
    """The real `launchctl`, with fixed arguments as a list (never a shell)."""

    def run(self, args: list[str]) -> tuple[int, str]:
        done = subprocess.run(
            [LAUNCHCTL, *args], capture_output=True, text=True, timeout=30, check=False
        )
        return done.returncode, (done.stdout + done.stderr).strip()


@dataclass
class Service:
    home: Path
    uid: int
    launchctl: Launchctl
    repo: Path = REPO
    which: Callable[[str], str | None] = field(default=shutil.which)
    sleep: Callable[[float], None] = field(default=time.sleep)

    @property
    def plist_path(self) -> Path:
        return self.home / "Library" / "LaunchAgents" / f"{LABEL}.plist"

    @property
    def log_path(self) -> Path:
        return self.home / "Library" / "Logs" / LOG_FOLDER / LOG_FILE

    @property
    def domain(self) -> str:
        return f"gui/{self.uid}"

    @property
    def target(self) -> str:
        return f"{self.domain}/{LABEL}"

    def path_env(self) -> str:
        """The folders of uv, kb and ffmpeg first, then the usual ones, each once."""
        found = [self.which(tool) for tool in TOOLS]
        folders = [str(Path(one).parent) for one in found if one]
        return ":".join(dict.fromkeys([*folders, *BASE_PATH]))

    def plist(self, vault: str | None, extras: list[str]) -> dict:
        uv = self.which("uv")
        if not uv:
            raise ServiceError("uv não está no PATH: instale com `brew install uv`.")
        program = [uv, "run", "--project", str(self.repo / "tools" / "transcriber")]
        for extra in extras:
            program += ["--extra", extra]
        env = {"PATH": self.path_env(), "HOME": str(self.home)}
        if vault:
            env["KB_CHAT_VAULT"] = vault
        log = str(self.log_path)
        return {
            "Label": LABEL,
            "ProgramArguments": [*program, "transcriber", "run", "--exit-when-idle"],
            "WorkingDirectory": str(self.repo),
            "EnvironmentVariables": env,
            "RunAtLoad": True,
            "ThrottleInterval": 10,
            "ProcessType": "Standard",
            # A track transcribed whole is one call to the model: SIGTERM waits for it.
            "ExitTimeOut": 300,
            "StandardOutPath": log,
            "StandardErrorPath": log,
        }

    def loaded(self) -> tuple[bool, str]:
        code, output = self.launchctl.run(["print", self.target])
        return code == 0, output

    def drop_legacy(self) -> None:
        """An agent under an older label would run a second worker: stopped and removed."""
        for label in LEGACY_LABELS:
            old = self.plist_path.with_name(f"{label}.plist")
            if old.exists():
                self.launchctl.run(["bootout", f"{self.domain}/{label}"])
                old.unlink()

    def install(self, vault: str | None, extras: list[str], load: bool = True) -> Path:
        content = plistlib.dumps(self.plist(vault, extras))
        self.drop_legacy()
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.plist_path.parent.mkdir(parents=True, exist_ok=True)
        if load and self.loaded()[0]:
            # The old one goes first: bootstrap refuses a label already loaded.
            self.launchctl.run(["bootout", self.target])
            self._wait_gone()
        self.plist_path.write_bytes(content)
        self.plist_path.chmod(0o644)
        if load:
            self._bootstrap()
        return self.plist_path

    def _wait_gone(self) -> None:
        """`bootout` returns before launchd lets the label go (KBC-117 (2)): a bootstrap
        meanwhile fails with error 5. Polls `print` until the old agent is gone, bounded."""
        waited = 0.0
        while self.loaded()[0]:
            if waited >= SETTLE_S:
                raise ServiceError(
                    f"o agente antigo não saiu do launchd em {SETTLE_S:.0f} s; "
                    f"tente `launchctl bootout {self.target}` e instale de novo."
                )
            self.sleep(POLL_S)
            waited += POLL_S

    def _bootstrap(self) -> None:
        """Bootstraps, again after a refusal (launchd may still be settling), and only calls
        it done when `print` sees the agent: the status says what launchd really has."""
        code, output = 0, ""
        for attempt in range(1, BOOTSTRAP_TRIES + 1):
            code, output = self.launchctl.run(["bootstrap", self.domain, str(self.plist_path)])
            if code == 0 or self.loaded()[0]:
                break
            if attempt < BOOTSTRAP_TRIES:
                self.sleep(attempt * RETRY_S)
        if code != 0 and not self.loaded()[0]:
            raise ServiceError(f"launchctl bootstrap falhou ({code}): {output}")
        if not self.loaded()[0]:
            raise ServiceError("launchctl bootstrap respondeu 0, mas o launchd não tem o agente")

    def kickstart(self) -> bool:
        """Starts the loaded agent now (never `-k`: a job in hand is not killed); False when
        it is not loaded (`keys set` on a Mac without the service)."""
        if not self.loaded()[0]:
            return False
        code, _ = self.launchctl.run(["kickstart", self.target])
        return code == 0

    def uninstall(self) -> None:
        """Stops and unloads it (one not loaded is fine) and removes the file."""
        self.launchctl.run(["bootout", self.target])
        self.plist_path.unlink(missing_ok=True)

    def status(self) -> dict:
        loaded, output = self.loaded()
        pid = re.search(r"^\s*pid = (\d+)", output, re.MULTILINE) if loaded else None
        state = re.search(r"^\s*state = (.+)$", output, re.MULTILINE) if loaded else None
        last = re.search(r"^\s*last exit code = (.+)$", output, re.MULTILINE) if loaded else None
        return {
            "installed": self.plist_path.is_file(),
            "loaded": loaded,
            "running": bool(state and state.group(1).strip() == "running"),
            "pid": int(pid.group(1)) if pid else None,
            "lastExit": last.group(1).strip() if last else None,
            "log": str(self.log_path),
        }


def describe(status: dict) -> list[str]:
    """`transcriber service status` in words."""
    lines = [
        f"Instalado: {'sim' if status['installed'] else 'não'}",
        f"Carregado no launchd: {'sim' if status['loaded'] else 'não'}",
    ]
    if status["running"]:
        lines.append(f"Estado: rodando (pid {status['pid']})")
    elif status["loaded"]:
        lines.append(f"Estado: parado (última saída: {status['lastExit'] or '?'})")
    lines.append(f"Log: {status['log']}")
    return lines
