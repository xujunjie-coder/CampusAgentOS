"""
音乐曲库 Model(Repository模式) —— 成员 D（任务2：AI 对话增强 @音乐播放）
把对 music_tracks 表的所有 SQL 收拢到 MusicRepository：
- search：按关键词匹配 标题/歌手/风格/标签（LIKE 参数化，多词空格分词取交集）
- list_all：全量列表（前端「@音乐」空关键词时展示可选曲目）
- get / bump_play：按 id 取单条、播放计数 +1
内置示例曲库为本地合成音频（static/music/），全离线可播；
接真实曲库时只需替换种子数据与 file 字段，接口契约不变。
"""

from typing import Dict, List, Optional

from app.models.db import get_connection


class MusicRepository:
    _COLS = "id, title, artist, style, tags, file, duration, play_count, created_at"

    @staticmethod
    def search(keyword: str, limit: int = 5) -> List[Dict]:
        """多关键词交集检索：每个词都要命中 标题/歌手/风格/标签 之一；空词返回热门列表"""
        words = [w for w in str(keyword or "").strip().split() if w]
        limit = max(1, min(int(limit or 5), 20))
        where, params = [], []
        for w in words:
            like = "%{}%".format(w)
            where.append("(title LIKE ? OR artist LIKE ? OR style LIKE ? OR tags LIKE ?)")
            params.extend([like, like, like, like])
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        order = "ORDER BY play_count DESC, id ASC" if not where else "ORDER BY id ASC"
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT {} FROM music_tracks {} {} LIMIT ?".format(
                    MusicRepository._COLS, clause, order),
                params + [limit]).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def list_all(limit: int = 50) -> List[Dict]:
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT {} FROM music_tracks ORDER BY id LIMIT ?".format(
                    MusicRepository._COLS), (int(limit),)).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def get(track_id: int) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT {} FROM music_tracks WHERE id = ?".format(
                    MusicRepository._COLS), (int(track_id),)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def bump_play(track_id: int) -> None:
        """播放计数：落库失败静默（不影响播放主链路）"""
        try:
            with get_connection() as conn:
                conn.execute(
                    "UPDATE music_tracks SET play_count = play_count + 1 WHERE id = ?",
                    (int(track_id),))
        except Exception:
            pass
