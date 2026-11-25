"""Documents and links sent from the app (KBC-149): a fake kb-map, kb and yt-dlp."""

import subprocess
import time
from pathlib import Path

import numpy as np
import pytest

from transcriber.api import ApiClient, ApiError
from transcriber.doc_ingest import (
    LIST_MAX,
    DocIngester,
    DocIngestFailed,
    YtDlp,
    entries_of,
    failure_of,
    run_whole,
    spent_in,
    title_of,
)
from transcriber.kb_publish import KbPublisher, KbRun, KbStepFailed
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
RECORDING_JOB = {
    **FILE_JOB,
    "source": {
        "kind": "recording",
        "url": "https://youtu.be/abc",
        "audioPath": f"/api/v1/media-worker/jobs/{FILE_JOB['id']}/recording-audio",
    },
}


class FakeKbMap:
    """`kb-map convert` as it answers: writes the document kb would, prints one outcome."""

    def __init__(self, vault: Path, outcome: dict | None = None) -> None:
        self.vault = vault
        self.outcome = outcome
        self.map_spend = 0.0
        self.converted: list[dict] = []
        self.mapped: list[tuple[str, str, float]] = []

    def convert(self, topic, source, *, name, source_path, budget_usd, upload_id):
        self.converted.append(
            {
                "upload_id": upload_id,
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
        return self.map_spend


class FakeRecordings:
    def __init__(self) -> None:
        self.urls: list[str] = []

    def entries(self, url: str) -> list[dict]:
        self.urls.append(url)
        return [{"url": "https://youtu.be/1", "title": "Um", "durationS": 60}]

    def download(self, url: str, folder: Path) -> Path:
        self.urls.append(url)
        audio = folder / "Uma aula [abc].m4a"
        audio.write_bytes(b"m4a audio")
        return audio


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    (tmp_path / "hermetismo" / "raw").mkdir(parents=True)
    (tmp_path / "hermetismo" / "topic.yaml").write_text("slug: hermetismo\n", encoding="utf-8")
    return tmp_path


def worker(api, vault, kb_map=None, kb=None, *, recordings=None, docs=True) -> Worker:
    publisher = KbPublisher(vault, kb or FakeKb(vault))
    ingester = DocIngester(publisher, kb_map or FakeKbMap(vault), recordings) if docs else None
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
    tree = vault / "hermetismo" / "map" / "tree.json"
    tree.parent.mkdir()
    tree.write_text("{}", encoding="utf-8")
    fake_api.jobs[:] = [dict(FILE_JOB)]
    kb_map = FakeKbMap(vault)
    kb_map.map_spend = 0.05
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
        "review": False,
    }
    # classify and link (0.0008) and the map's step: all on the owner's key.
    assert result["spendUsd"] == pytest.approx(0.0508)
    assert converted["upload_id"] == FILE_JOB["id"]
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
            {"state": "refused", "document": "raw/x.md", "detail": "kb triage: quarantined"},
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


def test_a_map_folder_without_a_tree_turns_no_paid_step_on(fake_api, vault):
    (vault / "hermetismo" / "map").mkdir()
    fake_api.jobs[:] = [dict(URL_JOB)]
    kb_map = FakeKbMap(vault)
    assert worker(fake_api, vault, kb_map).step() == "job"
    assert kb_map.mapped == []


def test_a_map_step_that_fails_reports_all_that_was_spent(fake_api, vault):
    tree = vault / "hermetismo" / "map" / "tree.json"
    tree.parent.mkdir()
    tree.write_text("{}", encoding="utf-8")
    fake_api.jobs[:] = [dict(URL_JOB)]

    class Failing(FakeKbMap):
        def map_document(self, topic, doc_id, budget_usd):
            raise KbStepFailed("kb-map sections", "502", 0.02)

    assert worker(fake_api, vault, Failing(vault)).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["spendUsd"] == pytest.approx(0.0208)


def test_what_this_upload_wrote_before_a_crash_goes_on_to_ready(fake_api, vault):
    doc = vault / "hermetismo" / "raw" / "a.md"
    doc.write_text("---\ntitle: A\n---\ncorpo\n", encoding="utf-8")
    fake_api.jobs[:] = [{**URL_JOB, "attempt": 2}]
    own = {"state": "duplicate", "document": "raw/a.md", "own": True}
    kb = FakeKb(vault)
    assert worker(fake_api, vault, FakeKbMap(vault, own), kb).step() == "job"
    assert [step for step, _, _ in kb.calls] == ["classify", "index", "link", "index"]
    (result,) = fake_api.bodies("doc-result")
    assert result["outcome"]["state"] == "ready"


def test_kbs_review_is_ready_and_says_so(fake_api, vault):
    doc = vault / "hermetismo" / "raw" / "a.md"
    doc.write_text("---\ntitle: A\n---\ncorpo\n", encoding="utf-8")
    fake_api.jobs[:] = [dict(URL_JOB)]
    review = {"state": "review", "document": "raw/a.md"}
    assert worker(fake_api, vault, FakeKbMap(vault, review)).step() == "job"
    (result,) = fake_api.bodies("doc-result")
    assert result["outcome"] == {
        "state": "ready",
        "document": {"id": "raw/a.md", "title": "A"},
        "review": True,
    }


def test_without_kbs_key_a_document_waits_with_its_attempts_untouched(fake_api, vault):
    fake_api.jobs[:] = [dict(URL_JOB)]
    missing = {"state": "failed", "detail": "kb ingest: OPENROUTER_API_KEY is not set"}
    assert worker(fake_api, vault, FakeKbMap(vault, missing)).step() == "job"
    assert fake_api.bodies("doc-result") == []
    (failed,) = fake_api.bodies("fail")
    assert failed["failure"] == "not-configured"


def test_a_download_holds_no_lock_on_the_vault(fake_api, vault):
    fake_api.jobs[:] = [dict(RECORDING_JOB)]
    mac = worker(fake_api, vault, recordings=FakeRecordings())
    mac.publisher.locked = lambda: pytest.fail("the vault was locked for a download")
    assert mac.step() == "job"
    assert len([c for c in fake_api.calls if c[1].endswith("/recording-audio")]) == 1


def test_a_command_that_takes_too_long_ends_with_all_it_started(tmp_path):
    marker = tmp_path / "late"
    script = f"(sleep 2; touch {marker}) & sleep 30"
    started = time.monotonic()
    with pytest.raises(DocIngestFailed, match="took more than"):
        run_whole(["/bin/sh", "-c", script], 0.3)
    assert time.monotonic() - started < 2
    time.sleep(2.2)
    assert not marker.exists()


def test_the_spend_of_the_map_step_is_its_last_json_line():
    assert spent_in('written a\nkb-map sections: 1 written\n{"spentUsd": 0.0123}\n') == 0.0123
    assert spent_in("kb-map sections: nothing to do\n{oops\n") == 0.0


def test_a_name_that_starts_with_a_dash_is_a_name(tmp_path, monkeypatch):
    from transcriber import doc_ingest

    seen = []

    def fake(command, timeout, cwd=None, env=None):
        seen.append(command)
        return subprocess.CompletedProcess(command, 0, '{"state": "failed"}\n', "")

    monkeypatch.setattr(doc_ingest, "run_whole", fake)
    cli = doc_ingest.KbMapCli(tmp_path)
    cli.convert(
        "t", "/x", name="--topic.pdf", source_path="upload/-x", budget_usd=0.1, upload_id="u"
    )
    assert "--name=--topic.pdf" in seen[0]
    assert "--source-path=upload/-x" in seen[0]


def test_a_failing_kb_step_gives_the_job_back_with_kbs_output(fake_api, vault):
    fake_api.jobs[:] = [dict(FILE_JOB)]
    assert worker(fake_api, vault, kb=FakeKb(vault, fail="link")).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["detail"] == "kb link: Error: OpenRouter 502 Bad Gateway"
    assert fake_api.bodies("doc-result") == []


def test_a_recording_link_gives_its_audio_back_and_nothing_else(fake_api, vault):
    fake_api.jobs[:] = [dict(RECORDING_JOB)]
    recordings = FakeRecordings()
    kb_map = FakeKbMap(vault)

    assert worker(fake_api, vault, kb_map, recordings=recordings).step() == "job"

    assert recordings.urls == ["https://youtu.be/abc"]
    posted = [c for c in fake_api.calls if c[1].endswith("/recording-audio")]
    assert len(posted) == 1
    _, _, body, headers = posted[0]
    assert body == {"bytes": len(b"m4a audio")}
    lowered = {key.lower(): value for key, value in headers.items()}
    assert lowered["content-type"] == "application/octet-stream"
    assert kb_map.converted == []
    assert fake_api.bodies("doc-result") == []
    assert MEDIA_ID


def test_a_list_is_read_and_offered_and_nothing_is_downloaded(fake_api, vault):
    url = "https://www.youtube.com/playlist?list=PL1"
    path = f"/api/v1/media-worker/jobs/{FILE_JOB['id']}/doc-entries"
    source = {"kind": "list", "url": url, "entriesPath": path}
    fake_api.jobs[:] = [{**FILE_JOB, "source": source}]
    recordings = FakeRecordings()
    kb_map = FakeKbMap(vault)

    assert worker(fake_api, vault, kb_map, recordings=recordings).step() == "job"

    assert recordings.urls == [url]
    (body,) = fake_api.bodies("doc-entries")
    assert body["entries"] == [{"url": "https://youtu.be/1", "title": "Um", "durationS": 60}]
    assert kb_map.converted == []
    assert fake_api.bodies("doc-result") == []


def test_a_listing_keeps_what_has_an_address_and_opens_the_tabs_of_a_channel():
    listing = {
        "entries": [
            {"url": "https://youtu.be/1", "title": " Um ", "duration": 60.4},
            None,
            {"url": "abc", "title": "sem endereço"},
            {"_type": "playlist", "entries": [{"webpage_url": "https://youtu.be/2"}]},
        ]
    }
    assert entries_of(listing) == [
        {"url": "https://youtu.be/1", "title": "Um", "durationS": 60},
        {"url": "https://youtu.be/2", "title": "https://youtu.be/2", "durationS": None},
    ]
    assert entries_of({}) == []
    many = [{"url": f"https://youtu.be/{n}", "title": "t"} for n in range(LIST_MAX + 1)]
    assert len(entries_of({"entries": many})) == LIST_MAX
    # One the app would refuse does not take the others with it.
    long = {"url": "https://a.org/" + "x" * 2_000, "title": "t"}
    emoji = {"url": "https://youtu.be/3", "title": "😱" * 300}
    (kept,) = entries_of({"entries": [long, emoji]})
    assert len(kept["title"].encode("utf-16-le")) // 2 <= 300


def test_without_yt_dlp_a_recording_link_fails_with_why(fake_api, vault):
    fake_api.jobs[:] = [dict(RECORDING_JOB)]
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


def test_what_a_job_says_is_said_again_once_the_api_is_back(monkeypatch):
    """The API restarting (a deploy) must not cost the minutes a job took."""
    from transcriber import api as api_module

    api = ApiClient("http://localhost:1", lambda: "t" * 40, "mac")
    # Down, then a gateway's error (behind Caddy), then back.
    waited, answers = [], [ApiError("refused"), (502, b""), (204, b"")]

    def post(path, body):
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(api, "_post", post)
    monkeypatch.setattr(api_module.time, "sleep", waited.append)
    monkeypatch.setattr(api_module, "UNREACHABLE_WAITS_S", (2, 5))
    assert api._on_job({"id": "j", "leaseId": "l"}, "doc-result", {})
    assert waited == [2, 5]


def test_an_answer_is_never_said_again(monkeypatch):
    api = ApiClient("http://localhost:1", lambda: "t" * 40, "mac")
    calls = []

    def post(path, body):
        calls.append(path)
        raise ApiError("doc-result answered 400", 400)

    monkeypatch.setattr(api, "_post", post)
    with pytest.raises(ApiError):
        api._on_job({"id": "j", "leaseId": "l"}, "doc-result", {})
    assert len(calls) == 1


def scripted(monkeypatch, *answers):
    """yt-dlp answering as told, one answer per run, and the waits between them."""
    from transcriber import doc_ingest

    runs, waited = [], []

    def run(command, timeout, **_kwargs):
        runs.append(command)
        code, output, name = answers[len(runs) - 1]
        if name:
            template = Path(command[command.index("-o") + 1])
            (template.parent / name).write_bytes(b"m4a")
        return subprocess.CompletedProcess(command, code, output, "")

    monkeypatch.setattr(doc_ingest, "run_whole", run)
    monkeypatch.setattr(doc_ingest.time, "sleep", waited.append)
    return runs, waited


def test_a_site_that_refuses_for_a_moment_is_asked_again(tmp_path, monkeypatch):
    runs, waited = scripted(
        monkeypatch, (1, "ERROR: HTTP Error 403: Forbidden", None), (0, "", "Aula [x].m4a")
    )
    found = YtDlp("yt-dlp", "/opt/node").download("https://youtu.be/x", tmp_path)
    assert found.name == "Aula [x].m4a"
    assert waited == [10]
    assert runs[0][:4] == ["yt-dlp", "--ignore-config", "--use-extractors", "default,-generic"]
    assert runs[0][4:6] == ["--js-runtimes", "node:/opt/node"]


def test_what_will_not_pass_fails_at_once_and_refused_three_times_it_fails(tmp_path, monkeypatch):
    runs, _ = scripted(monkeypatch, (1, "ERROR: Private video", None))
    with pytest.raises(DocIngestFailed, match="Private video"):
        YtDlp().download("https://youtu.be/x", tmp_path)
    assert len(runs) == 1
    runs, waited = scripted(monkeypatch, *[(1, "HTTP Error 429", None)] * 3)
    with pytest.raises(DocIngestFailed):
        YtDlp().download("https://youtu.be/x", tmp_path)
    assert waited == [10, 30]


def test_node_is_nvms_newest_when_it_is_not_on_path(tmp_path, monkeypatch):
    from transcriber import doc_ingest

    for version in ("v9.11.0", "v22.23.2", "v22.4.0"):
        node = Path.home() / ".nvm" / "versions" / "node" / version / "bin" / "node"
        node.parent.mkdir(parents=True)
        node.touch(mode=0o755)
    monkeypatch.setattr(doc_ingest.shutil, "which", lambda _name: None)
    assert "v22.23.2" in (doc_ingest.node_or_none() or "")


def test_a_budget_that_ended_waits_and_a_missing_key_is_configuration(tmp_path, monkeypatch):
    from transcriber import doc_ingest
    from transcriber.kb_keys import is_configuration_error

    def answer(code, stderr):
        def run(command, timeout, **_kwargs):
            return subprocess.CompletedProcess(command, code, "", stderr)

        monkeypatch.setattr(doc_ingest, "run_whole", run)
        return doc_ingest.KbMapCli(tmp_path)

    given = {"name": None, "source_path": "u", "budget_usd": 0.1, "upload_id": "u"}
    with pytest.raises(KbStepFailed):
        answer(3, "budget reached before describing a.png").convert("t", "/x", **given)
    for words in (
        "kb-map: no OpenRouter key: on this Mac run …",
        "kb-map: kb is not on PATH",
    ):
        with pytest.raises(DocIngestFailed) as failed:
            answer(1, words).convert("t", "/x", **given)
        assert is_configuration_error(failed.value.detail), words


@pytest.mark.parametrize(
    ("output", "failure"),
    [
        ("[download] x does not pass filter (!is_live), skipping ..", "live"),
        ("File is larger than max-filesize (3221225472 bytes > 2147483648 bytes)", "too-large"),
        ("ERROR: Video unavailable", "conversion-failed"),
    ],
)
def test_a_live_stream_and_a_too_large_file_say_so(tmp_path, monkeypatch, output, failure):
    scripted(monkeypatch, (0 if failure != "conversion-failed" else 1, output, None))
    with pytest.raises(DocIngestFailed) as refused:
        YtDlp().download("https://youtu.be/x", tmp_path)
    assert refused.value.failure == failure


def test_a_dead_link_without_a_firecrawl_key_is_only_a_dead_link(fake_api, vault):
    """Firecrawl is optional (Jina reads without it): the Mac is not missing anything."""
    fake_api.jobs[:] = [dict(URL_JOB)]
    detail = (
        "firecrawl: no FIRECRAWL_API_KEY in the environment or the Keychain; "
        "jina: Jina answered HTTP 404"
    )
    mac = worker(fake_api, vault, FakeKbMap(vault, {"state": "failed", "detail": detail}))
    kinds = mac.kinds
    assert mac.step() == "job"
    (result,) = fake_api.bodies("doc-result")
    assert result["outcome"]["failure"] == "conversion-failed"
    assert fake_api.bodies("fail") == []
    assert mac.kinds == kinds
