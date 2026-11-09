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
