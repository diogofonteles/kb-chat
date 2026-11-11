"""The kb's AI keys under launchd (KBC-117 (1)): the transcriber reads them from the Keychain
itself and hands them to kb only. Fakes stand for `security`; the isolation guard stays on."""

import argparse
import logging
from pathlib import Path

import numpy as np
import pytest

from transcriber import cli, kb_keys
from transcriber.api import ApiClient
from transcriber.kb_keys import (
    KB_KEY_NAMES,
    KB_KEYS_SERVICE,
    KEY_MISSING,
    KbKeyError,
    KeychainKeys,
    is_configuration_error,
    kb_env,
    kb_problems,
)
from transcriber.kb_publish import KbCli, KbPublisher, KbRun
from transcriber.worker import Worker

from .conftest import TOKEN, FakeModel
from .test_kb_publish import JOB as KB_JOB
from .test_kb_publish import FakeKb

KEY = "sk-or-v1-" + "0123456789abcdef" * 4
OTHER = "sk-ant-api03-" + "Zz9_" * 10
# What kb 0.0.12 printed under launchd on the owner's Mac (2026-11-09).
KB_NO_KEY = (
    "decisions: OPENROUTER_API_KEY is not set; the decision model is required "
    "([decisions] + [openrouter])"
)


class FakeKeys:
    """The Keychain as a dict: what `keys set` stored, by variable name."""

    def __init__(self, stored: dict[str, str] | None = None) -> None:
        self.stored = dict(stored or {})

    def read(self, name: str) -> str | None:
        return self.stored.get(name)

    def save(self, name: str, value: str) -> None:
        self.stored[name] = value

    def delete(self, name: str) -> bool:
        return self.stored.pop(name, None) is not None


# ---------- the store ----------


def test_the_keychain_write_keeps_the_key_out_of_argv(monkeypatch):
    seen: dict = {}

    class Done:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(args, **kwargs):
        seen["args"] = args
        seen["input"] = kwargs.get("input")
        return Done()

    monkeypatch.setattr(kb_keys.subprocess, "run", fake_run)
    KeychainKeys().save("OPENROUTER_API_KEY", KEY)
    assert seen["args"] == ["security", "-i"]
    assert KEY not in " ".join(seen["args"])
    assert seen["input"] == (
        f"add-generic-password -U -s {KB_KEYS_SERVICE} -a OPENROUTER_API_KEY -w {KEY}\n"
    )


def test_the_keychain_read_asks_its_own_service_and_account(monkeypatch):
    seen: dict = {}

    class Done:
        returncode = 0
        stdout = f"{KEY}\n"
        stderr = ""

    def fake_run(args, **kwargs):
        seen["args"] = args
        return Done()

    monkeypatch.setattr(kb_keys.subprocess, "run", fake_run)
    assert KeychainKeys().read("OPENROUTER_API_KEY") == KEY
    assert seen["args"] == [
        "security",
        "find-generic-password",
        "-s",
        KB_KEYS_SERVICE,
        "-a",
        "OPENROUTER_API_KEY",
        "-w",
    ]


def test_a_missing_keychain_item_is_none(monkeypatch):
    class Missing:
        returncode = 44
        stdout = ""
        stderr = "The specified item could not be found in the keychain."

    monkeypatch.setattr(kb_keys.subprocess, "run", lambda *a, **k: Missing())
    assert KeychainKeys().read("OPENROUTER_API_KEY") is None


@pytest.mark.parametrize(
    "value", ["", "short", "has space " + "x" * 20, "x" * 20 + "\nadd-generic-password", '"q"' * 9]
)
def test_a_value_that_could_break_the_security_line_is_refused(value):
    with pytest.raises(KbKeyError):
        KeychainKeys().save("OPENROUTER_API_KEY", value)


def test_only_the_kb_key_names_are_stored():
    with pytest.raises(KbKeyError):
        KeychainKeys().save("PATH", KEY)


# ---------- what kb gets ----------


