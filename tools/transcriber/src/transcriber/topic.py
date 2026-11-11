"""The collection's folder in the vault, made by kb on this Mac (KBC-114, ADR 0035 amendment).

A collection created on the screen has no folder in the vault yet. Its first kb-publish job
carries what kb needs to make one (`collection: { title, domain, parent }`), and the worker
runs `kb topic new <slug> <title> <domain>` under the publication lock, before writing any
document. A folder is kb's when it has `topic.yaml`: then nothing runs, ever. A sub-collection
`parent/child` is scaffolded inside its parent's folder, as kb 0.0.12 does for
`udv/palavra-do-mestre` (the spike of 2026-11-09 on a scratch vault); a missing parent is
scaffolded first. The API never writes the vault (Q7): kb does, here.
"""

from pathlib import Path

from .kb_publish import TOPIC, KbStepFailed, UnsafePath

TOPIC_FILE = "topic.yaml"
# The app nests one level only (ADR 0028): `parent/child`.
MAX_SEGMENTS = 2


class TopicConflict(Exception):
    """The collection's folder cannot be made: something that is not kb's is in the way."""


def _inside(vault: Path, slug: str) -> Path:
    """The slug's folder, resolved, refusing anything outside the vault (a link out too)."""
    root = vault.resolve()
    folder = (root / slug).resolve()
    if root not in folder.parents:
        raise UnsafePath(slug)
    return folder


def _checked(topic: str, collection: dict | None) -> list[tuple[str, str, str]]:
    """The topics to make, parent first, from the job; raises UnsafePath before kb runs."""
    if not isinstance(topic, str) or not TOPIC.match(topic):
        raise UnsafePath(str(topic))
    segments = topic.split("/")
    if len(segments) > MAX_SEGMENTS:
        raise UnsafePath(topic)
    if collection is None:
        return []
    parent = collection.get("parent")
    if len(segments) == 1:
        if parent is not None:
            raise UnsafePath(topic)
        return [(topic, collection["title"], collection["domain"])]
    if not parent or parent.get("slug") != segments[0]:
        raise UnsafePath(topic)
    return [
        (segments[0], parent["title"], parent["domain"]),
        (topic, collection["title"], collection["domain"]),
    ]


def ensure_topic(vault: Path, topic: str, collection: dict | None, kb) -> list[str]:
    """Makes the collection's folder when it is missing; the slugs kb scaffolded (none mostly).

    Raises UnsafePath (a slug that is not a collection's, or a parent that does not match),
    TopicConflict (a folder without topic.yaml in the way, or a job that does not say how to
    make the folder) and KbStepFailed (kb refused).
    """
    plan = _checked(topic, collection)
    folders = {slug: _inside(vault, slug) for slug in {topic, *(one[0] for one in plan)}}
    if (folders[topic] / TOPIC_FILE).is_file():
        return []
    if collection is None:
        raise TopicConflict(
            f"a pasta {topic} não existe no vault e o job não diz como criar o acervo"
        )
    made: list[str] = []
    for slug, title, domain in plan:
        folder = folders[slug]
        if (folder / TOPIC_FILE).is_file():
            continue
        if folder.exists():
            raise TopicConflict(
                f"a pasta {slug} existe sem topic.yaml: o kb não cria um acervo por cima"
            )
        run = kb.new_topic(slug, title, domain)
        if not run.ok:
            raise KbStepFailed("topic new", run.output, run.spend_usd)
        if not (folder / TOPIC_FILE).is_file():
            raise KbStepFailed("topic new", f"{slug}: kb não criou {TOPIC_FILE}")
        made.append(slug)
    return made
