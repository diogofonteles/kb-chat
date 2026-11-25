"""A small kb vault per test, and guards: no test may reach a model, the network or the Keychain."""

import subprocess
import urllib.request
from pathlib import Path

import pytest

from kb_map.commands import _common

TOPIC = "hermetismo"
_REAL_RUN = subprocess.run


@pytest.fixture(autouse=True)
def no_outside_world(monkeypatch):
    def refuse_network(*_args, **_kwargs):
        raise AssertionError("a test tried to reach the network")

    def guarded_run(command, *args, **kwargs):
        if command and command[0] in ("security", "claude", "codex", "kb", "rsync", "ssh"):
            raise AssertionError(f"a test tried to run {command[0]}")
        return _REAL_RUN(command, *args, **kwargs)

    monkeypatch.setattr(urllib.request, "urlopen", refuse_network)
    monkeypatch.setattr(subprocess, "run", guarded_run)
    monkeypatch.delenv("KB_VAULT", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(_common, "provider_factory", None)


def write_doc(vault: Path, relative: str, body: str, **frontmatter: str) -> str:
    """Writes a source of the test topic; returns its doc id (topic-relative path)."""
    keys = {"title": Path(relative).stem, "type": "source", **frontmatter}
    head = "".join(f"{key}: {value}\n" for key, value in keys.items())
    path = vault / TOPIC / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{head}---\n{body}", encoding="utf-8")
    return relative


def write_concept(vault: Path, title: str, criterion: str, aliases: tuple[str, ...] = ()) -> Path:
    alias_lines = "".join(f"    - {alias}\n" for alias in aliases)
    page = vault / TOPIC / "wiki" / "concepts" / f"{title}.md"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(
        "---\n"
        "created: 2026-10-23\n"
        "domain: esoterismo\n"
        "sources: []\n"
        "stage: stub\n"
        "tags:\n    - esoterismo\n    - wiki\n    - stub\n"
        f"title: {title}\n"
        "type: wiki\n"
        "updated: 2026-10-23\n"
        f"criterion: {criterion}\n" + (f"aliases:\n{alias_lines}" if aliases else "") + "---\n"
        f"# {title}\n",
        encoding="utf-8",
    )
    return page


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    (root / TOPIC).mkdir(parents=True)
    (root / "kb.toml").write_text(
        '[vault]\nroot = "."\n\n[generation]\nmodel = "deepseek/deepseek-v4-flash"\n'
        'fallback_model = "xiaomi/mimo-v2.6-flash"\n',
        encoding="utf-8",
    )
    (root / TOPIC / "topic.yaml").write_text(
        "slug: hermetismo\ntitle: Hermetismo\ndomain: esoterismo\n", encoding="utf-8"
    )
    (root / TOPIC / "log.md").write_text(
        "# Hermetismo — Log\n\n## [2026-10-23] bootstrap | topic scaffolded\n", encoding="utf-8"
    )
    return root
