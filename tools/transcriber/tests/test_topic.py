"""The collection's vault folder, made by kb on this Mac (KBC-114): a fake kb, never the real."""

from pathlib import Path

import pytest

from transcriber.kb_publish import KbCli, KbPublisher, KbRun, KbStepFailed, UnsafePath
from transcriber.topic import TopicConflict, ensure_topic

from .test_kb_publish import JOB, FakeKb


class FakeTopicKb(FakeKb):
    """kb 0.0.12's `kb topic new`, as the spike of 2026-11-09 saw it on a scratch vault: it
    scaffolds the folder with topic.yaml (a sub-collection inside its parent's folder, with
    `category` and `path`), and refuses a folder that already exists."""

    def __init__(self, vault: Path, fail_topic: bool = False, **kwargs) -> None:
        super().__init__(vault, **kwargs)
        self.fail_topic = fail_topic
        self.topics: list[tuple[str, str, str]] = []

    def new_topic(self, slug: str, title: str, domain: str) -> KbRun:
        self.topics.append((slug, title, domain))
        self.calls.append(("topic new", slug, 0.0))
        if self.fail_topic:
            return KbRun(ok=False, output="new topic: something broke")
        folder = self.vault / slug
        if folder.exists():
            return KbRun(ok=False, output=f'new topic: topic directory "{folder}" already exists')
        (folder / "raw" / "articles").mkdir(parents=True)
        name = slug.rsplit("/", 1)[-1]
        lines = [f"slug: {name}", f"title: {title}", f"domain: {domain}", "mode: wiki"]
        if "/" in slug:
            lines += [f"category: {slug.split('/', maxsplit=1)[0]}", f"path: {slug}"]
        (folder / "topic.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")
        return KbRun(ok=True, output=f'{{"slug": "{slug}"}}')


NEW = {"title": "Novo acervo", "domain": "espiritualidade", "parent": None}
CHILD = {
    "title": "Palavra do Mestre",
    "domain": "espiritualidade",
    "parent": {"slug": "udv", "title": "UDV", "domain": "espiritualidade"},
}


def topic_yaml(vault: Path, slug: str) -> Path:
    path = vault / slug / "topic.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"slug: {slug}\n", encoding="utf-8")
    return path


def test_ac1_a_new_collection_is_scaffolded_once_before_kb_classifies(tmp_path):
    kb = FakeTopicKb(tmp_path)
    job = {**JOB, "topic": "novo", "collection": NEW}
    KbPublisher(tmp_path, kb).publish(job)
    assert kb.topics == [("novo", "Novo acervo", "espiritualidade")]
    assert [step for step, _, _ in kb.calls][:2] == ["topic new", "classify"]
    assert (tmp_path / "novo" / "topic.yaml").is_file()
    assert (tmp_path / "novo" / "raw" / "media" / "rec" / "track-1.md").is_file()
    # A second job finds the folder: kb is never asked again.
    KbPublisher(tmp_path, kb).publish(job)
    assert len(kb.topics) == 1


def test_ac2_a_sub_collection_without_its_parent_creates_the_parent_first(tmp_path):
    kb = FakeTopicKb(tmp_path)
    ensure_topic(tmp_path, "udv/palavra-do-mestre", CHILD, kb)
    assert kb.topics == [
        ("udv", "UDV", "espiritualidade"),
        ("udv/palavra-do-mestre", "Palavra do Mestre", "espiritualidade"),
    ]
    child = (tmp_path / "udv" / "palavra-do-mestre" / "topic.yaml").read_text(encoding="utf-8")
    assert "category: udv" in child
    assert "path: udv/palavra-do-mestre" in child


def test_ac2_a_sub_collection_of_an_existing_parent_creates_only_itself(tmp_path):
    topic_yaml(tmp_path, "udv")
    kb = FakeTopicKb(tmp_path)
    ensure_topic(tmp_path, "udv/palavra-do-mestre", CHILD, kb)
    assert kb.topics == [("udv/palavra-do-mestre", "Palavra do Mestre", "espiritualidade")]


def test_ac3_existing_folders_like_the_owners_udv_are_never_scaffolded_again(tmp_path):
    parent = topic_yaml(tmp_path, "udv")
    child = topic_yaml(tmp_path, "udv/palavra-do-mestre")
    kb = FakeTopicKb(tmp_path)
    ensure_topic(tmp_path, "udv/palavra-do-mestre", CHILD, kb)
    ensure_topic(tmp_path, "udv", {**NEW, "title": "UDV"}, kb)
    # Even a job with no collection (an API from before KBC-114) passes an existing folder.
    ensure_topic(tmp_path, "udv", None, kb)
    assert kb.topics == []
    assert parent.read_text(encoding="utf-8") == "slug: udv\n"
    assert child.read_text(encoding="utf-8") == "slug: udv/palavra-do-mestre\n"


