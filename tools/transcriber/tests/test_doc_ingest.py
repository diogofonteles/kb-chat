"""Documents and links sent from the app (KBC-149): a fake kb-map, kb and yt-dlp."""

from pathlib import Path

import numpy as np
import pytest

from transcriber.api import ApiClient
from transcriber.doc_ingest import DocIngester, DocIngestFailed, failure_of, title_of
from transcriber.kb_publish import KbPublisher, KbRun
from transcriber.worker import Worker

from .conftest import MEDIA_ID, TOKEN, FakeModel
from .test_kb_publish import FakeKb

FILE_JOB = {
    "id": "77777777-7777-4777-8777-777777777777",
    "leaseId": "88888888-8888-4888-8888-888888888888",
    "kind": "doc-ingest",
    "topic": "hermetismo",
    "attempt": 1,
    "leaseMs": 600000,
    "budgetUsd": 0.5,
    "source": {
        "kind": "file",
        "name": "O Caibalion.pdf",
        "bytes": 13,
        "sha256": "a" * 64,
        "filePath": "/api/v1/media-worker/jobs/77777777-7777-4777-8777-777777777777/document",
    },
}
URL_JOB = {**FILE_JOB, "source": {"kind": "url", "url": "https://example.org/artigo"}}
YOUTUBE_JOB = {
    **FILE_JOB,
    "source": {
        "kind": "youtube",
        "url": "https://youtu.be/abc",
        "audioPath": "/api/v1/media-worker/jobs/77777777-7777-4777-8777-777777777777/youtube-audio",
    },
}


class FakeKbMap:
    """`kb-map convert` as it answers: writes the document kb would, prints one outcome."""

    def __init__(self, vault: Path, outcome: dict | None = None) -> None:
        self.vault = vault
        self.outcome = outcome
        self.converted: list[dict] = []
        self.mapped: list[tuple[str, str, float]] = []

    def convert(self, topic, source, *, name, source_path, budget_usd):
        self.converted.append(
            {
                "topic": topic,
                "source": source,
                "name": name,
                "source_path": source_path,
                "bytes": Path(source).read_bytes() if Path(source).is_file() else None,
                "budget": budget_usd,
            }
        )
        if self.outcome is not None:
            return self.outcome
        doc = "raw/articles/o-caibalion.md"
        path = self.vault / topic / doc
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("---\ntitle: O Caibalion\noriginal_sha256: x\n---\n# O Caibalion\n")
        return {"state": "converted", "source": source, "document": doc}

    def map_document(self, topic, doc_id, budget_usd):
        self.mapped.append((topic, doc_id, budget_usd))
        return "written"


class FakeYoutube:
    def __init__(self) -> None:
        self.urls: list[str] = []

    def download(self, url: str, folder: Path) -> Path:
        self.urls.append(url)
        audio = folder / "youtube.abc.m4a"
        audio.write_bytes(b"m4a audio")
        return audio


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    (tmp_path / "hermetismo" / "raw").mkdir(parents=True)
    (tmp_path / "hermetismo" / "topic.yaml").write_text("slug: hermetismo\n", encoding="utf-8")
    return tmp_path


def worker(api, vault, kb_map=None, kb=None, *, youtube=None, docs=True) -> Worker:
    publisher = KbPublisher(vault, kb or FakeKb(vault))
    ingester = DocIngester(publisher, kb_map or FakeKbMap(vault), youtube) if docs else None
    return Worker(
        api=ApiClient(api.url, lambda: TOKEN, "mac-test"),
        model=FakeModel(),
        find_speech=lambda _: [(0.0, 9.0)],
        decode=lambda path: np.zeros(16000, dtype=np.float32),
        poll_s=0.01,
        error_backoff_s=0.01,
        publisher=publisher,
        docs=ingester,
    )


def test_doc_ingest_is_asked_with_kb_publish_only_when_kb_map_is_here(fake_api, vault):
    fake_api.jobs.clear()
    worker(fake_api, vault, docs=False).step()
    worker(fake_api, vault).step()
    without, with_docs = fake_api.bodies("lease")
    assert "doc-ingest" not in without["kinds"]
    assert with_docs["kinds"][-2:] == ["doc-ingest", "kb-publish"]


