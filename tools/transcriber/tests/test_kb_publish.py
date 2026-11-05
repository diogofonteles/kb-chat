"""Track documents through kb (KBC-099): a fake kb, never the real binary nor a model."""

import fcntl
from pathlib import Path

import numpy as np
import pytest

from transcriber.api import ApiClient
from transcriber.kb_publish import (
    LOCK_FILE,
    KbCli,
    KbPublisher,
    KbRun,
    KbStepFailed,
    UnsafePath,
    VaultBusy,
    facets_of,
    kb_or_none,
)
from transcriber.worker import Worker

from .conftest import TOKEN, FakeModel

DOCUMENT = """---
title: O que é o ritmo?
kb_chat_media_id: 0b9c1f7e-1111-4a2b-8c3d-000000000001
kb_chat_fingerprint: {fingerprint}
---

# O que é o ritmo?

[0:41] O ritmo é a lei do pêndulo.
"""

JOB = {
    "id": "44444444-4444-4444-8444-444444444444",
    "leaseId": "55555555-5555-4555-8555-555555555555",
    "kind": "kb-publish",
    "topic": "hermetismo",
    "attempt": 1,
    "leaseMs": 60000,
    "budgetUsd": 0.5,
    "items": [
        {
            "op": "write",
            "path": "raw/media/rec/track-1.md",
            "markdown": DOCUMENT.format(fingerprint="a" * 64),
            "fingerprint": "a" * 64,
        },
        {
            "op": "write",
            "path": "raw/media/rec/track-2.md",
            "markdown": DOCUMENT.format(fingerprint="b" * 64),
            "fingerprint": "b" * 64,
        },
    ],
}


class FakeKb:
    """Records each step; `classify` writes facets into the documents, as kb would."""

    def __init__(self, vault: Path, fail: str | None = None, spend: float = 0.0004) -> None:
        self.vault = vault
        self.fail = fail
        self.spend = spend
        self.calls: list[tuple[str, str, float]] = []

    def run(self, step: str, topic: str, budget_usd: float) -> KbRun:
        self.calls.append((step, topic, budget_usd))
        if step == self.fail:
            return KbRun(ok=False, output="Error: OpenRouter 502 Bad Gateway", spend_usd=0.0001)
        if step == "classify":
            for file in (self.vault / topic / "raw" / "media").rglob("*.md"):
                text = file.read_text(encoding="utf-8")
                facets = 'genre: talk_or_interview\ndepth: 2\nconcepts:\n  - "[[Ritmo]]"\n'
                file.write_text(text.replace("---\n", f"---\n{facets}", 1), encoding="utf-8")
        return KbRun(ok=True, output=f"{step} ok", spend_usd=self.spend)


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    (tmp_path / "hermetismo" / "raw").mkdir(parents=True)
    return tmp_path


def test_ac3_writes_the_files_and_runs_classify_link_index_in_order_with_the_budget(vault):
    kb = FakeKb(vault)
    result = KbPublisher(vault, kb).publish(JOB)
    written = vault / "hermetismo" / "raw" / "media" / "rec" / "track-1.md"
    assert "[0:41] O ritmo é a lei do pêndulo." in written.read_text(encoding="utf-8")
    assert [(step, topic) for step, topic, _ in kb.calls] == [
        ("classify", "hermetismo"),
        ("link", "hermetismo"),
        ("index", "hermetismo"),
    ]
    budgets = [budget for _, _, budget in kb.calls]
    assert budgets == pytest.approx([0.5, 0.4996, 0.4992])
    assert [one["path"] for one in result["documents"]] == [
        "raw/media/rec/track-1.md",
        "raw/media/rec/track-2.md",
    ]
    first = result["documents"][0]
    assert first["ok"] is True
    assert first["facets"] == {"genre": "talk_or_interview", "depth": 2, "concepts": ["Ritmo"]}
    assert first["spendUsd"] == pytest.approx(0.0006)
    assert not (vault / LOCK_FILE).read_text()