def test_kb_env_takes_the_keychain_and_lets_the_shell_win():
    keys = FakeKeys({"OPENROUTER_API_KEY": KEY, "OPENAI_API_KEY": "sk-" + "o" * 30})
    assert kb_env(keys, environ={}) == {
        "OPENROUTER_API_KEY": KEY,
        "OPENAI_API_KEY": "sk-" + "o" * 30,
    }
    # The workaround that exports them in the plist keeps working during the move.
    assert kb_env(keys, environ={"OPENROUTER_API_KEY": OTHER})["OPENROUTER_API_KEY"] == OTHER
    assert kb_env(FakeKeys(), environ={"HOME": "/x"}) == {}


def test_kb_problems_say_the_key_or_kb_is_missing():
    assert kb_problems(vault="/v", publisher=object(), env={"OPENROUTER_API_KEY": KEY}) == []
    assert kb_problems(vault="/v", publisher=object(), env={}) == [
        {"kind": "kb-publish", "reason": "kb-ai-key-missing", "detail": KEY_MISSING}
    ]
    missing_kb = kb_problems(vault="/v", publisher=None, env={"OPENROUTER_API_KEY": KEY})
    assert [one["reason"] for one in missing_kb] == ["kb-missing"]
    # No vault: this Mac does not publish, nothing is missing.
    assert kb_problems(vault=None, publisher=None, env={}) == []
    assert KEY_MISSING.startswith("chave da IA do kb ausente")


def test_kbs_configuration_errors_are_told_apart_from_its_failures():
    assert is_configuration_error(f"kb classify: {KB_NO_KEY}")
    assert is_configuration_error("openrouter transcribe: missing API key; set openrouter.api_key")
    assert not is_configuration_error("kb link: Error: OpenRouter 502 Bad Gateway")


def test_the_kb_subprocess_gets_the_keys_and_the_worker_process_does_not(tmp_path, monkeypatch):
    seen: dict = {}

    class Done:
        returncode = 0
        stdout = "ok"
        stderr = ""

    def fake_run(args, **kwargs):
        seen["env"] = kwargs.get("env")
        return Done()

    monkeypatch.setattr("transcriber.kb_publish.subprocess.run", fake_run)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    KbCli(tmp_path, "/bin/kb", env={"OPENROUTER_API_KEY": KEY}).run("classify", "t", 0.1)
    assert seen["env"]["OPENROUTER_API_KEY"] == KEY
    assert seen["env"]["PATH"]
    import os

    assert "OPENROUTER_API_KEY" not in os.environ


# ---------- the worker ----------


def worker(api, publisher, unavailable=None) -> Worker:
    return Worker(
        api=ApiClient(api.url, lambda: TOKEN, "mac-test"),
        model=FakeModel(),
        find_speech=lambda _: [(0.0, 9.0)],
        decode=lambda path: np.zeros(16000, dtype=np.float32),
        poll_s=0.01,
        error_backoff_s=0.01,
        publisher=publisher,
        unavailable=unavailable or [],
    )


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    folder = tmp_path / "vault"
    (folder / "hermetismo").mkdir(parents=True)
    (folder / "hermetismo" / "topic.yaml").write_text("slug: hermetismo\n", encoding="utf-8")
    return folder


def test_without_the_key_the_mac_never_asks_for_kb_publish_and_says_why(fake_api, vault):
    fake_api.jobs.clear()
    problem = {"kind": "kb-publish", "reason": "kb-ai-key-missing", "detail": KEY_MISSING}
    mac = worker(fake_api, KbPublisher(vault, FakeKb(vault)), [problem])
    assert "kb-publish" not in mac.kinds
    mac.step()
    (lease,) = fake_api.bodies("lease")
    assert "kb-publish" not in lease["kinds"]
    snapshot = mac.status.snapshot()
    assert snapshot["unavailable"] == [problem]


