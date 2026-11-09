"""The transcriber in the background: a macOS LaunchAgent (KBC-114 FR-7, ADR 0023 amendment).

`transcriber service install` writes `~/Library/LaunchAgents/com.nova-alexandria.transcriber.plist`
and loads it with `launchctl bootstrap`: launchd starts the worker at login (RunAtLoad) and
again whenever it stops (KeepAlive), with its log under
`~/Library/Logs/nova-alexandria-transcriber/`. The plist carries the vault (`KB_CHAT_VAULT`)
and a PATH that finds uv, kb and ffmpeg; never the token, which stays in the Keychain.
launchctl is reached through `Launchctl`, so tests use a fake one.
"""

import plistlib
import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

LABEL = "com.nova-alexandria.transcriber"
LOG_FOLDER = "nova-alexandria-transcriber"
LOG_FILE = "transcriber.log"
BASE_PATH = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")
# The tools the worker runs: uv runs it, kb publishes (KBC-099), ffmpeg decodes.
TOOLS = ("uv", "kb", "ffmpeg")
LAUNCHCTL = "/bin/launchctl"
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
            "ProgramArguments": [*program, "transcriber", "run"],
            "WorkingDirectory": str(self.repo),
            "EnvironmentVariables": env,
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 60,
            "ProcessType": "Standard",
            # A track transcribed whole is one call to the model: SIGTERM waits for it.
            "ExitTimeOut": 300,
            "StandardOutPath": log,
            "StandardErrorPath": log,
        }

    def loaded(self) -> tuple[bool, str]:
        code, output = self.launchctl.run(["print", self.target])
        return code == 0, output

    def install(self, vault: str | None, extras: list[str], load: bool = True) -> Path:
        content = plistlib.dumps(self.plist(vault, extras))
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.plist_path.parent.mkdir(parents=True, exist_ok=True)
        if load and self.loaded()[0]:
            # The old one goes first: bootstrap refuses a label already loaded.
            self.launchctl.run(["bootout", self.target])
        self.plist_path.write_bytes(content)
        self.plist_path.chmod(0o644)
        if load:
            code, output = self.launchctl.run(["bootstrap", self.domain, str(self.plist_path)])
            if code != 0:
                raise ServiceError(f"launchctl bootstrap falhou ({code}): {output}")
        return self.plist_path

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
