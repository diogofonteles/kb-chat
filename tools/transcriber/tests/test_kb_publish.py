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
    spend_of,
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

    def __init__(
        self,
        vault: Path,
        fail: str | None = None,
        spend: float = 0.0004,
        outputs: dict[str, str] | None = None,
    ) -> None:
        self.vault = vault
        self.fail = fail
        self.spend = spend
        self.outputs = outputs or {}
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
        spend = 0.0 if step == "index" else self.spend
        return KbRun(ok=True, output=self.outputs.get(step, f"{step} ok"), spend_usd=spend)


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    (tmp_path / "hermetismo" / "raw").mkdir(parents=True)
    # A folder kb made: kb-publish never scaffolds it again (KBC-114).
    (tmp_path / "hermetismo" / "topic.yaml").write_text("slug: hermetismo\n", encoding="utf-8")
    return tmp_path


def test_ac3_writes_the_files_and_runs_classify_link_index_in_order_with_the_budget(vault):
    kb = FakeKb(vault)
    result = KbPublisher(vault, kb).publish(JOB)
    written = vault / "hermetismo" / "raw" / "media" / "rec" / "track-1.md"
    assert "[0:41] O ritmo é a lei do pêndulo." in written.read_text(encoding="utf-8")
    # The spike (kb 0.0.12): index before link gives link its vector neighbours.
    assert [(step, topic) for step, topic, _ in kb.calls] == [
        ("classify", "hermetismo"),
        ("index", "hermetismo"),
        ("link", "hermetismo"),
        ("index", "hermetismo"),
    ]
    budgets = {step: budget for step, _, budget in kb.calls if step != "index"}
    assert budgets == pytest.approx({"classify": 0.5, "link": 0.4996})
    assert [one["path"] for one in result["documents"]] == [
        "raw/media/rec/track-1.md",
        "raw/media/rec/track-2.md",
    ]
    first = result["documents"][0]
    assert first["ok"] is True
    assert first["facets"] == {"genre": "talk_or_interview", "depth": 2, "concepts": ["Ritmo"]}
    assert first["spendUsd"] == pytest.approx(0.0004)
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
    "path",
    [
        "raw/media/../../../outside.md",
        "raw/articles/x.md",
        "/etc/x.md",
        "raw/media/../articles/x.md",
        "raw/media/rec/../../articles/x.md",
        "raw/media",
    ],
)
def test_a_path_outside_the_collections_media_folder_is_refused(vault, path):
    article = vault / "hermetismo" / "raw" / "articles" / "x.md"
    article.parent.mkdir(parents=True)
    article.write_text("o texto do acervo", encoding="utf-8")
    job = {**JOB, "items": [{**JOB["items"][0], "path": path}]}
    with pytest.raises(UnsafePath):
        KbPublisher(vault, FakeKb(vault)).publish(job)
    assert not (vault.parent / "outside.md").exists()
    assert article.read_text(encoding="utf-8") == "o texto do acervo"


@pytest.mark.parametrize(
    "topic", ["../outro", "a/../../b", "/etc", "Hermetismo", "", "a//b", "hermetismo\n"]
)
def test_a_topic_that_is_not_a_collection_slug_is_refused(vault, topic):
    kb = FakeKb(vault)
    with pytest.raises(UnsafePath):
        KbPublisher(vault, kb).publish({**JOB, "topic": topic})
    assert kb.calls == []
    assert not (vault.parent / "outro").exists()


def test_the_real_kb_commands_follow_adr_0035():
    cli = KbCli(Path("/vault"), "kb")
    assert cli.command("classify", "hermetismo", 0.5) == [
        "kb",
        "classify",
        "hermetismo",
        "--budget",
        "0.5000",
    ]
    assert cli.command("link", "hermetismo", 0.25) == [
        "kb",
        "link",
        "hermetismo",
        "--budget",
        "0.2500",
    ]
    # kb 0.0.12: `kb index --topic t --budget x` exits 1 ("unknown flag: --budget").
    assert cli.command("index", "hermetismo", 0.25) == ["kb", "index", "--topic", "hermetismo"]


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


