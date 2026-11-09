"""Publishing is on by default with a vault (KBC-114 BR-7): no mark on the Mac."""

import argparse
import os
from pathlib import Path

import numpy as np
import pytest

from transcriber.api import ApiClient
from transcriber.cli import publisher_of
from transcriber.worker import Worker

from .conftest import TOKEN, FakeModel


@pytest.fixture
def kb_on_path(tmp_path, monkeypatch) -> Path:
    """A fake `kb` on PATH that only says its version: never the real binary."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    kb = bin_dir / "kb"
    kb.write_text("#!/bin/sh\necho '0.0.12 (fake)'\n", encoding="utf-8")
    kb.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    vault = tmp_path / "vault"
    vault.mkdir()
    return vault


def kinds_of(publisher) -> tuple[str, ...]:
    return Worker(
        api=ApiClient("http://localhost:1", lambda: TOKEN, "mac"),
        model=FakeModel(),
        find_speech=lambda _: [],
        decode=lambda _: np.zeros(1, dtype=np.float32),
        publisher=publisher,
    ).kinds


def test_ac7_a_mac_with_a_vault_and_kb_publishes_by_default(kb_on_path):
    publisher = publisher_of(argparse.Namespace(no_kb_publish=False), str(kb_on_path))
    assert publisher is not None
    assert publisher.vault == kb_on_path
    assert "kb-publish" in kinds_of(publisher)


def test_ac7_no_kb_publish_keeps_the_mac_out_of_it(kb_on_path):
    publisher = publisher_of(argparse.Namespace(no_kb_publish=True), str(kb_on_path))
    assert publisher is None
    assert "kb-publish" not in kinds_of(publisher)


def test_ac7_without_a_vault_the_mac_never_asks_for_kb_publish(kb_on_path):
    assert publisher_of(argparse.Namespace(no_kb_publish=False), None) is None


class InstallRecorder:
    def __init__(self) -> None:
        self.installs: list[dict] = []

    def install(self, vault, extras, load=True):
        self.installs.append({"vault": vault, "extras": extras, "load": load})
        return Path("/Users/o/Library/LaunchAgents/br.com.nova-alexandria.transcriber.plist")


def test_pairing_on_a_mac_also_keeps_it_on_in_the_background(tmp_path, monkeypatch):
    """The owner never starts it by hand (KBC-114 AC-15): pairing installs the service."""
    from transcriber import cli

    agent = InstallRecorder()
    monkeypatch.setattr(cli, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(cli, "save_keychain", lambda token: None)
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: "nat_" + "x" * 40)
    monkeypatch.setattr(cli, "service_of", lambda **kwargs: agent)
    monkeypatch.setattr(cli.sys, "platform", "darwin")
    vault = tmp_path / "vault"
    vault.mkdir()
    assert cli.main(["pair", "--api-url", "https://app.example", "--vault", str(vault)]) == 0
    assert agent.installs == [
        {"vault": str(vault), "extras": ["diarize", "voiceprint"], "load": True}
    ]


def test_pairing_with_no_service_only_pairs(tmp_path, monkeypatch):
    from transcriber import cli

    agent = InstallRecorder()
    monkeypatch.setattr(cli, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(cli, "save_keychain", lambda token: None)
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: "nat_" + "x" * 40)
    monkeypatch.setattr(cli, "service_of", lambda **kwargs: agent)
    monkeypatch.setattr(cli.sys, "platform", "darwin")
    assert cli.main(["pair", "--api-url", "https://app.example", "--no-service"]) == 0
    assert agent.installs == []