def test_ac3_a_folder_without_topic_yaml_refuses_the_job_and_writes_nothing(tmp_path):
    (tmp_path / "solto" / "raw").mkdir(parents=True)
    kb = FakeTopicKb(tmp_path)
    job = {**JOB, "topic": "solto", "collection": NEW}
    with pytest.raises(TopicConflict, match=r"existe sem topic\.yaml"):
        KbPublisher(tmp_path, kb).publish(job)
    assert kb.calls == []
    assert not (tmp_path / "solto" / "raw" / "media").exists()


def test_ac3_a_parent_folder_without_topic_yaml_refuses_the_job(tmp_path):
    (tmp_path / "udv").mkdir()
    kb = FakeTopicKb(tmp_path)
    with pytest.raises(TopicConflict, match="udv"):
        ensure_topic(tmp_path, "udv/palavra-do-mestre", CHILD, kb)
    assert kb.topics == []


def test_a_missing_folder_with_no_collection_in_the_job_is_refused(tmp_path):
    kb = FakeTopicKb(tmp_path)
    with pytest.raises(TopicConflict, match="não diz como criar"):
        ensure_topic(tmp_path, "novo", None, kb)
    assert kb.topics == []


@pytest.mark.parametrize(
    ("topic", "collection"),
    [
        ("a/b/c", NEW),
        ("../fora", NEW),
        ("Novo", NEW),
        ("outro/filho", CHILD),
        ("udv/palavra-do-mestre", NEW),
        ("udv/palavra-do-mestre", {**CHILD, "parent": {**CHILD["parent"], "slug": "../x"}}),
    ],
)
def test_ac4_an_unsafe_slug_or_a_parent_that_does_not_match_is_refused_before_kb(
    tmp_path, topic, collection
):
    kb = FakeTopicKb(tmp_path)
    with pytest.raises(UnsafePath):
        ensure_topic(tmp_path, topic, collection, kb)
    assert kb.topics == []
    assert sorted(p.name for p in tmp_path.iterdir()) == []


def test_ac4_a_vault_folder_linked_outside_the_vault_is_refused(tmp_path):
    vault, outside = tmp_path / "vault", tmp_path / "outside"
    vault.mkdir()
    outside.mkdir()
    (vault / "udv").symlink_to(outside)
    kb = FakeTopicKb(vault)
    with pytest.raises(UnsafePath):
        ensure_topic(vault, "udv/palavra-do-mestre", CHILD, kb)
    assert kb.topics == []
    assert list(outside.iterdir()) == []


def test_a_failed_kb_topic_new_fails_with_kbs_output(tmp_path):
    kb = FakeTopicKb(tmp_path, fail_topic=True)
    with pytest.raises(KbStepFailed, match="kb topic new: new topic: something broke"):
        ensure_topic(tmp_path, "novo", NEW, kb)


def test_the_real_kb_topic_command_takes_the_arguments_as_a_list():
    cli = KbCli(Path("/vault"), "kb")
    assert cli.topic_command("udv/x", "Título: com espaço", "geral") == [
        "kb",
        "topic",
        "new",
        "--",
        "udv/x",
        "Título: com espaço",
        "geral",
    ]


def test_a_title_that_looks_like_a_flag_stays_a_title():
    """kb 0.0.12 (cobra) reads `--` as the end of its flags: verified on a scratch vault."""
    cli = KbCli(Path("/vault"), "kb")
    command = cli.topic_command("x", "--vault /etc", "geral")
    assert command.index("--") < command.index("--vault /etc")


def test_the_worker_fails_a_job_whose_folder_is_in_the_way_with_the_reason(fake_api, tmp_path):
    from .test_kb_publish import worker

    (tmp_path / "solto").mkdir()
    fake_api.jobs[:] = [{**JOB, "topic": "solto", "collection": NEW}]
    publisher = KbPublisher(tmp_path, FakeTopicKb(tmp_path))
    assert worker(fake_api, publisher).step() == "job"
    (failed,) = fake_api.bodies("fail")
    assert failed["failure"] == "conversion-failed"
    assert "a pasta solto existe sem topic.yaml" in failed["detail"]
    assert "spendUsd" not in failed
    assert fake_api.bodies("kb-result") == []
