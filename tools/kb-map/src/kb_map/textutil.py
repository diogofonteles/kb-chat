"""Small text helpers shared by every step: folding, slugs, UTF-16 positions, hashes."""

import hashlib
import re
import unicodedata

_NON_WORD = re.compile(r"[^a-z0-9]+")


def fold(text: str) -> str:
    """Accent- and case-insensitive form, with runs of space collapsed (for matching only)."""
    decomposed = unicodedata.normalize("NFD", text)
    bare = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(bare.casefold().split())


def slugify(text: str) -> str:
    """A file- and id-safe slug: `Sete Princípios` -> `sete-principios`."""
    slug = _NON_WORD.sub("-", fold(text)).strip("-")
    return slug or "no"


def utf16_len(text: str) -> int:
    """Length as JavaScript counts it: the API's `read_document` positions are UTF-16 units."""
    return len(text.encode("utf-16-le")) // 2


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def contains_folded(haystack_folded: str, needle: str) -> bool:
    """Whole-phrase match of `needle` in an already folded text (word edges respected)."""
    phrase = fold(needle)
    if not phrase:
        return False
    return re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", haystack_folded) is not None


def one_line(text: str) -> str:
    return " ".join(text.split())
