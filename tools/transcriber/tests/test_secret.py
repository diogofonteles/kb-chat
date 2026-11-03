import shutil
import sys
import uuid

import pytest

from transcriber import secret


def test_reads_a_token_file_only_readable_by_its_owner(tmp_path, monkeypatch):
    file = tmp_path / "token"
    file.write_text("abc\n")
    file.chmod(0o600)
    monkeypatch.setenv("KB_CHAT_TRANSCRIBER_TOKEN_FILE", str(file))
    assert secret.load_token() == "abc"


def test_refuses_a_token_file_others_can_read(tmp_path):
    file = tmp_path / "token"
    file.write_text("abc")
    file.chmod(0o644)
    with pytest.raises(secret.TokenError, match="chmod 600"):
        secret.read_token_file(file)


def test_refuses_a_missing_or_empty_token_file(tmp_path):
    with pytest.raises(secret.TokenError, match="not found"):
        secret.read_token_file(tmp_path / "none")
    empty = tmp_path / "empty"
    empty.write_text("")
    empty.chmod(0o600)
    with pytest.raises(secret.TokenError, match="empty"):
        secret.read_token_file(empty)


TOKEN = "nat_" + "A1b2_C3d4-" * 4


def test_keychain_write_keeps_the_token_out_of_argv_and_off_the_terminal(monkeypatch):
    class Done:
        returncode = 0
        stdout = "tok\n"
        stderr = ""

    seen = {}

    def fake_run(args, **kwargs):
        seen["args"] = args
        seen["input"] = kwargs.get("input")
        return Done()

    monkeypatch.setattr(secret.subprocess, "run", fake_run)
    monkeypatch.delenv("KB_CHAT_TRANSCRIBER_TOKEN_FILE", raising=False)
    assert secret.load_token() == "tok"
    secret.save_keychain(TOKEN)
    assert seen["args"] == ["security", "-i"]
    assert seen["input"] == (
        f"add-generic-password -U -s nova-alexandria-transcriber -a transcriber -w {TOKEN}\n"
    )


def test_keychain_write_refuses_what_is_not_a_token(monkeypatch):
    monkeypatch.setattr(secret.subprocess, "run", lambda *a, **k: pytest.fail("ran security"))
    for bad in ("short", f"{TOKEN} -s other", f"{TOKEN}\nadd-generic-password"):
        with pytest.raises(secret.TokenError, match="não parece o token"):
            secret.save_keychain(bad)


def test_no_keychain_token_says_how_to_pair(monkeypatch):
    class Done:
        returncode = 44
        stdout = ""
        stderr = "not found"

    monkeypatch.setattr(secret.subprocess, "run", lambda *a, **k: Done())
    with pytest.raises(secret.TokenError, match="transcriber pair"):
        secret.read_keychain()
    with pytest.raises(secret.TokenError, match="refused"):
        secret.save_keychain(TOKEN)


def test_the_cached_token_is_read_once_and_again_after_forget():
    reads = iter(["first", "second"])
    token = secret.CachedToken(lambda: next(reads))
    assert token() == "first"
    assert token() == "first"
    token.forget()
    assert token() == "second"


@pytest.mark.skipif(
    sys.platform != "darwin" or shutil.which("security") is None,
    reason="the macOS Keychain exists only on a Mac",
)
def test_the_real_keychain_stores_and_returns_the_token():
    """The real `security` (no mock): a throwaway item, removed at the end."""
    service = f"kbc036-test-{uuid.uuid4().hex[:8]}"
    try:
        secret.save_keychain(TOKEN, service=service)
        assert secret.read_keychain(service=service) == TOKEN
        secret.save_keychain(TOKEN[::-1].replace("_", "x"), service=service)
        assert secret.read_keychain(service=service) == TOKEN[::-1].replace("_", "x")
    finally:
        secret.delete_keychain(service)
    with pytest.raises(secret.TokenError):
        secret.read_keychain(service=service)
