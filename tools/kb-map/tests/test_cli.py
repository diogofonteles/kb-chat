"""The CLI end to end with a scripted model: every subcommand, the log, the budget, the paths."""

import pytest

from conftest import TOPIC
from corpus import build_corpus
from fakes import Model
from kb_map import cli
from kb_map.commands import _common, register_all
from kb_map.layout import MapLayout
from kb_map.vault import Vault


@pytest.fixture
def model(monkeypatch):
    scripted = Model()
    provider = scripted.provider(usd_per_call=0.01)
    monkeypatch.setattr(_common, "provider_factory", lambda args, vault: provider)
    scripted.fake = provider
    return scripted


def _run(vault, *args):
    return cli.main(["--vault", str(vault), *args])


def test_every_subcommand_is_registered_by_discovery():
    import argparse

    sub = argparse.ArgumentParser().add_subparsers()
    assert register_all(sub) == [
        "check",
        "convert",
        "dossier",
        "index",
        "paths",
        "reconvert",
        "sections",
        "tree",
    ]


def test_the_whole_map_through_the_cli(vault, model, capsys):
    build_corpus(vault)
    log_before = (vault / TOPIC / "log.md").read_text(encoding="utf-8")

    assert _run(vault, "check", TOPIC) == 0  # no map yet: nothing to check
    assert _run(vault, "sections", TOPIC) == 0
    assert _run(vault, "check", TOPIC) == 1  # sections without a tree: unplaced
    assert _run(vault, "tree", "build", TOPIC) == 0
    assert _run(vault, "dossier", TOPIC) == 0
    capsys.readouterr()
    assert _run(vault, "check", TOPIC) == 0
    assert "0 problems" in capsys.readouterr().out

    log = (vault / TOPIC / "log.md").read_text(encoding="utf-8")
    assert log.startswith(log_before)  # append-only
    added = log[len(log_before) :]
    assert "] map | kb-map sections: 4 written" in added
    assert "] map | kb-map tree build:" in added
    assert "] compile | kb-map dossier:" in added
    assert "US$" in added

    capsys.readouterr()
    assert _run(vault, "paths", TOPIC) == 0
    paths = capsys.readouterr().out.split("\n")
    assert paths[0] == "map/"
    assert "index.md" in paths
    assert "wiki/concepts/Sete Princípios.md" in paths
    assert "wiki/subjects/Ritmo.md" in paths
    assert "wiki/entities/Caibalion.md" in paths
    assert "wiki/concepts/Cabala.md" in paths  # its stub became a page (review section)


def test_a_second_sections_run_is_free_and_not_logged(vault, model, capsys):
    build_corpus(vault)
    _run(vault, "sections", TOPIC)
    calls = len(model.fake.calls)
    log = (vault / TOPIC / "log.md").read_text(encoding="utf-8")
    assert _run(vault, "sections", TOPIC) == 0
    assert len(model.fake.calls) == calls
    assert (vault / TOPIC / "log.md").read_text(encoding="utf-8") == log
    assert "4 unchanged" in capsys.readouterr().out


def test_the_budget_stops_the_run_and_keeps_what_was_saved(vault, model, capsys):
    build_corpus(vault)
    # 0.01 per call: the third call's projection passes 0.025.
    assert _run(vault, "sections", TOPIC, "--max-usd", "0.025") == cli.EXIT_BUDGET
    err = capsys.readouterr().err
    assert "budget reached" in err
    layout = MapLayout(Vault(vault).topic(TOPIC))
    assert len(layout.section_docs()) == 2
    # Run again without a ceiling: only the two left are asked for.
    before = len(model.fake.calls)
    assert _run(vault, "sections", TOPIC) == 0
    assert len(model.fake.calls) - before == 2


def test_tree_apply_reads_a_yaml_file_and_refuses_bad_lines(vault, model, tmp_path, capsys):
    build_corpus(vault)
    _run(vault, "sections", TOPIC)
    _run(vault, "tree", "build", TOPIC)
    corrections = tmp_path / "correcoes.yaml"
    corrections.write_text(
        '- rename: {node: ritmo, name: "Lei do Ritmo"}\n- delete: {node: nada}\n',
        encoding="utf-8",
    )
    capsys.readouterr()
    assert _run(vault, "tree", "apply", TOPIC, str(corrections)) == 1
    out = capsys.readouterr().out
    assert "done     renamed ritmo to 'Lei do Ritmo'" in out
    assert "refused  #2 delete: no node 'nada'" in out
    review = (vault / TOPIC / "map/tree-review.md").read_text(encoding="utf-8")
    assert "**Lei do Ritmo** `ritmo`" in review and "[nome do dono]" in review


def test_one_document_only_and_a_document_outside_the_topic(vault, model, capsys):
    build_corpus(vault)
    assert _run(vault, "sections", TOPIC, "--doc", "raw/articles/ritmo-ml.md") == 0
    assert MapLayout(Vault(vault).topic(TOPIC)).section_docs() == ["raw/articles/ritmo-ml.md"]
    assert _run(vault, "sections", TOPIC, "--doc", str(vault / "kb.toml")) == 1
    assert "is not a document of the topic" in capsys.readouterr().err


def test_a_vault_is_required(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert cli.main(["check", TOPIC]) == 1
    assert "no kb vault found" in capsys.readouterr().err