def test_ac4_a_failing_classify_fails_with_kbs_output_and_the_file_stays(vault):
    kb = FakeKb(vault, fail="classify")
    with pytest.raises(KbStepFailed) as failed:
        KbPublisher(vault, kb).publish(JOB)
    assert failed.value.output == "kb classify: Error: OpenRouter 502 Bad Gateway"
    assert [step for step, _, _ in kb.calls] == ["classify"]
    assert (vault / "hermetismo" / "raw" / "media" / "rec" / "track-2.md").exists()


def test_a_second_publication_while_the_vault_is_locked_is_refused(vault):
    with open(vault / LOCK_FILE, "a+") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(VaultBusy):
            KbPublisher(vault, FakeKb(vault)).publish(JOB)


@pytest.mark.parametrize(
    "path", ["raw/media/../../../outside.md", "raw/articles/x.md", "/etc/x.md"]
)
def test_a_path_outside_the_collections_media_folder_is_refused(vault, path):
    job = {**JOB, "items": [{**JOB["items"][0], "path": path}]}
    with pytest.raises(UnsafePath):
        KbPublisher(vault, FakeKb(vault)).publish(job)
    assert not (vault.parent / "outside.md").exists()


def test_the_real_kb_commands_follow_adr_0035():
    cli = KbCli(Path("/vault"), "kb")
    assert cli.command("classify", "hermetismo", 0.5) == [
        "kb",
        "classify",
        "hermetismo",
        "--budget",
        "0.5000",
    ]
    assert cli.command("index", "hermetismo", 0.25) == [
        "kb",
        "index",
        "--topic",
        "hermetismo",
        "--budget",
        "0.2500",
    ]


def test_kb_is_off_without_a_vault(tmp_path):
    assert kb_or_none(None) is None
    assert kb_or_none(str(tmp_path / "missing")) is None


def test_facets_are_read_from_the_frontmatter():
    text = "---\ngenre: talk_or_interview\nrelevance: core\nsummary: Uma faixa.\n---\n\n# T\n"
    assert facets_of(text) == {
        "genre": "talk_or_interview",
        "relevance": "core",
        "summary": "Uma faixa.",
    }
    assert facets_of("# no frontmatter") == {}


def worker(api, publisher) -> Worker:
    return Worker(
        api=ApiClient(api.url, lambda: TOKEN, "mac-test"),
        model=FakeModel(),
        find_speech=lambda _: [(0.0, 9.0)],
        decode=lambda path: np.zeros(16000, dtype=np.float32),
        poll_s=0.01,
        error_backoff_s=0.01,
        publisher=publisher,
    )


def test_ac2_only_a_mac_with_a_vault_and_kb_asks_for_kb_publish(fake_api, vault):
    fake_api.jobs.clear()
    worker(fake_api, None).step()
    worker(fake_api, KbPublisher(vault, FakeKb(vault))).step()
    first, second = fake_api.bodies("lease")
    assert "kb-publish" not in first["kinds"]
    assert second["kinds"][-1] == "kb-publish"


def test_the_worker_publishes_a_leased_job_and_reports_each_document(fake_api, vault):
    fake_api.jobs[:] = [dict(JOB)]
    assert worker(fake_api, KbPublisher(vault, FakeKb(vault))).step() == "job"
    (result,) = fake_api.bodies("kb-result")
    assert result["leaseId"] == JOB["leaseId"]
    assert [one["ok"] for one in result["documents"]] == [True, True]
    assert fake_api.bodies("fail") == []


def test_ac4_the_worker_fails_the_job_with_kbs_output(fake_api, vault):
    fake_api.jobs[:] = [dict(JOB)]
    assert worker(fake_api, KbPublisher(vault, FakeKb(vault, fail="link"))).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["failure"] == "conversion-failed"
    assert failed["detail"] == "kb link: Error: OpenRouter 502 Bad Gateway"
    assert fake_api.bodies("kb-result") == []
