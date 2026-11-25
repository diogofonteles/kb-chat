"""A recording that is a file: never from inside the owner's network, whatever the address says."""

import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from transcriber import doc_ingest, recording_file
from transcriber.doc_ingest import DocIngestFailed, YtDlp
from transcriber.known_links import known_address
from transcriber.recording_file import (
    NotARecording,
    TooLarge,
    fetch_file,
    led_to,
    public_address,
)

PUBLIC = "93.184.216.34"


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.5", "192.168.0.1", "169.254.169.254", "::1", "fe80::1", "0.0.0.0"],  # noqa: S104
)
def test_an_address_of_the_owners_network_is_refused(address):
    with pytest.raises(NotARecording, match="not a public address"):
        public_address("x.example", lambda _host: [PUBLIC, address])


def test_yt_dlp_never_gets_an_address_of_another_site(tmp_path, monkeypatch):
    monkeypatch.setattr(YtDlp, "_run", lambda *_args: pytest.fail("yt-dlp was run"))
    monkeypatch.setattr(recording_file.socket, "getaddrinfo", fake_dns("127.0.0.1"))
    for url in ("http://127.0.0.1.nip.io:3000/x.mp3", "https://roteador.local/a.mp4"):
        with pytest.raises(DocIngestFailed, match="not a public address"):
            YtDlp().download(url, tmp_path)
    # Nor a known site's page that forwards: it is fetched here, where each hop is checked.
    with pytest.raises(DocIngestFailed, match="not a public address"):
        YtDlp().download("https://www.youtube.com/redirect/videos?q=http%3A%2F%2Fx", tmp_path)
    for url in ("https://a.org/playlist", "https://www.youtube.com/redirect?q=http%3A%2F%2Fx"):
        with pytest.raises(DocIngestFailed, match="known site"):
            YtDlp().entries(url)


def fake_dns(address):
    return lambda host, *_args, **_kwargs: [(2, 1, 6, "", (address, 0))]


# Where an address leads, instead of answering.
SENT = {
    "/away": "http://interno.example/a.mp3",
    "/abc": "/meio",
    "/meio": "https://www.facebook.com/watch/?v=12&ref=sharing",
    "/apagado": "https://www.facebook.com/watch/",
    "/interno": "http://interno.example/admin",
    "/roda": "/roda",
}