class NoKeyKb(FakeKb):
    def run(self, step: str, topic: str, budget_usd: float) -> KbRun:
        self.calls.append((step, topic, budget_usd))
        return KbRun(ok=False, output=KB_NO_KEY, spend_usd=0.0)


def test_kb_without_its_key_fails_the_job_as_not_configured_and_stops_asking(
    fake_api, vault, caplog
):
    fake_api.jobs[:] = [dict(KB_JOB)]
    mac = worker(fake_api, KbPublisher(vault, NoKeyKb(vault)))
    with caplog.at_level(logging.INFO, logger="transcriber"):
        assert mac.step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["failure"] == "not-configured"
    assert failed["detail"].startswith(KEY_MISSING)
    assert "kb-publish" not in mac.kinds
    assert [one["reason"] for one in mac.status.snapshot()["unavailable"]] == ["kb-ai-key-missing"]
    mac.step()
    assert "kb-publish" not in fake_api.bodies("lease")[-1]["kinds"]


def test_an_older_api_that_refuses_not_configured_gets_conversion_failed(fake_api, vault):
    fake_api.jobs[:] = [dict(KB_JOB)]
    refusals = {"left": 1}
    answer = fake_api.answer

    def older(handler, method):
        if handler.path.endswith("/fail") and refusals["left"]:
            refusals["left"] -= 1
            length = int(handler.headers.get("content-length") or 0)
            handler.rfile.read(length)
            return fake_api._send(handler, 400, b'{"error":{"code":"VALIDATION_FAILED"}}')
        return answer(handler, method)

    fake_api.answer = older
    assert worker(fake_api, KbPublisher(vault, NoKeyKb(vault))).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["failure"] == "conversion-failed"


# ---------- the CLI ----------


def keys_cli(monkeypatch, keys: FakeKeys, wakes: list | None = None):
    monkeypatch.setattr(cli, "keys_of", lambda: keys)

    class Agent:
        def kickstart(self) -> bool:
            if wakes is not None:
                wakes.append(True)
            return True

    monkeypatch.setattr(cli, "service_of", lambda **kwargs: Agent())


def test_keys_set_from_env_stores_what_the_shell_has_and_never_prints_it(
    monkeypatch, capsys, caplog
):
    keys = FakeKeys()
    wakes: list = []
    keys_cli(monkeypatch, keys, wakes)
    monkeypatch.setenv("OPENROUTER_API_KEY", KEY)
    monkeypatch.setenv("ANTHROPIC_API_KEY", OTHER)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with caplog.at_level(logging.DEBUG):
        assert cli.main(["keys", "set", "--from-env"]) == 0
    assert keys.stored == {"OPENROUTER_API_KEY": KEY, "ANTHROPIC_API_KEY": OTHER}
    out = capsys.readouterr()
    for secret in (KEY, OTHER):
        assert secret not in out.out + out.err + caplog.text
    assert "OPENROUTER_API_KEY: guardada" in out.out
    # The service is asked to start: it reports kb-publish ready and the queue moves.
    assert wakes == [True]


def test_keys_set_asks_each_key_without_echo(monkeypatch, capsys):
    keys = FakeKeys()
    keys_cli(monkeypatch, keys)
    prompts: list[str] = []
    answers = {"OPENROUTER_API_KEY": KEY}

    def no_echo(prompt: str) -> str:
        prompts.append(prompt)
        return next((v for k, v in answers.items() if k in prompt), "")

    monkeypatch.setattr(cli.getpass, "getpass", no_echo)
    assert cli.main(["keys", "set"]) == 0
    assert len(prompts) == len(KB_KEY_NAMES)
    assert keys.stored == {"OPENROUTER_API_KEY": KEY}
    assert KEY not in capsys.readouterr().out


def test_keys_set_from_an_empty_shell_says_so(monkeypatch, capsys):
    keys_cli(monkeypatch, FakeKeys())
    for name in KB_KEY_NAMES:
        monkeypatch.delenv(name, raising=False)
    assert cli.main(["keys", "set", "--from-env"]) == 1
    assert "Nenhuma chave neste shell" in capsys.readouterr().err


