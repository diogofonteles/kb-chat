"""What surrounds a page's text is left out, and the text never is."""

import pytest

from kb_map.convert.web_clean import clean_page

# As Firecrawl gave a Scribd page on 2026-11-25.
SCRIBD = """Opens in a new windowOpens an external websiteOpens an external website in a new window

This website utilizes technologies such as cookies to enable essential site functionality, as \
well as for analytics, personalization, and targeted advertising. To learn more, view the \
following link: Privacy Policy

Close this consent banner

Your Privacy Choices

Skip to main content

# O Poder do Subconsciente

Joseph Murphy ensina que a mente cria.
"""


def test_the_consent_banner_and_the_skip_links_are_left_out():
    assert clean_page(SCRIBD.replace("\\\n", "")) == (
        "# O Poder do Subconsciente\n\nJoseph Murphy ensina que a mente cria.\n"
    )


@pytest.mark.parametrize(
    "line",
    [
        "top of page",
        "![](https://static.wixstatic.com/media/logo.png)",
        "Pular para o conteúdo",
        "Aceitar todos os cookies",
        "Este site usa cookies. Veja a nossa política de privacidade.",
    ],
)
def test_what_is_around_goes(line):
    assert clean_page(f"{line}\n\nA luz do Todo.\n") == "A luz do Todo.\n"


@pytest.mark.parametrize(
    "line",
    [
        "A receita dos cookies de aveia leva mel.",
        "O consentimento e a privacidade na era digital.",
        "![A árvore da vida](https://a.org/arvore.png)",
        "Fechar os olhos e respirar.",
        "We use the mind to create.",
    ],
)
def test_the_text_stays(line):
    assert clean_page(f"{line}\n") == f"{line}\n"


def test_the_middle_of_a_page_is_never_touched():
    middle = "Este site usa cookies. Veja a nossa política de privacidade."
    lines = [f"linha {n}" for n in range(50)] + [middle] + [f"fim {n}" for n in range(50)]
    assert middle in clean_page("\n".join(lines))


def test_an_article_about_cookies_keeps_its_paragraphs():
    article = "# Cookies e consentimento\n\n" + "\n\n".join(
        f"Parágrafo {n}: cookies pedem consentimento e privacidade." for n in range(12)
    )
    cleaned = clean_page(article)
    assert "Parágrafo 0" in cleaned
    assert "Parágrafo 8" in cleaned
