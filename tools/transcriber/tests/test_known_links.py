"""What yt-dlp may be given: a recording's or a list's own address, and nothing else."""

import pytest

from transcriber.known_links import is_short, known_address


@pytest.mark.parametrize(
    ("url", "address"),
    [
        ("http://www.youtube.com/watch?v=a-B_1&t=3s#x", "https://www.youtube.com/watch?v=a-B_1"),
        ("https://M.YouTube.com/watch/?list=PL1&v=ab", "https://m.youtube.com/watch?v=ab"),
        ("https://youtu.be/ab?si=x", "https://youtu.be/ab"),
        ("https://youtube.com/shorts/ab/", "https://youtube.com/shorts/ab"),
        ("https://www.youtube.com/@canal/videos?x=1", "https://www.youtube.com/@canal/videos"),
        ("https://www.youtube.com/playlist?list=PL1", "https://www.youtube.com/playlist?list=PL1"),
        # Vimeo's own pages ask for an account; its player does not.
        ("https://vimeo.com/123", "https://player.vimeo.com/video/123"),
        ("https://vimeo.com/123/abc", "https://player.vimeo.com/video/123?h=abc"),
        ("https://vimeo.com/channels/x/123", "https://player.vimeo.com/video/123"),
        ("https://vimeo.com/groups/x/videos/123", "https://player.vimeo.com/video/123"),
        ("https://player.vimeo.com/video/3?h=a&b=c", "https://player.vimeo.com/video/3?h=a"),
        ("https://vimeo.com/showcase/123", "https://vimeo.com/showcase/123"),
        ("https://www.instagram.com/p/Ab-1/?igsh=x", "https://www.instagram.com/p/Ab-1"),
        ("https://www.facebook.com/reel/12?x=1", "https://www.facebook.com/reel/12"),
        ("https://m.facebook.com/watch/?ref=a&v=12", "https://m.facebook.com/watch?v=12"),
        ("https://www.facebook.com/a/videos/b/12/", "https://www.facebook.com/a/videos/b/12"),
        ("https://soundcloud.com/a/b?in=c", "https://soundcloud.com/a/b"),
        ("https://soundcloud.com/a/sets/b", "https://soundcloud.com/a/sets/b"),
        (
            "https://podcasts.apple.com/br/podcast/x/id1?l=pt&i=2",
            "https://podcasts.apple.com/br/podcast/x/id1?i=2",
        ),
        ("http://archive.org/details/x/1.mp3", "https://archive.org/details/x/1.mp3"),
        # The port and the name before the host go nowhere.
        ("http://eu:eu@youtu.be:8080/ab", "https://youtu.be/ab"),
    ],
)
def test_the_address_is_written_again_from_what_tells_the_recording(url, address):
    assert known_address(url) == address


@pytest.mark.parametrize(
    "url",
    [
        # QA N-2: each of these forwards, or is read by an extractor and forwards.
        "http://l.facebook.com/l.php?u=http%3A%2F%2F127.0.0.1%2Fx&h=AT0#!/x/videos/123",
        "https://www.facebook.com/l.php?u=http%3A%2F%2F127.0.0.1%2F#!/x/videos/123",
        "https://www.facebook.com/flx/warn/?u=http%3A%2F%2F127.0.0.1%2F",
        "https://www.facebook.com/plugins/video.php?href=http%3A%2F%2F127.0.0.1%2F",
        "https://www.youtube.com/redirect?q=http%3A%2F%2F127.0.0.1%2F",
        "https://www.youtube.com/redirect/videos?q=http%3A%2F%2F127.0.0.1%2F",
        "https://consent.youtube.com/m?continue=http%3A%2F%2F127.0.0.1%2Fa.mp4",
        "https://w.soundcloud.com/player/?url=http%3A%2F%2F127.0.0.1%2F",
        "https://web.archive.org/web/2020/http://127.0.0.1/",
        "https://archive.org/wayback/available?url=127.0.0.1",
        "https://archive.org/details/../../x",
        "https://archive.org/details/%2e%2e/x",
        "https://archive.org/details/a%2f..%2f..%2fx",
        "https://www.youtube.com/watch?v=a%26b%3Dc",
        "https://www.youtube.com/watch?v=",
        "https://www.facebook.com/watch/",
        "https://notyoutube.com/watch?v=ab",
        "https://youtube.com.evil.org/watch?v=ab",
        "https://vimeo.com/ondemand/x",
        "https://fb.watch/ab-1/",
        "ytsearch:hermetismo",
        "file:///etc/passwd",
        "http://[broken/",
        "não é um endereço",
    ],
)
def test_any_other_address_is_none_of_yt_dlps(url):
    assert known_address(url) is None


@pytest.mark.parametrize(
    "url",
    [
        "https://fb.watch/ab-1/",
        "https://www.facebook.com/share/v/1AbC/",
        "https://m.facebook.com/share/r/1AbC",
        "https://www.instagram.com/share/reel/BAbc/",
    ],
)
def test_what_a_share_button_gives_only_says_where_the_recording_is(url):
    assert is_short(url)
    assert known_address(url) is None


def test_a_recordings_own_address_is_not_short():
    assert not is_short("https://www.instagram.com/reel/Cabc/")
    assert not is_short("https://www.facebook.com/pessoa/share/v/1")
