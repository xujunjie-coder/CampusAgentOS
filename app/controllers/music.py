"""
音乐曲库 Controller（成员 D，任务2：AI 对话 @音乐播放）
- MusicSearchApiHandler  GET  /api/music/search?q=轻音乐  关键词检索（空词=热门列表）
- MusicPlayApiHandler    POST /api/music/play {"id": n}   取播放地址并计数 +1
音频文件为本地 static/music/*.wav（种子见 models/db.py _seed_music_tracks），
前端拿到 file 字段直接喂 HTML5 <audio>，全离线可播。
"""

import json

from app.controllers.base import BaseHandler
from app.models.music import MusicRepository


def _brief(row: dict) -> dict:
    return {"id": row["id"], "title": row["title"], "artist": row["artist"],
            "style": row["style"], "tags": row["tags"], "file": row["file"],
            "duration": row["duration"], "play_count": row["play_count"]}


class MusicSearchApiHandler(BaseHandler):
    def get(self):
        keyword = self.get_argument("q", "").strip()[:50]
        try:
            limit = int(self.get_argument("limit", "5"))
        except ValueError:
            limit = 5
        rows = MusicRepository.search(keyword, limit)
        self.write_json({"ok": True, "list": [_brief(r) for r in rows]})


class MusicPlayApiHandler(BaseHandler):
    def post(self):
        try:
            payload = json.loads(self.request.body.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.write_json({"ok": False, "error": "请求体必须为 JSON", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        try:
            track_id = int(payload.get("id"))
        except (TypeError, ValueError):
            self.write_json({"ok": False, "error": "id 必须为数字", "code": "BAD_REQUEST",
                             "request_id": self.request_id}, status=400)
            return
        row = MusicRepository.get(track_id)
        if not row:
            self.write_json({"ok": False, "error": "曲目不存在", "code": "NOT_FOUND",
                             "request_id": self.request_id}, status=404)
            return
        MusicRepository.bump_play(track_id)
        row["play_count"] = int(row["play_count"]) + 1
        self.write_json({"ok": True, "track": _brief(row)})
