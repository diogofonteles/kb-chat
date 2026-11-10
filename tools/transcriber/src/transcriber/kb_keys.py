"""The kb's AI keys on this Mac (KBC-117): in the Keychain, handed to the kb subprocess only.

Under launchd the owner's shell never runs, so a key his `~/.zshrc` exports never reaches kb
and every publication died with "OPENROUTER_API_KEY is not set". `transcriber keys set` stores
each key in the macOS Keychain (service `nova-alexandria-transcriber-kb`, the variable's name
as the account), written through `security -i` so the value is never in a process's argv,
never echoed, logged or written to a file. The worker reads them when it starts and passes
them in the environment of each `kb` it runs, never in its own. A key the process already has
(the old plist workaround) wins, so the move off it breaks nothing.
"""

import os
import re
import subprocess
from collections.abc import Mapping
from typing import Protocol

KB_KEYS_SERVICE = "nova-alexandria-transcriber-kb"
# What kb reads (kb 0.0.12): OpenRouter decides and generates; the others are kept for it.
REQUIRED_KEY = "OPENROUTER_API_KEY"
KB_KEY_NAMES = (REQUIRED_KEY, "ANTHROPIC_API_KEY", "OPENAI_API_KEY")
# A key goes into the line `security -i` reads: no space, quote or newline may end it early.
KEY_PATTERN = re.compile(r"^[A-Za-z0-9_.:+/=-]{16,512}\Z")
# What the app shows (the reason `kb-ai-key-missing`), with what to do on the Mac.
KEY_MISSING = 'chave da IA do kb ausente (OPENROUTER_API_KEY): no Mac, rode "transcriber keys set"'
KB_MISSING = "o kb não está no PATH do serviço (ou a pasta do vault não existe)"
# kb's own words for a key it does not have (decisions, generation, transcribe).
CONFIGURATION_ERROR = re.compile(
    r"_API_KEY is not set|model is required|missing API key", re.IGNORECASE
)


class KbKeyError(Exception):
    """A key that cannot be stored: the message never carries its value."""


class KeyStore(Protocol):
    def read(self, name: str) -> str | None: ...

    def save(self, name: str, value: str) -> None: ...

    def delete(self, name: str) -> bool: ...


def check_key(name: str, value: str) -> None:
    if name not in KB_KEY_NAMES:
        raise KbKeyError(f"{name} não é uma chave do kb ({', '.join(KB_KEY_NAMES)})")
    if not KEY_PATTERN.match(value):
        raise KbKeyError(f"{name}: isso não parece uma chave de API (nada foi guardado)")


class KeychainKeys:
    """The real Keychain through `security`, with fixed arguments (never a shell)."""

    def read(self, name: str) -> str | None:
        done = subprocess.run(
            ["security", "find-generic-password", "-s", KB_KEYS_SERVICE, "-a", name, "-w"],
            capture_output=True,
            text=True,
            check=False,
        )
        value = done.stdout.strip()
        return value if done.returncode == 0 and value else None

    def save(self, name: str, value: str) -> None:
        """`security -i` reads the command from stdin: the value is never in argv (ps)."""
        check_key(name, value)
        command = f"add-generic-password -U -s {KB_KEYS_SERVICE} -a {name} -w {value}\n"
        done = subprocess.run(
            ["security", "-i"], input=command, capture_output=True, text=True, check=False
        )
        if done.returncode != 0 or done.stderr.strip():
            # Never trust security's message not to repeat the command line it read.
            said = done.stderr.replace(value, "…").strip()[:200]
            raise KbKeyError(f"o Keychain recusou {name}: {said}")

    def delete(self, name: str) -> bool:
        """False when there was nothing to delete (security answers 44)."""
        done = subprocess.run(
            ["security", "delete-generic-password", "-s", KB_KEYS_SERVICE, "-a", name],
            capture_output=True,
            check=False,
        )
        return done.returncode == 0


def kb_env(store: KeyStore, environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """The keys kb gets: the process's own (the old workaround) first, else the Keychain's."""
    environ = os.environ if environ is None else environ
    found: dict[str, str] = {}
    for name in KB_KEY_NAMES:
        value = environ.get(name) or store.read(name)
        if value:
            found[name] = value
    return found


def kb_problems(vault: str | None, publisher: object | None, env: Mapping[str, str]) -> list:
    """Why this Mac cannot publish now, for the status (`unavailable`); empty when it can or
    when it has no vault (it does not publish at all)."""
    if not vault:
        return []
    if publisher is None:
        return [{"kind": "kb-publish", "reason": "kb-missing", "detail": KB_MISSING}]
    if not env.get(REQUIRED_KEY):
        return [{"kind": "kb-publish", "reason": "kb-ai-key-missing", "detail": KEY_MISSING}]
    return []


def is_configuration_error(output: str) -> bool:
    """kb failed because this Mac is not set up, not because of a document or the network."""
    return bool(CONFIGURATION_ERROR.search(output))