def test_keys_status_names_where_each_key_is_never_its_value(monkeypatch, capsys):
    keys_cli(monkeypatch, FakeKeys({"OPENROUTER_API_KEY": KEY}))
    monkeypatch.setenv("ANTHROPIC_API_KEY", OTHER)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert cli.main(["keys", "status"]) == 0
    out = capsys.readouterr().out
    assert "OPENROUTER_API_KEY: no Keychain" in out
    assert "ANTHROPIC_API_KEY: só no shell" in out
    assert "OPENAI_API_KEY: ausente" in out
    assert KEY not in out and OTHER not in out


def test_keys_delete_takes_them_out(monkeypatch):
    keys = FakeKeys({"OPENROUTER_API_KEY": KEY})
    keys_cli(monkeypatch, keys)
    assert cli.main(["keys", "delete"]) == 0
    assert keys.stored == {}


class Installer:
    def install(self, vault, extras, load=True):
        return Path("/Users/o/Library/LaunchAgents/x.plist")

    def status(self) -> dict:
        return {
            "installed": True,
            "loaded": True,
            "running": False,
            "pid": None,
            "lastExit": None,
            "log": "/l",
        }


def test_service_install_with_the_key_only_in_the_shell_works_and_says_how_to_move(
    monkeypatch, capsys
):
    """An owner with the keys only in ~/.zshrc (KBC-117): install still works, once."""
    monkeypatch.setattr(cli, "keys_of", FakeKeys)
    monkeypatch.setattr(cli, "service_of", lambda **kwargs: Installer())
    monkeypatch.setenv("OPENROUTER_API_KEY", KEY)
    assert cli.main(["service", "install", "--no-load", "--vault", "/Users/o/vault"]) == 0
    out = capsys.readouterr().out
    assert "transcriber keys set --from-env" in out
    assert KEY not in out


def test_service_install_with_the_key_in_the_keychain_says_nothing_of_it(monkeypatch, capsys):
    monkeypatch.setattr(cli, "keys_of", lambda: FakeKeys({"OPENROUTER_API_KEY": KEY}))
    monkeypatch.setattr(cli, "service_of", lambda **kwargs: Installer())
    assert cli.main(["service", "install", "--no-load", "--vault", "/Users/o/vault"]) == 0
    assert "keys set" not in capsys.readouterr().out


