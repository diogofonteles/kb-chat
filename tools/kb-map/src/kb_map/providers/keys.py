"""The OpenRouter key on this Mac: the same Keychain item the transcriber stores for kb.

`transcriber keys set` (KBC-117, `tools/transcriber/src/transcriber/kb_keys.py`) keeps kb's
keys in the macOS Keychain under the service `nova-alexandria-transcriber-kb`, the variable's
name as the account. kb-map reads that item with fixed arguments (the key comes back on
`security`'s stdout, never in any argv), keeps it in memory for the request header only, and
never prints, logs or writes it. A key already in the environment wins, as in `kb_env`.
"""

import os
import subprocess

KB_KEYS_SERVICE = "nova-alexandria-transcriber-kb"
OPENROUTER_KEY_NAME = "OPENROUTER_API_KEY"
KEY_MISSING = (
    "no OpenRouter key: on this Mac run `uv run --project tools/transcriber transcriber keys set` "
    "(Keychain service nova-alexandria-transcriber-kb) or export OPENROUTER_API_KEY"
)


class KeyMissing(Exception):
    """No key in the environment or the Keychain; the message says how to store one."""


def read_keychain(name: str, service: str = KB_KEYS_SERVICE) -> str | None:
    try:
        done = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-a", name, "-w"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return None
    value = done.stdout.strip()
    return value if done.returncode == 0 and value else None


def openrouter_key() -> str:
    value = os.environ.get(OPENROUTER_KEY_NAME) or read_keychain(OPENROUTER_KEY_NAME)
    if not value:
        raise KeyMissing(KEY_MISSING)
    return value