# What kb 0.0.12 printed in the owner's spike (2026-11-06), cut to the receipt lines.
CLASSIFY_SPENT = """classify: 56 documents, 3 judged, skipped (stub 39, unchanged 14)
written: concepts 3, depth 3, entities 3, genre 3, questions 3, relevance 3, summary 3
decisions: 6 calls, 0 cache hits, US$ 0.0014
generation: 3 calls, 0 cache hits, US$ 0.0002, 0 fallbacks, 0 failures
"""
TINY_BUDGET = """classify: 56 documents, 1 judged, skipped (stub 39, unchanged 16)
coverage: 0/1 judged documents fully decided
undecided documents (1, left unclassified): raw/media/rec/track-2.md
writes: unchanged 1
undecided: 1 (literals:budget 1); nothing was written for them, re-run to retry
decisions: 2 calls, 0 cache hits, US$ 0.0005
classify: 17 decided (apply 5, review 0, ignore 12)
budget: US$ 0.0003 limit reached; re-run to resume through the cache
"""
NOTHING_TO_DO = """classify: 56 documents, 0 judged, skipped (stub 39, unchanged 17)
coverage: 0/0 judged documents fully decided
decisions: 0 calls, 0 cache hits, US$ 0.0000
budget: US$ 0.0000 limit reached; re-run to resume through the cache
"""
LINK_UNDECIDED = """link: 56 documents, 3 judged, body links shadow
undecided: 2
decisions: 3 calls, 0 cache hits, US$ 0.0010
"""
KB_FRONTMATTER = """concepts:
    - '[[Hermetismo e Filosofia Hermética]]'
depth: 1.4
entities:
    - Lei do Ritmo
genre: talk_or_interview
questions:
    - O que é a Lei do Ritmo?
relevance: core
summary: Explica o quinto princípio hermético, a Lei do Ritmo.
example_of:
    - '[[Hermetismo e Filosofia Hermética]]'
"""


@pytest.mark.parametrize(
    ("output", "spent"),
    [(CLASSIFY_SPENT, 0.0016), (TINY_BUDGET, 0.0005), (NOTHING_TO_DO, 0.0), ("index ok", 0.0)],
)
def test_the_spend_is_the_receipt_lines_never_the_budget_line(output, spent):
    assert spend_of(output) == pytest.approx(spent)


def test_facets_read_kbs_own_list_indent_and_numbers():
    text = f"---\ntitle: T\nkb_chat_render: 1\n{KB_FRONTMATTER}---\n\n# T\n"
    assert facets_of(text) == {
        "concepts": ["Hermetismo e Filosofia Hermética"],
        "depth": 1.4,
        "genre": "talk_or_interview",
        "relevance": "core",
        "summary": "Explica o quinto princípio hermético, a Lei do Ritmo.",
    }


def test_a_document_kb_left_undecided_is_reported_incomplete_with_the_spend(vault):
    kb = FakeKb(vault, outputs={"classify": TINY_BUDGET})
    result = KbPublisher(vault, kb).publish(JOB)
    first, second = result["documents"]
    assert first["ok"] is True
    assert second["ok"] is False
    assert second["error"] == "kb left it undecided (budget reached): re-run"
    assert second["spendUsd"] == pytest.approx(0.0004)


def test_a_step_with_undecided_documents_it_does_not_name_leaves_every_document_incomplete(
    vault,
):
    kb = FakeKb(vault, outputs={"link": LINK_UNDECIDED})
    result = KbPublisher(vault, kb).publish(JOB)
    assert [one["ok"] for one in result["documents"]] == [False, False]


def test_a_budget_line_alone_is_not_incomplete(vault):
    kb = FakeKb(vault, outputs={"classify": NOTHING_TO_DO, "link": NOTHING_TO_DO})
    result = KbPublisher(vault, kb).publish(JOB)
    assert [one["ok"] for one in result["documents"]] == [True, True]


def test_a_failed_step_keeps_what_the_steps_before_it_spent(vault):
    kb = FakeKb(vault, fail="link")
    with pytest.raises(KbStepFailed) as failed:
        KbPublisher(vault, kb).publish(JOB)
    # classify 0.0004, index 0, link failed after spending 0.0001.
    assert failed.value.spent == pytest.approx(0.0005)


def test_ac4_the_worker_reports_the_spend_of_a_failed_job(fake_api, vault):
    fake_api.jobs[:] = [dict(JOB)]
    assert worker(fake_api, KbPublisher(vault, FakeKb(vault, fail="link"))).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["spendUsd"] == pytest.approx(0.0005)


def test_a_failed_job_that_went_past_its_budget_reports_the_budget(fake_api, vault):
    """kb may pass `--budget` by one call (spike): the API refuses more than the budget."""
    fake_api.jobs[:] = [dict(JOB, budgetUsd=0.0003)]
    assert worker(fake_api, KbPublisher(vault, FakeKb(vault, fail="link"))).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["spendUsd"] == pytest.approx(0.0003)


def test_a_failure_before_any_spend_sends_no_spend(fake_api, vault):
    fake_api.jobs[:] = [dict(JOB)]
    kb = FakeKb(vault, fail="classify", spend=0.0)
    publisher = KbPublisher(vault, kb)
    kb.run = lambda step, topic, budget: KbRun(ok=False, output="boom")  # type: ignore[method-assign]
    assert worker(fake_api, publisher).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert "spendUsd" not in failed


