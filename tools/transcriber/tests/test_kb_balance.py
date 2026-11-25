"""The balance kb spends from, as the masters are told: never a guess, never the key."""

import http.client
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from transcriber import kb_balance
from transcriber.kb_balance import KbBalance, ask_with, lowest_of
from transcriber.status import WorkerStatus

ACCOUNT = {"data": {"total_credits": 20, "total_usage": 19.25}}


def answering(credits, key):
    asked = []

    def ask(path):
        asked.append(path)
        answer = {"/credits": credits, "/key": key}[path]
        if isinstance(answer, Exception):
            raise answer
        return answer

    return ask, asked


def balance_of(ask, key="k", now=lambda: 0.0):
    return KbBalance(lambda: key, lambda _key: ask, now)


def read(balance):
    balance.last()
    balance.wait()
    return balance.last()


@pytest.mark.parametrize(
    ("credits", "key", "left"),
    [
        (ACCOUNT, {"data": {"limit_remaining": None}}, 0.75),
        (ACCOUNT, {"data": {"limit_remaining": 0.1}}, 0.1),
        # A key that may not read the account.
        (urllib.error.URLError("403"), {"data": {"limit_remaining": 3}}, 3),
        (urllib.error.URLError("down"), urllib.error.URLError("down"), None),
        (http.client.IncompleteRead(b""), {}, None),
        ({"data": None}, {}, None),
        ([], {"data": {"limit_remaining": "x"}}, None),
    ],
)
def test_it_is_the_lowest_known_and_none_when_nothing_tells(credits, key, left):
    assert lowest_of(answering(credits, key)[0]) == left


def test_it_is_asked_now_and_then_and_never_without_a_key():
    ask, asked = answering(ACCOUNT, {})
    clock = [0.0]
    balance = balance_of(ask, now=lambda: clock[0])
    assert [read(balance), read(balance)] == [0.75, 0.75]
    assert asked == ["/credits", "/key"]
    clock[0] = 601
    read(balance)
    assert len(asked) == 4
    assert read(balance_of(ask, key=None)) is None
    assert len(asked) == 4


def test_who_asks_never_waits_for_the_network():
    go = threading.Event()

    def ask(_path):
        go.wait(5)
        return ACCOUNT

    balance = balance_of(ask)
    assert balance.last() is None
    go.set()
    balance.wait()
    assert balance.last() == 0.75


def test_the_key_never_follows_a_redirect(monkeypatch):
    seen = []

    class Other(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("Authorization"))
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/b")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Other)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(kb_balance, "API", f"http://127.0.0.1:{server.server_port}")
    with pytest.raises(urllib.error.HTTPError):
        ask_with("k")("/credits")
    server.shutdown()
    assert seen == ["Bearer k"]


def test_the_status_says_it_only_when_it_is_known():
    status = WorkerStatus()
    assert "kbBalanceUsd" not in status.snapshot()
    balance = balance_of(answering(ACCOUNT, {})[0])
    status.kb_balance = balance.last
    read(balance)
    assert status.snapshot()["kbBalanceUsd"] == 0.75