def test_ac1_a_file_is_fetched_converted_classified_mapped_and_reported(fake_api, vault):
    (vault / "hermetismo" / "map").mkdir()
    fake_api.jobs[:] = [dict(FILE_JOB)]
    kb_map = FakeKbMap(vault)
    kb = FakeKb(vault)

    assert worker(fake_api, vault, kb_map, kb).step() == "job"

    (converted,) = kb_map.converted
    assert converted["bytes"] == fake_api.document
    assert converted["name"] == "O Caibalion.pdf"
    assert converted["source_path"] == "upload/O Caibalion.pdf"
    assert converted["budget"] == 0.5
    assert [one["state"] for one in fake_api.bodies("doc-state")] == ["classifying", "mapping"]
    assert [step for step, _, _ in kb.calls] == ["classify", "index", "link", "index"]
    assert kb_map.mapped == [("hermetismo", "raw/articles/o-caibalion.md", pytest.approx(0.4992))]
    (result,) = fake_api.bodies("doc-result")
    assert result["leaseId"] == FILE_JOB["leaseId"]
    assert result["outcome"] == {
        "state": "ready",
        "document": {"id": "raw/articles/o-caibalion.md", "title": "O Caibalion"},
    }
    assert result["spendUsd"] == pytest.approx(0.0008)
    assert fake_api.bodies("fail") == []


def test_a_collection_without_a_map_skips_the_map_step(fake_api, vault):
    fake_api.jobs[:] = [dict(URL_JOB)]
    kb_map = FakeKbMap(vault)
    assert worker(fake_api, vault, kb_map).step() == "job"
    assert kb_map.converted[0]["source"] == "https://example.org/artigo"
    assert kb_map.converted[0]["source_path"] == "https://example.org/artigo"
    assert [one["state"] for one in fake_api.bodies("doc-state")] == ["classifying"]
    assert kb_map.mapped == []


def test_ac3_a_document_already_there_is_reported_as_such_without_kb(fake_api, vault):
    fake_api.jobs[:] = [dict(FILE_JOB)]
    existing = vault / "hermetismo" / "raw" / "articles" / "velho.md"
    existing.parent.mkdir(parents=True)
    existing.write_text('---\ntitle: "O Velho"\n---\ncorpo\n', encoding="utf-8")
    kb_map = FakeKbMap(vault, {"state": "duplicate", "document": "raw/articles/velho.md"})
    kb = FakeKb(vault)

    assert worker(fake_api, vault, kb_map, kb).step() == "job"

    (result,) = fake_api.bodies("doc-result")
    assert result["outcome"] == {
        "state": "duplicate",
        "document": {"id": "raw/articles/velho.md", "title": "O Velho"},
    }
    assert kb.calls == []


@pytest.mark.parametrize(
    ("outcome", "failure"),
    [
        ({"state": "failed", "detail": "firecrawl: HTTP 404; jina: HTTP 404"}, "conversion-failed"),
        ({"state": "failed", "detail": "empty or unreadable conversion (3 useful)"}, "empty"),
        (
            {"state": "review", "document": "raw/x.md", "detail": "kb triage: review"},
            "not-accepted",
        ),
    ],
)
def test_ac4_a_link_that_does_not_convert_fails_with_why(fake_api, vault, outcome, failure):
    fake_api.jobs[:] = [dict(URL_JOB)]
    kb = FakeKb(vault)

    assert worker(fake_api, vault, FakeKbMap(vault, outcome), kb).step() == "job"

    (result,) = fake_api.bodies("doc-result")
    assert result["outcome"]["state"] == "failed"
    assert result["outcome"]["failure"] == failure
    assert result["outcome"]["detail"] == outcome["detail"]
    assert kb.calls == []
    assert fake_api.bodies("doc-state") == []


class ScaffoldingKb(FakeKb):
    """`kb topic new` as kb 0.0.12 makes the folder."""

    def __init__(self, vault: Path) -> None:
        super().__init__(vault)
        self.made: list[tuple[str, str, str]] = []

    def new_topic(self, slug: str, title: str, domain: str) -> KbRun:
        self.made.append((slug, title, domain))
        (self.vault / slug).mkdir(parents=True)
        (self.vault / slug / "topic.yaml").write_text(f"slug: {slug}\n", encoding="utf-8")
        return KbRun(ok=True, output="made", spend_usd=0.0)


def test_a_collection_made_on_the_screen_gets_its_folder_before_its_first_document(fake_api, vault):
    collection = {"title": "Cocreation", "domain": "espiritualidade", "parent": None}
    fake_api.jobs[:] = [{**URL_JOB, "topic": "cocreation", "collection": collection}]
    kb = ScaffoldingKb(vault)
    kb_map = FakeKbMap(vault)

    assert worker(fake_api, vault, kb_map, kb).step() == "job"

    assert kb.made == [("cocreation", "Cocreation", "espiritualidade")]
    assert kb_map.converted[0]["topic"] == "cocreation"
    (result,) = fake_api.bodies("doc-result")
    assert result["outcome"]["state"] == "ready"


