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


def test_keychain_token_comes_from_security(monkeypatch):
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
    secret.save_keychain("s3cret")
    assert "s3cret" not in seen["args"]
    assert seen["input"] == "s3cret\ns3cret\n"


def test_no_keychain_token_says_how_to_pair(monkeypatch):
    class Done:
        returncode = 44
        stdout = ""
        stderr = "not found"

    monkeypatch.setattr(secret.subprocess, "run", lambda *a, **k: Done())
    with pytest.raises(secret.TokenError, match="transcriber pair"):
        secret.read_keychain()
    with pytest.raises(secret.TokenError, match="refused"):
        secret.save_keychain("x")
