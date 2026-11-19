# -*- coding: utf-8 -*-
"""
app/models/settings.py —— 系统设置 Repository（key-value 通用配置存储）

成员 E：通知配置模块的数据底座，供 notify_service 读取在线配置。
设计：
- system_settings 表只有 key / value / updated_at 三列，按 key 主键幂等；
- 上层通过 SystemSettingsRepository 静态方法读写，不直接操作 SQL；
- 通知配置 key 约定前缀 "notify_"（如 notify_smtp_host、notify_mail_to），
  方便后续扩展其他系统配置不冲突。
"""

from typing import Dict, List
from app.models.db import get_connection


class SystemSettingsRepository:
    """系统设置 key-value 存储（Repository 模式，@staticmethod 调用）"""

    @staticmethod
    def get(key: str, default: str = "") -> str:
        """读取单个配置值；不存在返回 default"""
        with get_connection() as conn:
            row = conn.execute(
                "SELECT value FROM system_settings WHERE `key` = ?", (key,)).fetchone()
        return row["value"] if row else default

    @staticmethod
    def get_many(keys: List[str]) -> Dict[str, str]:
        """批量读取配置，返回 {key: value}，缺失的 key 不出现在结果中"""
        if not keys:
            return {}
        placeholders = ",".join(["?"] * len(keys))
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT `key`, value FROM system_settings WHERE `key` IN ({})".format(placeholders),
                keys).fetchall()
        return {r["key"]: r["value"] for r in rows}

    @staticmethod
    def get_all() -> Dict[str, str]:
        """返回全部配置 dict"""
        with get_connection() as conn:
            rows = conn.execute("SELECT `key`, value FROM system_settings").fetchall()
        return {r["key"]: r["value"] for r in rows}

    @staticmethod
    def set(key: str, value: str) -> None:
        """写入/更新单个配置（INSERT OR REPLACE 幂等）"""
        with get_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO system_settings (`key`, value, updated_at) "
                "VALUES (?, ?, datetime('now', 'localtime'))", (key, value))

    @staticmethod
    def set_many(data: Dict[str, str]) -> None:
        """批量写入/更新配置"""
        if not data:
            return
        with get_connection() as conn:
            for key, value in data.items():
                conn.execute(
                    "INSERT OR REPLACE INTO system_settings (`key`, value, updated_at) "
                    "VALUES (?, ?, datetime('now', 'localtime'))", (key, value))

    @staticmethod
    def delete(key: str) -> None:
        """删除单个配置（清空后回退 .env 兜底）"""
        with get_connection() as conn:
            conn.execute("DELETE FROM system_settings WHERE `key` = ?", (key,))