def test_a_folder_kb_did_not_make_in_the_way_ends_the_job_with_why(fake_api, vault):
    (vault / "cocreation").mkdir()
    collection = {"title": "Cocreation", "domain": "espiritualidade", "parent": None}
    fake_api.jobs[:] = [{**URL_JOB, "topic": "cocreation", "collection": collection}]
    kb_map = FakeKbMap(vault)

    assert worker(fake_api, vault, kb_map, ScaffoldingKb(vault)).step() == "job"

    (result,) = fake_api.bodies("doc-result")
    assert result["outcome"]["state"] == "failed"
    assert "topic.yaml" in result["outcome"]["detail"]
    assert kb_map.converted == []
    assert fake_api.bodies("fail") == []


def test_what_the_conversion_spent_counts_in_the_result_and_in_what_kb_may_spend(fake_api, vault):
    fake_api.jobs[:] = [dict(URL_JOB)]
    doc = vault / "hermetismo" / "raw" / "a.md"
    doc.write_text("---\ntitle: A\n---\ncorpo\n", encoding="utf-8")
    converted = {"state": "converted", "document": "raw/a.md", "usd": 0.2}
    kb = FakeKb(vault)

    assert worker(fake_api, vault, FakeKbMap(vault, converted), kb).step() == "job"

    assert kb.calls[0][2] == pytest.approx(0.3)
    (result,) = fake_api.bodies("doc-result")
    assert result["spendUsd"] == pytest.approx(0.2008)


def test_a_conversion_that_fails_after_spending_reports_the_spend(fake_api, vault):
    fake_api.jobs[:] = [dict(URL_JOB)]
    outcome = {"state": "failed", "detail": "kb wrote nothing ()", "usd": 0.01}
    assert worker(fake_api, vault, FakeKbMap(vault, outcome)).step() == "job"
    (result,) = fake_api.bodies("doc-result")
    assert result["spendUsd"] == pytest.approx(0.01)


def test_a_failing_kb_step_gives_the_job_back_with_kbs_output(fake_api, vault):
    fake_api.jobs[:] = [dict(FILE_JOB)]
    assert worker(fake_api, vault, kb=FakeKb(vault, fail="link")).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["detail"] == "kb link: Error: OpenRouter 502 Bad Gateway"
    assert fake_api.bodies("doc-result") == []


def test_a_youtube_link_gives_its_audio_back_and_nothing_else(fake_api, vault):
    fake_api.jobs[:] = [dict(YOUTUBE_JOB)]
    youtube = FakeYoutube()
    kb_map = FakeKbMap(vault)

    assert worker(fake_api, vault, kb_map, youtube=youtube).step() == "job"

    assert youtube.urls == ["https://youtu.be/abc"]
    posted = [c for c in fake_api.calls if c[1].endswith("/youtube-audio")]
    assert len(posted) == 1
    _, _, body, headers = posted[0]
    assert body == {"bytes": len(b"m4a audio")}
    lowered = {key.lower(): value for key, value in headers.items()}
    assert lowered["content-type"] == "application/octet-stream"
    assert kb_map.converted == []
    assert fake_api.bodies("doc-result") == []
    assert MEDIA_ID


def test_without_yt_dlp_a_youtube_link_fails_with_why(fake_api, vault):
    fake_api.jobs[:] = [dict(YOUTUBE_JOB)]
    assert worker(fake_api, vault).step() == "job"
    (result,) = fake_api.bodies("doc-result")
    assert result["outcome"]["failure"] == "conversion-failed"
    assert "yt-dlp" in result["outcome"]["detail"]


def test_an_api_from_before_doc_ingest_is_not_asked_for_it_again(fake_api, vault):
    fake_api.jobs.clear()
    fake_api.status["lease"] = 400
    mac = worker(fake_api, vault)
    assert mac.step() == "lease-error"
    del fake_api.status["lease"]
    assert mac.step() == "idle"
    first, second = fake_api.bodies("lease")
    assert "doc-ingest" in first["kinds"]
    assert "doc-ingest" not in second["kinds"]


def test_the_title_comes_from_the_frontmatter_and_failures_map_to_codes(vault):
    doc = vault / "hermetismo" / "raw" / "a.md"
    doc.write_text("---\ntype: source\ntitle: 'Título: Um'\n---\n", encoding="utf-8")
    assert title_of(vault, "hermetismo", "raw/a.md") == "Título: Um"
    assert title_of(vault, "hermetismo", "raw/nao.md") == "nao"
    assert isinstance(failure_of({"state": "failed"}), DocIngestFailed)


def test_kb_map_runs_with_its_converters_and_no_key_in_its_arguments(tmp_path):
    from transcriber.doc_ingest import KbMapCli

    cli = KbMapCli(tmp_path, uv="uv", env={"OPENROUTER_API_KEY": "sk-secret"})
    command = cli._command("convert", "hermetismo", "x.pdf")
    assert command[:7] == ["uv", "run", "--quiet", "--project", command[4], "--extra", "convert"]
    assert command[4].endswith("kb-map")
    assert "sk-secret" not in " ".join(command)
