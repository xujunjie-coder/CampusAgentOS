"""Jamendo integration contracts; fake upstream, real authenticated local API."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

from conftest import ApiCase
from app.services import music_service


def upstream(**changes):
    row = {"id": "1", "name": "Test Song", "artist_name": "Artist",
           "album_name": "Album", "duration": 180,
           "audio": "https://prod-1.storage.jamendo.com/?trackid=1",
           "image": "https://usercontent.jamendo.com/?id=1",
           "license_ccurl": "http://creativecommons.org/licenses/by/3.0/"}
    row.update(changes)
    return row


class TestJamendo(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()
        key = patch("app.config.JAMENDO_CLIENT_ID", "private-test-key")
        key.start()
        self.addCleanup(key.stop)
        self.fetch_mock = AsyncMock(return_value=SimpleNamespace(code=200, body=json.dumps(
            {"headers": {"status": "success"}, "results": [upstream()]}).encode()))
        fetch = patch("app.services.music_service.AsyncHTTPClient", return_value=SimpleNamespace(fetch=self.fetch_mock))
        fetch.start()
        self.addCleanup(fetch.stop)

    def test_search_normalizes_scene_and_attribution(self):
        response = self.get_json("/api/music/search?q=%E8%BD%BB%E9%9F%B3%E4%B9%90")
        body = json.loads(response.body)
        assert body["source"] == "jamendo"
        track = body["list"][0]
        assert track["id"] == "1" and track["duration"] == 180
        assert track["artist"] == "Artist"
        assert track["license_url"].startswith("https://creativecommons.org/")
        assert track["page_url"] == "https://www.jamendo.com/track/1"
        assert b"private-test-key" not in response.body
        params = parse_qs(urlsplit(self.fetch_mock.call_args.args[0].url).query)
        assert params["tags"] == ["classical"]
        assert params["vocalinstrumental"] == ["instrumental"]

    def test_explicit_local_never_calls_upstream(self):
        response = self.get_json("/api/music/search?source=local")
        assert json.loads(response.body)["source"] == "local"
        self.fetch_mock.assert_not_called()

    def test_missing_key_fallback(self):
        with patch("app.config.JAMENDO_CLIENT_ID", ""):
            body = json.loads(self.get_json("/api/music/search").body)
        assert body["source"] == "local" and body["message"]
        self.fetch_mock.assert_not_called()

    def test_timeout_fallback(self):
        self.fetch_mock.side_effect = TimeoutError("private-test-key")
        response = self.get_json("/api/music/search")
        body = json.loads(response.body)
        assert body["source"] == "local"
        assert b"private-test-key" not in response.body

    def test_bad_key_explicit_online_is_not_silent_fallback(self):
        self.fetch_mock.return_value.body = b'{"headers":{"status":"failed","code":5}}'
        assert self.get_json("/api/music/search?source=jamendo").code == 503

    def test_empty_online_search_does_not_substitute_local_tracks(self):
        self.fetch_mock.return_value.body = b'{"headers":{"status":"success"},"results":[]}'
        body = json.loads(self.get_json("/api/music/search").body)
        assert body["source"] == "jamendo" and body["list"] == []

    def test_remote_id_does_not_increment_local_count(self):
        before = json.loads(self.get_json("/api/music/search?source=local").body)["list"]
        response = self.post_json("/api/music/play", {"id": "1", "source": "jamendo"})
        assert response.code == 200
        after = json.loads(self.get_json("/api/music/search?source=local").body)["list"]
        assert before == after

    def test_invalid_inputs(self):
        assert self.get_json("/api/music/search?source=other").code == 400
        assert self.post_json("/api/music/play", []).code == 400
        assert self.post_json("/api/music/play", {"id": -1, "source": "jamendo"}).code == 400


def test_normalize_rejects_untrusted_links_and_missing_license():
    for audio in ("javascript:alert(1)", "https://evil.test/a.mp3", "https://jamendo.com.evil.test/", "https://jamendo.com@evil.test/"):
        assert music_service.normalize(upstream(audio=audio)) is None
    assert music_service.normalize(upstream(license_ccurl="")) is None
    assert music_service.normalize(upstream(image="https://evil.test/image"))["cover"] == ""
