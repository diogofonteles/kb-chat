"""Page titles of the tree's nodes, unique across the wiki, and where each page lives."""

from .layout import MapLayout
from .tree import Tree
from .wiki import page_file_name


def page_titles(layout: MapLayout, tree: Tree) -> dict[str, tuple[str, str]]:
    """node id -> (title, topic-relative page path); titles are unique across the wiki."""
    titles: dict[str, tuple[str, str]] = {}
    used: set[str] = set()
    for node in tree.ordered():
        if node.parent is None and node.concept:
            title = node.concept.rsplit("/", 1)[-1][: -len(".md")]
            titles[node.id] = (title, node.concept)
            used.add(title.casefold())
    for node in tree.ordered():
        if node.id in titles:
            continue
        title = node.name
        if title.casefold() in used and node.parent:
            title = f"{node.name} ({tree.nodes[node.parent].name})"
        number = 2
        base = title
        while title.casefold() in used:
            title, number = f"{base} {number}", number + 1
        used.add(title.casefold())
        folder = layout.subjects_dir.relative_to(layout.topic.dir).as_posix()
        titles[node.id] = (title, f"{folder}/{page_file_name(title)}")
    return titles
