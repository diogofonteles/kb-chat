"""The worker token: in the macOS Keychain, or in a 0600 file. Never in the repository or a log."""

import os
import stat
import subprocess
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


def read_keychain() -> str:
    done = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
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


def save_keychain(token: str) -> None:
    """Stores the token; `security -w` as the last option without a value reads it from stdin."""
    done = subprocess.run(
        [
            "security",
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ],
        input=f"{token}\n{token}\n",
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0:
        raise TokenError(f"The Keychain refused the token: {done.stderr.strip()}")


def load_token() -> str:
    """KB_CHAT_TRANSCRIBER_TOKEN_FILE when set, else the Keychain."""
    file = os.environ.get("KB_CHAT_TRANSCRIBER_TOKEN_FILE")
    return read_token_file(Path(file).expanduser()) if file else read_keychain()
