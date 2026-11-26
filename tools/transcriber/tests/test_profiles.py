"""One Mac, two apps (KBC-188): the first one as it always was, and production beside it, each
with its address, its token and its LaunchAgent; the vault is one."""

import json
import plistlib
from pathlib import Path

import pytest

from transcriber import cli, secret
from transcriber.config import PROFILE_ENV
from transcriber.service import LABEL, WAKE_EVERY_S

from .test_service import FakeLaunchctl, service

TOKEN = "nat_" + "x" * 40


@pytest.fixture(autouse=True)
def no_profile_leaks(monkeypatch):
    """`main` sets the profile for the whole process: each test gets it back as it was."""
    monkeypatch.setenv(PROFILE_ENV, "")


@pytest.fixture
def production(monkeypatch):
    monkeypatch.setenv(PROFILE_ENV, "producao")


def plist_of(home: Path, label: str) -> dict:
    with (home / "Library" / "LaunchAgents" / f"{label}.plist").open("rb") as file:
        return plistlib.load(file)


def test_the_first_app_is_as_it_always_was(tmp_path, monkeypatch):
    monkeypatch.delenv(PROFILE_ENV, raising=False)
    service(tmp_path, FakeLaunchctl()).install(vault="/v", extras=[])
    plist = plist_of(tmp_path, LABEL)
    # Its API, on this Mac, starts it when a job waits: launchd never does.
    assert "StartInterval" not in plist
    assert PROFILE_ENV not in plist["EnvironmentVariables"]
    assert plist["StandardOutPath"].endswith("/service.log")


def test_production_has_its_own_agent_that_wakes_by_itself(tmp_path, production):
    launchctl = FakeLaunchctl()
    agent = service(tmp_path, launchctl)
    agent.install(vault="/v", extras=["diarize"])
    label = f"{LABEL}.producao"
    plist = plist_of(tmp_path, label)
    assert plist["Label"] == label
    # Production cannot start it: launchd does, every few minutes; idle, it exits at once.
    assert plist["StartInterval"] == WAKE_EVERY_S
    assert plist["ProgramArguments"][-2:] == ["run", "--exit-when-idle"]
    assert plist["EnvironmentVariables"][PROFILE_ENV] == "producao"
    assert plist["EnvironmentVariables"]["KB_CHAT_VAULT"] == "/v"
    assert plist["StandardOutPath"].endswith("/service-producao.log")
    assert ["bootstrap", "gui/501", str(agent.plist_path)] in launchctl.calls
    # The first app's agent is not touched, and nothing of its own is taken out.
    assert not (tmp_path / "Library" / "LaunchAgents" / f"{LABEL}.plist").exists()
    assert not any(call[0] == "bootout" and call[1].endswith(LABEL) for call in launchctl.calls)


def test_each_app_keeps_its_token_apart(monkeypatch, production):
    seen = []

    class Done:
        returncode = 0
        stdout = "tok\n"
        stderr = ""

    def run(args, **kwargs):
        seen.append((args, kwargs.get("input")))
        return Done()

    monkeypatch.setattr(secret.subprocess, "run", run)
    monkeypatch.delenv("KB_CHAT_TRANSCRIBER_TOKEN_FILE", raising=False)
    secret.save_keychain(TOKEN)
    assert seen[0][1] == (
        "add-generic-password -U -s nova-alexandria-transcriber -a transcriber-producao "
        f"-w {TOKEN}\n"
    )
    assert secret.load_token() == "tok"
    assert seen[1][0][4:6] == ["-a", "transcriber-producao"]


def test_pairing_production_leaves_the_first_app_as_it_was(tmp_path, monkeypatch):
    monkeypatch.delenv(PROFILE_ENV, raising=False)
    first = tmp_path / "config.json"
    first.write_text(json.dumps({"api_url": "http://localhost:3000"}), encoding="utf-8")
    monkeypatch.setattr(cli, "CONFIG_FILE", first)
    monkeypatch.setattr(cli, "SYNC_STATE_FILE", tmp_path / "vault-sync.json")
    saved = []
    monkeypatch.setattr(cli, "save_keychain", saved.append)
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: TOKEN)
    url = "https://app.example"
    args = ["--profile", "producao", "pair", "--api-url", url, "--sync-host", "vm", "--no-service"]
    assert cli.main(args) == 0
    assert json.loads(first.read_text(encoding="utf-8")) == {"api_url": "http://localhost:3000"}
    other = json.loads((tmp_path / "config-producao.json").read_text(encoding="utf-8"))
    assert other["api_url"] == url
    assert other["sync_host"] == "vm"
    # The token never goes to a file.
    assert TOKEN not in json.dumps(other)
    assert saved == [TOKEN]
    # And its sync keeps its own account of what is pending.
    sync = cli.vault_sync_of(
        cli.argparse.Namespace(sync_host=None, no_sync=False, sync_script=None),
        other,
        type("Kb", (), {"vault": tmp_path})(),
    )
    assert sync.state_file == tmp_path / "vault-sync-producao.json"


@pytest.mark.parametrize("name", ["Producao", "../x", "a b", "x" * 31])
def test_a_profile_is_a_plain_name(name, capsys):
    assert cli.main(["--profile", name, "service", "status"]) == 2
    assert "must be lowercase" in capsys.readouterr().err
