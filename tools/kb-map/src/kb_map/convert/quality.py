"""The useful characters of a text, to compare a new conversion with the text it replaces.

BR-3: a conversion that is empty, unreadable or below 80 % of the current text's useful
characters replaces nothing. Useful means letters and digits: Markdown syntax, table pipes,
page markers, numbering and white space do not count, so a structured Markdown is not
favoured (or punished) for its markup.
"""

import re

MIN_RATIO = 0.8
MIN_USEFUL = 40
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


def useful_chars(text: str) -> int:
    return sum(1 for char in _COMMENT.sub("", text) if char.isalnum())


def verdict(new: str, current: str | None) -> str | None:
    """None when `new` may replace `current`; else why not (for the review queue)."""
    new_count = useful_chars(new)
    if new_count < MIN_USEFUL:
        return f"empty or unreadable conversion ({new_count} useful characters)"
    if current is None:
        return None
    current_count = useful_chars(current)
    if current_count and new_count < MIN_RATIO * current_count:
        percent = round(100 * new_count / current_count)
        return (
            f"the conversion has {percent} % of the current text's useful characters "
            f"({new_count} of {current_count}; at least {round(100 * MIN_RATIO)} % needed)"
        )
    return None
