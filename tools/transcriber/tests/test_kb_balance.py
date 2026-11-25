"""The balance kb spends from, as the masters are told: never a guess, never the key."""

import urllib.error

import pytest

from transcriber.kb_balance import KbBalance
from transcriber.status import WorkerStatus

ACCOUNT = {"data": {"total_credits": 20, "total_usage": 19.25}}


def answering(**answers):
    asked = []

    def ask(path):
        asked.append(path)
        answer = answers[path[1:]]
        if isinstance(answer, Exception):
            raise answer
        return answer

    return ask, asked


@pytest.mark.parametrize(
    ("credits", "key", "left"),
    [
        (ACCOUNT, {"data": {"limit_remaining": None}}, 0.75),
        (ACCOUNT, {"data": {"limit_remaining": 0.1}}, 0.1),
        (urllib.error.URLError("403"), {"data": {"limit_remaining": 3}}, 3),
        (urllib.error.URLError("down"), urllib.error.URLError("down"), None),
        ({"data": None}, {}, None),
        ([], {"data": {"limit_remaining": True and "x"}}, None),
    ],
)
def test_it_is_the_lowest_known_and_none_when_nothing_tells(credits, key, left):
    ask, _ = answering(credits=credits, key=key)
    assert KbBalance("k", ask).read() == left


def test_it_is_asked_now_and_then_and_never_without_a_key():
    ask, asked = answering(credits=ACCOUNT, key={})
    clock = [0.0]
    balance = KbBalance("k", ask, lambda: clock[0])
    assert [balance.read(), balance.read()] == [0.75, 0.75]
    assert asked == ["/credits", "/key"]
    clock[0] = 601
    balance.read()
    assert len(asked) == 4
    assert KbBalance(None).read() is None


def test_the_status_says_it_only_when_it_is_known():
    status = WorkerStatus()
    assert "kbBalanceUsd" not in status.snapshot()
    status.kb_balance = KbBalance("k", answering(credits=ACCOUNT, key={})[0]).read
    assert status.snapshot()["kbBalanceUsd"] == 0.75
