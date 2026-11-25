"""Who affirms a teaching (ADR 0015): Mestre Laércio's group or the other authors'.

The groups are the vault's own `author_group` values. A speaker who is the document's author
takes the document's group; a speaker who is Mestre Laércio by any of his names is his group;
anyone else (a quoted author, a reader) is `outros-autores`.
"""

from .textutil import fold

MAIN_GROUP = "mestre-laercio"
OTHERS_GROUP = "outros-autores"
GROUP_LABELS = {MAIN_GROUP: "Mestre Laércio", OTHERS_GROUP: "Outros autores"}
MAIN_NAMES = frozenset(
    fold(name) for name in ("Mestre Laércio", "José Laércio do Egito", "Laércio do Egito")
)


def group_of(speaker: str, doc_author: str | None, doc_group: str | None) -> str:
    name = fold(speaker)
    if doc_author and name == fold(doc_author) and doc_group in (MAIN_GROUP, OTHERS_GROUP):
        return doc_group
    if name in MAIN_NAMES:
        return MAIN_GROUP
    return OTHERS_GROUP


def default_speaker(doc_author: str | None, doc_group: str | None) -> str:
    if doc_author:
        return doc_author
    return GROUP_LABELS[MAIN_GROUP] if doc_group == MAIN_GROUP else "Autor desconhecido"