def test_rewriting_a_document_keeps_the_keys_kb_wrote(vault):
    target = vault / "hermetismo" / "raw" / "media" / "rec" / "track-1.md"
    target.parent.mkdir(parents=True)
    old = DOCUMENT.format(fingerprint="0" * 64).replace(
        "kb_chat_fingerprint", "kb_chat_subjects:\n  - Ritmo\nkb_chat_fingerprint", 1
    )
    old = old.replace("title: O que é o ritmo?", "title: Título antigo", 1)
    old = old.replace("\n---\n\n#", f"\n{KB_FRONTMATTER}---\n\n#", 1)
    target.write_text(old, encoding="utf-8")
    item = JOB["items"][0]
    KbPublisher(vault, FakeKb(vault)).write("hermetismo", [item])
    text = target.read_text(encoding="utf-8")
    header = text.split("\n---\n", 1)[0]
    assert header.startswith(item["markdown"].split("\n---\n", 1)[0])
    assert header.endswith(KB_FRONTMATTER.rstrip("\n"))
    assert "Título antigo" not in text
    assert "kb_chat_subjects" not in text
    assert text.endswith(item["markdown"].split("\n---\n", 1)[1])


def test_a_new_document_is_written_as_rendered(vault):
    KbPublisher(vault, FakeKb(vault)).write("hermetismo", [JOB["items"][0]])
    target = vault / "hermetismo" / "raw" / "media" / "rec" / "track-1.md"
    assert target.read_text(encoding="utf-8") == JOB["items"][0]["markdown"]


def test_a_mac_whose_vault_is_busy_does_not_ask_for_kb_publish(fake_api, vault):
    fake_api.jobs.clear()
    publisher = KbPublisher(vault, FakeKb(vault))
    with open(vault / LOCK_FILE, "a+") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        assert publisher.busy() is True
        worker(fake_api, publisher).step()
    assert publisher.busy() is False
    worker(fake_api, publisher).step()
    busy, free = fake_api.bodies("lease")
    assert "kb-publish" not in busy["kinds"]
    assert free["kinds"][-1] == "kb-publish"


REMOVE_JOB = {
    **JOB,
    "items": [
        JOB["items"][0],
        {"op": "remove", "path": "raw/media/rec/track-2.md"},
        {"op": "remove", "path": "raw/media/rec/never-written.md"},
    ],
}


def test_kbc100_a_remove_deletes_the_file_and_kb_runs_so_the_index_drops_it(vault):
    publisher = KbPublisher(vault, FakeKb(vault))
    publisher.publish(JOB)
    kb = FakeKb(vault)
    result = KbPublisher(vault, kb).publish(REMOVE_JOB)
    media = vault / "hermetismo" / "raw" / "media" / "rec"
    assert (media / "track-1.md").exists()
    assert not (media / "track-2.md").exists()
    assert [step for step, _, _ in kb.calls] == ["classify", "index", "link", "index"]
    by_path = {one["path"]: one for one in result["documents"]}
    # A file already gone is not an error: the removal is what was asked.
    assert by_path["raw/media/rec/never-written.md"] == {
        "path": "raw/media/rec/never-written.md",
        "ok": True,
        "spendUsd": 0.0,
    }
    assert by_path["raw/media/rec/track-2.md"]["ok"] is True
    # kb's spend goes to what it judged: the written document.
    assert by_path["raw/media/rec/track-1.md"]["spendUsd"] == pytest.approx(0.0008)


def test_kbc100_removing_the_last_document_of_a_recording_removes_its_folder(vault):
    KbPublisher(vault, FakeKb(vault)).publish(JOB)
    gone = {
        **JOB,
        "items": [{"op": "remove", "path": item["path"]} for item in JOB["items"]],
    }
    result = KbPublisher(vault, FakeKb(vault)).publish(gone)
    assert not (vault / "hermetismo" / "raw" / "media" / "rec").exists()
    assert [one["ok"] for one in result["documents"]] == [True, True]


def test_kbc100_a_remove_outside_the_media_folder_is_refused(vault):
    (vault / "hermetismo" / "raw" / "articles").mkdir(parents=True)
    keep = vault / "hermetismo" / "raw" / "articles" / "a.md"
    keep.write_text("texto", encoding="utf-8")
    job = {**JOB, "items": [{"op": "remove", "path": "raw/media/../articles/a.md"}]}
    with pytest.raises(UnsafePath):
        KbPublisher(vault, FakeKb(vault)).publish(job)
    assert keep.exists()
