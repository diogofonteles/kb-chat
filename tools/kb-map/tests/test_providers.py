"""Providers: kb's OpenRouter model by default, the subscription CLIs, the key and the budget."""

import io
import json
import subprocess
import urllib.error

import pytest

from kb_map.providers import (
    BudgetExceeded,
    Ledger,
    ProviderError,
    Request,
    build_provider,
    parse_json_object,
)
from kb_map.providers import keys as keys_module
from kb_map.providers.cli_agents import ClaudeCliProvider, CodexCliProvider
from kb_map.providers.fake import FakeProvider
from kb_map.providers.openrouter import OpenRouterProvider

FAKE_KEY = "test-only-placeholder-0123456789-ABCDEFGHIJ"
REQUEST = Request("sections", "system", "do it", {"blocks": [1, 2]}, max_tokens=100)


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_openrouter_is_built_from_kb_toml_with_its_fallback():
    config = {"generation": {"model": "deepseek/deepseek-v4-flash", "fallback_model": "x/y"}}
    provider = build_provider("openrouter", config)
    assert isinstance(provider, OpenRouterProvider)
    body = provider.body(REQUEST)
    assert body["model"] == "deepseek/deepseek-v4-flash"
    assert body["models"] == ["deepseek/deepseek-v4-flash", "x/y"]
    assert body["response_format"] == {"type": "json_object"}
    assert body["usage"] == {"include": True}
    # --model overrides kb.toml and drops its fallback.
    assert build_provider("openrouter", config, "a/b").body(REQUEST)["models"] == ["a/b"]


def test_openrouter_without_a_model_is_refused():
    with pytest.raises(ProviderError, match="no \\[generation\\] model"):
        build_provider("openrouter", {})


def test_openrouter_sends_the_key_only_in_the_header_and_reads_the_cost():
    seen = {}

    def opener(request, timeout):
        seen["auth"] = request.get_header("Authorization")
        seen["data"] = request.data.decode()
        seen["url"] = request.full_url
        answer = {
            "model": "deepseek/deepseek-v4-flash",
            "choices": [{"message": {"content": '{"ok": true}'}}],
            "usage": {"cost": 0.0012},
        }
        return _Response(json.dumps(answer).encode())

    provider = OpenRouterProvider("m", None, key=lambda: FAKE_KEY, opener=opener)
    reply = provider.ask(REQUEST)
    assert reply.usd == 0.0012
    assert reply.text == '{"ok": true}'
    assert seen["auth"] == f"Bearer {FAKE_KEY}"
    assert FAKE_KEY not in seen["data"]
    assert seen["url"] == "https://openrouter.ai/api/v1/chat/completions"


def test_an_openrouter_error_never_carries_the_key():
    def opener(request, timeout):
        body = io.BytesIO(json.dumps({"error": {"message": "Insufficient credits"}}).encode())
        raise urllib.error.HTTPError(request.full_url, 402, "Payment", {}, body)

    provider = OpenRouterProvider("m", None, key=lambda: FAKE_KEY, opener=opener)
    with pytest.raises(ProviderError) as err:
        provider.ask(REQUEST)
    assert "402" in str(err.value)
    assert "Insufficient credits" in str(err.value)
    assert FAKE_KEY not in str(err.value)


def test_the_key_comes_from_the_environment_first(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", FAKE_KEY)
    assert keys_module.openrouter_key() == FAKE_KEY


def test_the_key_comes_from_the_transcribers_keychain_item_never_in_argv(monkeypatch):
    calls = []

    def security(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=f"{FAKE_KEY}\n", stderr="")

    monkeypatch.setattr(keys_module.subprocess, "run", security)
    assert keys_module.openrouter_key() == FAKE_KEY
    assert calls == [
        [
            "security",
            "find-generic-password",
            "-s",
            "nova-alexandria-transcriber-kb",
            "-a",
            "OPENROUTER_API_KEY",
            "-w",
        ]
    ]


def test_no_key_anywhere_says_how_to_store_one(monkeypatch):
    def nothing(command, **kwargs):
        return subprocess.CompletedProcess(command, 44, stdout="", stderr="not found")

    monkeypatch.setattr(keys_module.subprocess, "run", nothing)
    with pytest.raises(keys_module.KeyMissing, match="transcriber keys set"):
        keys_module.openrouter_key()


def test_claude_gets_the_prompt_on_stdin_and_reports_its_cost():
    seen = {}

    def runner(command, **kwargs):
        seen["command"], seen["input"], seen["cwd"] = command, kwargs["input"], kwargs["cwd"]
        envelope = {"result": '{"sections": []}', "total_cost_usd": 0.02, "is_error": False}
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(envelope), stderr="")

    reply = ClaudeCliProvider(model="haiku", runner=runner).ask(REQUEST)
    assert reply.usd == 0.02
    assert seen["command"] == ["claude", "-p", "--output-format", "json", "--model", "haiku"]
    assert '"blocks"' in seen["input"]
    assert "kb-map-claude-" in seen["cwd"]


def test_codex_reads_its_last_message_and_costs_nothing_known():
    def runner(command, **kwargs):
        last = command[command.index("--output-last-message") + 1]
        with open(last, "w", encoding="utf-8") as out:
            out.write('{"ok": 1}')
        assert kwargs["input"].endswith("Answer with one JSON object only.")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    reply = CodexCliProvider(runner=runner).ask(REQUEST)
    assert parse_json_object(reply.text) == {"ok": 1}
    assert reply.usd == 0.0


def test_a_failing_cli_is_a_provider_error():
    def runner(command, **kwargs):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="usage limit reached")

    with pytest.raises(ProviderError, match="usage limit"):
        ClaudeCliProvider(runner=runner).ask(REQUEST)


def test_json_is_read_through_fences_and_prose():
    assert parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_object('Here it is: {"a": [1]} done') == {"a": [1]}
    with pytest.raises(ProviderError):
        parse_json_object("no json at all")
    with pytest.raises(ProviderError):
        parse_json_object("[1, 2]")


def test_the_budget_stops_before_a_call_it_cannot_afford():
    provider = FakeProvider({"sections": lambda r: {"ok": True}}, usd_per_call=0.4)
    ledger = Ledger(provider, max_usd=1.0)
    ledger.ask_json(REQUEST)
    ledger.ask_json(REQUEST)  # 0.8 spent; the projection of a third (0.6) passes 1.0
    with pytest.raises(BudgetExceeded, match=r"US\$ 0\.8000 spent of US\$ 1\.0000"):
        ledger.ask_json(REQUEST)
    assert len(provider.calls) == 2
    assert ledger.spent_usd == pytest.approx(0.8)


def test_a_zero_budget_makes_no_call_and_no_budget_has_no_ceiling():
    provider = FakeProvider({"sections": lambda r: {"ok": True}}, usd_per_call=0.0)
    with pytest.raises(BudgetExceeded):
        Ledger(provider, max_usd=0.0).ask_json(REQUEST)
    assert provider.calls == []
    assert Ledger(provider).ask_json(REQUEST) == {"ok": True}
