"""The worker token: in the macOS Keychain, or in a 0600 file. Never in the repository or a log."""

import os
import re
import stat
import subprocess
from collections.abc import Callable
from pathlib import Path

from .config import KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE


class TokenError(Exception):
    """No usable token: the message says how to fix it."""


def read_token_file(path: Path) -> str:
    try:
        info = path.stat()
    except FileNotFoundError as err:
        raise TokenError(f"Token file not found: {path}") from err
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise TokenError(f"The token file {path} must be readable only by you: chmod 600 {path}")
    token = path.read_text(encoding="utf-8").strip()
    if not token:
        raise TokenError(f"The token file {path} is empty")
    return token


def read_keychain(service: str = KEYCHAIN_SERVICE, account: str = KEYCHAIN_ACCOUNT) -> str:
    done = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0 or not done.stdout.strip():
        raise TokenError(
            "No token in the Keychain: pair this Mac with "
            "`uv run --project tools/transcriber transcriber pair --api-url <url>`"
        )
    return done.stdout.strip()


TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,200}$")


def save_keychain(
    token: str, service: str = KEYCHAIN_SERVICE, account: str = KEYCHAIN_ACCOUNT
) -> None:
    """Stores the token without a terminal and without putting it in any process's argv.

    `security -i` reads its commands from stdin: the token travels in the command line it
    reads, never in `security`'s own arguments (visible in `ps`) and never at a prompt that
    `security add-generic-password -w` would open on the TTY.
    """
    if not TOKEN_PATTERN.match(token):
        raise TokenError("Esse não parece o token mostrado na tela Transcritores.")
    command = f"add-generic-password -U -s {service} -a {account} -w {token}\n"
    done = subprocess.run(
        ["security", "-i"], input=command, capture_output=True, text=True, check=False
    )
    if done.returncode != 0 or done.stderr.strip():
        raise TokenError(f"The Keychain refused the token: {done.stderr.strip()}")


def delete_keychain(service: str, account: str = KEYCHAIN_ACCOUNT) -> None:
    subprocess.run(
        ["security", "delete-generic-password", "-s", service, "-a", account],
        capture_output=True,
        check=False,
    )


class CachedToken:
    """The token, read once and again only after the API refused it (a re-pair, 401)."""

    def __init__(self, load: Callable[[], str]) -> None:
        self._load = load
        self._token: str | None = None

    def __call__(self) -> str:
        if self._token is None:
            self._token = self._load()
        return self._token

    def forget(self) -> None:
        self._token = None


def load_token() -> str:
    """KB_CHAT_TRANSCRIBER_TOKEN_FILE when set, else the Keychain."""
    file = os.environ.get("KB_CHAT_TRANSCRIBER_TOKEN_FILE")
    return read_token_file(Path(file).expanduser()) if file else read_keychain()
