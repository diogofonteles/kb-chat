"""What a page shows around its text and the main-content reading leaves in: the skip links,
the consent banner and images with nothing to say. Only at the page's two ends, and only what
is plainly that: a page about cookies keeps its words."""

import re

# How many lines of each end may hold it.
EDGE_LINES = 30
# At the foot, less: an article's last paragraphs are its own.
TAIL_LINES = 6
# A consent notice is a paragraph or two; anything longer is the page's own text.
NOTICE_CHARS = 1_500

_SKIP = re.compile(
    r"^\W*(skip to (main )?content|pular para o conte[úu]do|ir para o conte[úu]do"
    r"|top of page|bottom of page|topo da p[áa]gina|(close|fechar) (this )?(consent )?banner"
    r"|your privacy choices|privacy preferences|prefer[êe]ncias de privacidade"
    r"|accept( all)?( cookies)?|aceitar( todos)?( os cookies)?|reject all|rejeitar( todos)?"
    r"|manage (cookie )?preferences|gerenciar (prefer[êe]ncias|cookies)"
    r"|(opens? (in a new window|an external website)( in a new window)?\W*)+)\W*$",
    re.IGNORECASE,
)
_COOKIES = re.compile(r"\bcookies?\b", re.IGNORECASE)
_CONSENT = re.compile(
    r"\b(consent|privacy|preferences|this (web)?site (uses|utilizes)|we use"
    r"|consentimento|privacidade|prefer[êe]ncias|(este|nosso) site (usa|utiliza)|usamos)\b",
    re.IGNORECASE,
)
_EMPTY_IMAGE = re.compile(r"^!\[\s*\]\([^)]*\)$")


def _is_around(line: str) -> bool:
    text = line.strip()
    if not text:
        return False
    if _SKIP.match(text) or _EMPTY_IMAGE.match(text):
        return True
    return len(text) <= NOTICE_CHARS and bool(_COOKIES.search(text) and _CONSENT.search(text))


def _ends_of(lines: list[str]) -> tuple[int, int]:
    """Where the page's text begins (its first heading, or a few lines) and ends."""
    text = [at for at, line in enumerate(lines) if line.startswith("#")]
    head = min(text[0] if text else EDGE_LINES, EDGE_LINES, len(lines))
    return head, max(head, len(lines) - TAIL_LINES)


def clean_page(markdown: str) -> str:
    """The page without what is around its text, at its two ends."""
    lines = markdown.splitlines()
    head, tail = _ends_of(lines)
    kept = [
        line
        for at, line in enumerate(lines)
        if not ((at < head or at >= tail) and _is_around(line))
    ]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip() + "\n"