def test_run_hands_the_keychain_keys_to_kb_and_reports_a_missing_one(monkeypatch, tmp_path):
    """`publisher_of` builds kb with the keys; without OPENROUTER_API_KEY it is unavailable."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "kb").write_text("#!/bin/sh\necho '0.0.12 (fake)'\n", encoding="utf-8")
    (bin_dir / "kb").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    for name in KB_KEY_NAMES:
        monkeypatch.delenv(name, raising=False)
    vault = tmp_path / "vault"
    vault.mkdir()
    args = argparse.Namespace(no_kb_publish=False)
    env = kb_env(FakeKeys({"OPENROUTER_API_KEY": KEY}))
    publisher = cli.publisher_of(args, str(vault), env)
    assert publisher is not None
    assert publisher.kb.env == {"OPENROUTER_API_KEY": KEY}
    assert kb_problems(str(vault), publisher, env) == []
    assert kb_problems(str(vault), publisher, kb_env(FakeKeys()))[0]["reason"] == (
        "kb-ai-key-missing"
    )


# ---------- review r1 ----------


def test_review_r1_a_key_stored_while_the_worker_runs_is_picked_up_without_a_restart(
    fake_api, vault
):
    """`keys set` while a long job runs: kickstart does nothing, so the worker looks again."""
    fake_api.jobs.clear()
    stored: dict[str, str] = {}
    problem = {"kind": "kb-publish", "reason": "kb-ai-key-missing", "detail": KEY_MISSING}
    kb = KbCli(vault, "/bin/kb")
    mac = worker(fake_api, KbPublisher(vault, kb), [problem])
    mac.reload_kb_env = lambda: kb_env(FakeKeys(stored), environ={})
    mac.key_recheck_s = 0.0
    mac.step()
    assert "kb-publish" not in fake_api.bodies("lease")[-1]["kinds"]
    stored["OPENROUTER_API_KEY"] = KEY
    mac.step()
    assert "kb-publish" in fake_api.bodies("lease")[-1]["kinds"]
    assert kb.env == {"OPENROUTER_API_KEY": KEY}
    assert "unavailable" not in mac.status.snapshot()


def test_review_r1_the_keychain_is_not_asked_on_every_lease(fake_api, vault):
    fake_api.jobs.clear()
    asked: list[bool] = []
    problem = {"kind": "kb-publish", "reason": "kb-ai-key-missing", "detail": KEY_MISSING}
    mac = worker(fake_api, KbPublisher(vault, FakeKb(vault)), [problem])
    mac.reload_kb_env = lambda: asked.append(True) or {}
    mac.step()
    mac.step()
    assert len(asked) == 1


def test_review_r1_a_keychain_error_never_echoes_the_key(monkeypatch):
    class Refused:
        returncode = 1
        stdout = ""
        stderr = f"security: parse error near {KEY}"

    monkeypatch.setattr(kb_keys.subprocess, "run", lambda *a, **k: Refused())
    with pytest.raises(KbKeyError) as refused:
        KeychainKeys().save("OPENROUTER_API_KEY", KEY)
    assert KEY not in str(refused.value)


def test_review_r1_only_kb_key_names_are_accepted_by_the_cli(monkeypatch):
    keys_cli(monkeypatch, FakeKeys())
    with pytest.raises(SystemExit):
        cli.main(["keys", "set", "--from-env", "--name", "PATH"])


def test_review_r1_delete_says_when_there_was_nothing(monkeypatch, capsys):
    keys_cli(monkeypatch, FakeKeys({"OPENROUTER_API_KEY": KEY}))
    assert cli.main(["keys", "delete"]) == 0
    out = capsys.readouterr().out
    assert "OPENROUTER_API_KEY: removida do Keychain" in out
    assert "OPENAI_API_KEY: não estava no Keychain" in out


# ---------- review r2 ----------


def test_review_r2_a_setup_error_with_the_key_present_does_not_loop(fake_api, vault):
    """kb says "model is required" with OPENROUTER_API_KEY there: the run stops asking for
    kb-publish, and only a key that changes in the Keychain opens it again."""
    stored = {"OPENROUTER_API_KEY": KEY}
    kb = NoKeyKb(vault)
    kb.env = dict(stored)
    fake_api.jobs[:] = [dict(KB_JOB)]
    mac = worker(fake_api, KbPublisher(vault, kb))
    mac.reload_kb_env = lambda: kb_env(FakeKeys(stored), environ={})
    mac.key_recheck_s = 0.0
    assert mac.step() == "job"
    assert fake_api.bodies("fail")[-1]["failure"] == "not-configured"
    mac.step()
    mac.step()
    assert "kb-publish" not in fake_api.bodies("lease")[-1]["kinds"]
    stored["OPENROUTER_API_KEY"] = OTHER + "-new"
    mac.step()
    assert "kb-publish" in fake_api.bodies("lease")[-1]["kinds"]


def test_review_r2_keys_set_with_one_bad_value_stores_none(monkeypatch, capsys):
    keys = FakeKeys()
    wakes: list = []
    keys_cli(monkeypatch, keys, wakes)
    monkeypatch.setenv("OPENROUTER_API_KEY", KEY)
    monkeypatch.setenv("OPENAI_API_KEY", "short")
    assert cli.main(["keys", "set", "--from-env"]) == 1
    assert keys.stored == {}
    assert wakes == []
    out = capsys.readouterr()
    assert KEY not in out.out + out.err
    assert "short" not in out.out + out.err
