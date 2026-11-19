"""
健康检查（任务17）

GET /healthz —— 不要求登录、不泄露任何配置细节：
    {"ok": true, "db": "sqlite|mysql", "version": "v0.11.1"}
数据库探活失败时返回 503，供部署脚本/负载均衡使用。
"""

import json
import logging
import os

from app.controllers.base import BaseHandler
from app.models import db

logger = logging.getLogger(__name__)

_VERSION_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                             "docs", "VERSION")


def read_version() -> str:
    try:
        with open(_VERSION_FILE, encoding="utf-8") as fh:
            return fh.read().strip() or "unknown"
    except OSError:
        return "unknown"


class HealthHandler(BaseHandler):
    """探活端点：跳过登录校验与请求日志噪音"""

    def prepare(self):
        return None  # /healthz 匿名可访问

    def get(self):
        db_ok = True
        try:
            with db.get_connection() as conn:
                conn.execute("SELECT 1 AS one").fetchone()
        except Exception:
            db_ok = False
            # 详细原因只进服务端日志，响应体不带任何连接信息
            logger.exception("健康检查：数据库不可用 driver=%s", db.DB_DRIVER)

        body = {"ok": db_ok, "db": db.DB_DRIVER, "version": read_version()}
        if not db_ok:
            body["error"] = "数据库不可用"
        self.set_status(200 if db_ok else 503)
        self.set_header("Content-Type", "application/json; charset=utf-8")
        self.set_header("Cache-Control", "no-store")
        self.write(json.dumps(body, ensure_ascii=False))
