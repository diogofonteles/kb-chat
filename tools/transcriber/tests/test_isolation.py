"""No test touches this Mac's real transcriber: config, Keychain, launchctl (KBC-114 incident
of 2026-11-09, when a pairing test wrote the owner's config.json)."""

import subprocess
from pathlib import Path

import pytest

from transcriber import cli

from .conftest import REAL_CONFIG


def test_the_config_of_a_test_is_never_the_real_one(tmp_path):
    assert cli.CONFIG_FILE != REAL_CONFIG
    assert REAL_CONFIG.parent not in cli.CONFIG_FILE.parents
    cli.save_config({"api_url": "https://app.example"})
    assert cli.load_config() == {"api_url": "https://app.example"}
    assert Path.home() != Path(REAL_CONFIG.parents[3])


@pytest.mark.parametrize("program", ["security", "/bin/launchctl", "launchctl"])
def test_the_real_keychain_and_launchctl_are_out_of_reach(program):
    with pytest.raises(AssertionError, match="never in a test"):
        subprocess.run([program, "print"], check=False)


@pytest.mark.parametrize("program", ["security", "/bin/launchctl"])
def test_popen_and_check_output_are_barred_too(program):
    with pytest.raises(AssertionError, match="never in a test"):
        subprocess.Popen([program, "print"])
    with pytest.raises(AssertionError, match="never in a test"):
        subprocess.check_output([program, "print"])


def test_the_shell_of_whoever_runs_the_tests_leaks_nothing_in():
    import os

    leaked = [name for name in os.environ if name.startswith("KB_CHAT_")]
    assert leaked == []


def test_the_guard_watches_the_agent_plist_and_the_sync_state_too():
    from .conftest import REAL_FILES

    names = {path.name for path in REAL_FILES}
    assert names == {
        "config.json",
        "vault-sync.json",
        "br.com.nova-alexandria.transcriber.plist",
    }
