"""Music search: Jamendo first, explicit local fallback; source-aware track lookup.

GET /api/music/search?q=...&source=auto|jamendo|local
POST /api/music/play {id, source}: only local tracks increment the local counter.
"""

import json

from app.controllers.base import BaseHandler
from app.models.music import MusicRepository
from app.services import music_service


def _brief(row: dict) -> dict:
    return {"id": row["id"], "title": row["title"], "artist": row["artist"],
            "style": row["style"], "tags": row["tags"], "file": row["file"],
            "duration": row["duration"], "play_count": row["play_count"], "source": "local"}


class MusicSearchApiHandler(BaseHandler):
    async def get(self):
        keyword = self.get_argument("q", "").strip()[:50]
        try:
            limit = int(self.get_argument("limit", "5"))
        except ValueError:
            limit = 5
        limit = max(1, min(limit, 20))
        source = self.get_argument("source", "auto")
        if source not in ("auto", "local", "jamendo"):
            self.write_json({"ok": False, "error": "不支持的曲库来源"}, status=400)
            return
        message = ""
        if source != "local":
            try:
                rows = await music_service.tracks(keyword, limit)
                self.write_json({"ok": True, "source": "jamendo", "list": rows})
                return
            except music_service.MusicUnavailable as exc:
                message = str(exc)
                if source == "jamendo":
                    self.write_json({"ok": False, "error": message}, status=503)
                    return
        rows = MusicRepository.search(keyword, limit)
        if message:
            message += " 当前展示本地示例曲库。"
        self.write_json({"ok": True, "source": "local", "message": message,
                         "list": [_brief(r) for r in rows]})


class MusicPlayApiHandler(BaseHandler):
    async def post(self):
        try:
            payload = json.loads(self.request.body.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.write_json({"ok": False, "error": "请求体必须为 JSON", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        if not isinstance(payload, dict):
            self.write_json({"ok": False, "error": "请求体必须为对象"}, status=400)
            return
        source = payload.get("source", "local")
        if source not in ("local", "jamendo"):
            self.write_json({"ok": False, "error": "不支持的曲库来源"}, status=400)
            return
        try:
            track_id = int(payload.get("id"))
        except (TypeError, ValueError):
            self.write_json({"ok": False, "error": "id 必须为数字", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        if source == "jamendo":
            if track_id <= 0:
                self.write_json({"ok": False, "error": "无效的曲目 ID"}, status=400)
                return
            try:
                rows = await music_service.tracks(limit=1, track_id=track_id)
            except music_service.MusicUnavailable as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=503)
                return
            track = next((r for r in rows if r["id"] == str(track_id)), None)
            self.write_json({"ok": bool(track), "track": track}, status=200 if track else 404)
            return
        row = MusicRepository.get(track_id)
        if not row:
            self.write_json({"ok": False, "error": "曲目不存在", "code": "NOT_FOUND",
                             "request_id": self.request_id}, status=404)
            return
        MusicRepository.bump_play(track_id)
        row["play_count"] = int(row["play_count"]) + 1
        self.write_json({"ok": True, "track": _brief(row)})