class Site(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ID3 som"
        if self.path.endswith("corta.mp3"):
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", "1000000")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.endswith("pinga.mp3"):
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.end_headers()
            for _ in range(40):
                self.wfile.write(b"x")
                self.wfile.flush()
                time.sleep(0.05)
            return
        if self.path.endswith("cabecalho.mp3"):
            for one in b"HTTP/1.1 200 OK\r\nX-Lento: " + b"a" * 60:
                try:
                    self.wfile.write(bytes([one]))
                    self.wfile.flush()
                except OSError:
                    return
                time.sleep(0.05)
            return
        if self.path.endswith("pedaco.mp3"):
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for _ in range(60):
                try:
                    self.wfile.write(b"0")
                    self.wfile.flush()
                except OSError:
                    return
                time.sleep(0.05)
            return
        if self.path.endswith("vazio.mp3"):
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path in SENT:
            self.send_response(302)
            self.send_header("Location", SENT[self.path])
            self.end_headers()
            return
        if self.path == "/acento":
            self.send_response_only(302)
            self.flush_headers()
            self.wfile.write("Location: /coração.mp3\r\n\r\n".encode())
            return
        kind = "text/html" if self.path.endswith("pagina.mp3") else "audio/mpeg"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        size = str(3 * 1024**3) if self.path.endswith("grande.mp3") else str(len(body))
        self.send_header("Content-Length", size)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@pytest.fixture
def site(monkeypatch):
    """A site of this machine, reached as if its (checked) address were a public one."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    real = recording_file.socket.create_connection
    monkeypatch.setattr(
        recording_file.socket,
        "create_connection",
        lambda where, timeout=None, source=None: real(server.server_address, timeout),
    )
    yield
    server.shutdown()


def names(**hosts):
    return lambda host: [hosts[host.split(".")[0]]]


def test_a_public_file_is_fetched_under_its_own_name(site, tmp_path):
    found = fetch_file("http://podcast.example/ep%2001.mp3", tmp_path, names(podcast=PUBLIC))
    assert found.name == "ep 01.mp3"
    assert found.read_bytes() == b"ID3 som"


def test_a_redirect_into_the_network_is_refused(site, tmp_path):
    resolving = names(podcast=PUBLIC, interno="192.168.0.1")
    with pytest.raises(NotARecording, match="not a public address"):
        fetch_file("http://podcast.example/away", tmp_path, resolving)


def test_what_is_not_a_recording_or_is_too_large_says_so(site, tmp_path):
    resolving = names(podcast=PUBLIC)
    with pytest.raises(NotARecording, match="text/html"):
        fetch_file("http://podcast.example/pagina.mp3", tmp_path, resolving)
    with pytest.raises(TooLarge):
        fetch_file("http://podcast.example/grande.mp3", tmp_path, resolving)
    # No name of its own, but the site says what it is.
    assert fetch_file("http://podcast.example/arquivo", tmp_path, resolving).name == "arquivo.mp3"
    with pytest.raises(NotARecording, match="port"):
        fetch_file("http://podcast.example:8080/a.mp3", tmp_path, resolving)


def test_a_recording_cut_half_way_is_not_the_whole(site, tmp_path):
    with pytest.raises(NotARecording, match="only 7 of 1000000 bytes"):
        fetch_file("http://podcast.example/corta.mp3", tmp_path, names(podcast=PUBLIC))


def test_a_server_that_drips_meets_the_deadline(site, tmp_path, monkeypatch):
    monkeypatch.setattr(recording_file, "DEADLINE_S", 0.3)
    started = time.monotonic()
    with pytest.raises(NotARecording, match="too long"):
        fetch_file("http://podcast.example/pinga.mp3", tmp_path, names(podcast=PUBLIC))
    assert time.monotonic() - started < 1.5


def test_an_address_as_typed_works_and_a_broken_one_is_refused(site, tmp_path):
    resolving = names(podcast=PUBLIC)
    found = fetch_file("http://podcast.example/palestra coração.mp3?a=é", tmp_path, resolving)
    assert found.name == "palestra coração.mp3"
    for url in ("http://podcast.example:99999/a.mp3", "http://[bad/a.mp3"):
        with pytest.raises((NotARecording, ValueError)):
            fetch_file(url, tmp_path, resolving)
    # A name with what no file system takes.
    strange = fetch_file("http://podcast.example/a%00%2Fb.mp3", tmp_path, resolving)
    assert strange.parent == tmp_path


@pytest.mark.parametrize("path", ["cabecalho.mp3", "pedaco.mp3"])
def test_headers_or_part_sizes_that_drip_meet_the_deadline_too(site, tmp_path, monkeypatch, path):
    monkeypatch.setattr(recording_file, "DEADLINE_S", 0.3)
    started = time.monotonic()
    with pytest.raises(NotARecording, match="too long"):
        fetch_file(f"http://podcast.example/{path}", tmp_path, names(podcast=PUBLIC))
    assert time.monotonic() - started < 1.5


def test_an_empty_file_is_no_recording(site, tmp_path):
    with pytest.raises(NotARecording, match="empty"):
        fetch_file("http://podcast.example/vazio.mp3", tmp_path, names(podcast=PUBLIC))


def test_a_redirect_with_accents_goes_where_it_says(site, tmp_path):
    found = fetch_file("http://podcast.example/acento", tmp_path, names(podcast=PUBLIC))
    assert found.name == "coração.mp3"


def test_the_file_takes_the_title_that_is_known(site, tmp_path):
    found = fetch_file(
        "http://podcast.example/e.mp3", tmp_path, names(podcast=PUBLIC), title="Parte 1/2: começo"
    )
    assert found.name == "Parte 12: começo.mp3"


@pytest.mark.parametrize(
    "address", ["fec0::1", "64:ff9b::7f00:1", "64:ff9b::c0a8:1", "::ffff:10.0.0.1"]
)
def test_a_private_address_inside_another_is_refused(address):
    with pytest.raises(NotARecording, match="not a public address"):
        public_address("x.example", lambda _host: [address])


def test_a_share_buttons_address_gives_the_recordings_own(site):
    to = names(fb=PUBLIC, www=PUBLIC, interno="192.168.0.1")
    assert led_to("http://fb.watch/abc", known_address, to) == "https://www.facebook.com/watch?v=12"
    assert led_to("http://fb.watch/ep.mp3", known_address, to) is None
    assert led_to("http://fb.watch/roda", known_address, to) is None
    # Into the owner's network, it is not followed.
    with pytest.raises(NotARecording, match="not a public address"):
        led_to("http://fb.watch/interno", known_address, to)


def test_a_share_buttons_address_is_followed_before_yt_dlp(tmp_path, monkeypatch):
    given = []

    def run(command, _timeout):
        given.append(command[-1])
        (tmp_path / "Aula [x].m4a").write_bytes(b"m4a")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(YtDlp, "_run", staticmethod(run))
    leads = {"https://fb.watch/abc": "https://www.facebook.com/watch?v=12"}
    monkeypatch.setattr(doc_ingest, "led_to", lambda url, _known: leads.get(url))
    YtDlp().download("https://fb.watch/abc", tmp_path)
    assert given == ["https://www.facebook.com/watch?v=12"]
    with pytest.raises(DocIngestFailed, match="where this link leads"):
        YtDlp().download("https://fb.watch/outro", tmp_path)
    assert len(given) == 1
