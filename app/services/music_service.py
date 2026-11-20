"""Jamendo read API adapter; no SDK, audio download, or persistent remote catalog."""
import json
from urllib.parse import urlencode, urlsplit, urlunsplit

from tornado.httpclient import AsyncHTTPClient, HTTPRequest

from app import config


class MusicUnavailable(Exception):
    pass


SCENES = {
    "轻音乐": {"tags": "classical", "vocalinstrumental": "instrumental"},
    "专注": {"tags": "ambient", "vocalinstrumental": "instrumental"},
    "治愈": {"tags": "relaxation"}, "放松": {"tags": "relaxation"},
    "摇滚": {"tags": "rock"}, "电子": {"tags": "electronic"},
    "钢琴": {"tags": "piano"}, "雨声": {"search": "rain"},
    "爵士": {"tags": "jazz"}, "流行": {"tags": "pop"},
}


def trusted_url(value, domains):
    """Only accept provider URLs; upgrade their historical HTTP links to HTTPS."""
    if not isinstance(value, str):
        return ""
    try:
        p = urlsplit(value)
        host = (p.hostname or "").lower()
        if (p.scheme not in ("http", "https") or p.username or p.password
                or p.port not in (None, 80, 443)
                or not any(host == d or host.endswith("." + d) for d in domains)):
            return ""
        return urlunsplit(("https", host, p.path, p.query, ""))
    except ValueError:
        return ""


def normalize(row):
    if not isinstance(row, dict):
        return None
    track_id = str(row.get("id", ""))
    audio = trusted_url(row.get("audio"), ("jamendo.com",))
    license_url = trusted_url(row.get("license_ccurl"), ("creativecommons.org",))
    if not track_id.isdigit() or not audio or not license_url:
        return None
    try:
        duration = max(0, int(row.get("duration", 0)))
    except (ValueError, TypeError):
        duration = 0
    return {
        "id": track_id, "source": "jamendo", "title": str(row.get("name") or "未命名曲目"),
        "artist": str(row.get("artist_name") or "未知音乐人"), "style": "Jamendo",
        "tags": str(row.get("album_name") or "独立音乐"), "duration": duration,
        "file": audio, "cover": trusted_url(row.get("image") or row.get("album_image"), ("jamendo.com",)),
        "page_url": "https://www.jamendo.com/track/" + track_id,
        "license_url": license_url, "play_count": 0,
    }


async def tracks(keyword="", limit=20, track_id=None):
    if not config.JAMENDO_CLIENT_ID:
        raise MusicUnavailable("Jamendo 尚未配置，请管理员设置 JAMENDO_CLIENT_ID 并重启服务。")
    params = {"client_id": config.JAMENDO_CLIENT_ID, "format": "json",
              "limit": max(1, min(limit, 20)), "audioformat": "mp32",
              "imagesize": 200, "type": "single albumtrack"}
    if track_id is not None:
        params["id"] = track_id
    elif keyword:
        params.update(SCENES.get(keyword, {"search": keyword}))
    else:
        params["order"] = "popularity_week"
    try:
        response = await AsyncHTTPClient().fetch(HTTPRequest(
            "https://api.jamendo.com/v3.0/tracks/?" + urlencode(params),
            connect_timeout=4, request_timeout=10, follow_redirects=False), raise_error=False)
        if response.code != 200:
            raise ValueError("upstream status")
        data = json.loads(response.body)
        if not isinstance(data, dict):
            raise ValueError("upstream error")
        headers = data.get("headers")
        if not isinstance(headers, dict):
            raise ValueError("upstream headers")
        if headers.get("status") != "success":
            code = str(headers.get("code", ""))
            if code == "5":
                raise MusicUnavailable("Jamendo 应用凭据无效，请管理员检查 client_id。")
            if code == "11":
                raise MusicUnavailable("Jamendo 应用已被暂停，请管理员检查开发者平台的应用状态。")
            raise ValueError("upstream error")
        rows = data.get("results")
        if not isinstance(rows, list):
            raise ValueError("upstream schema")
        return [track for row in rows[:limit] if (track := normalize(row))]
    except MusicUnavailable:
        raise
    except Exception as exc:
        # Do not expose upstream request URLs: they contain the private client_id.
        raise MusicUnavailable("Jamendo 暂时无法连接或配置无效，请稍后重试。") from exc
