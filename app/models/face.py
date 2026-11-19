"""
人脸数据 Model（任务12）

- user_faces：一个用户可录入多张人脸（face_label 区分），UNIQUE(username, face_label) 保证幂等覆盖；
- 特征以**加密串**入库（密钥由 COOKIE_SECRET 派生），接口层永不返回原始特征向量；
- users.face_enabled 控制该账号是否允许人脸登录（录入后由用户或管理员开启）；
- 所有方法 @staticmethod，与其余 Repository 保持一致。
"""

import base64
import hashlib
import json
from typing import Dict, List, Optional

from app import config
from app.models.db import get_connection
from app.models.session import now_str

_CIPHER_PREFIX = "fernet:"
_PLAIN_PREFIX = "plain:"


def _fernet():
    """由 COOKIE_SECRET 派生固定密钥；cryptography 不可用时返回 None（降级 base64 并标注前缀）"""
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        return None
    key = base64.urlsafe_b64encode(hashlib.sha256(
        ("face:" + config.COOKIE_SECRET).encode("utf-8")).digest())
    return Fernet(key)


def encrypt_feature(vector: List[float]) -> str:
    """特征向量 → 加密串（JSON 序列化后加密，避免明文特征落库）"""
    raw = json.dumps([round(float(x), 6) for x in vector], separators=(",", ":")).encode("utf-8")
    cipher = _fernet()
    if cipher is None:
        return _PLAIN_PREFIX + base64.b64encode(raw).decode("ascii")
    return _CIPHER_PREFIX + cipher.encrypt(raw).decode("ascii")


def decrypt_feature(blob: str) -> Optional[List[float]]:
    """加密串 → 特征向量；解密失败（换过密钥/数据损坏）返回 None，由调用方跳过该条"""
    if not blob:
        return None
    try:
        if blob.startswith(_CIPHER_PREFIX):
            cipher = _fernet()
            if cipher is None:
                return None
            raw = cipher.decrypt(blob[len(_CIPHER_PREFIX):].encode("ascii"))
        elif blob.startswith(_PLAIN_PREFIX):
            raw = base64.b64decode(blob[len(_PLAIN_PREFIX):].encode("ascii"))
        else:
            return None
        return [float(x) for x in json.loads(raw.decode("utf-8"))]
    except Exception:
        return None


class FaceRepository:
    """用户人脸数据读写（不含算法，算法在 services/face_service.py）"""

    @staticmethod
    def upsert(username: str, face_label: str, feature: List[float], algo: str,
               quality: float = 0.0, enabled: int = 1) -> int:
        """录入/覆盖一张人脸（同 label 覆盖），返回记录 id"""
        label = (face_label or "default").strip()[:32] or "default"
        blob = encrypt_feature(feature)
        stamp = now_str()
        with get_connection() as conn:
            row = conn.execute(
                "SELECT id FROM user_faces WHERE username = ? AND face_label = ?",
                (username, label)).fetchone()
            if row:
                conn.execute(
                    "UPDATE user_faces SET feature = ?, feature_algo = ?, quality = ?, enabled = ?, "
                    "updated_at = ? WHERE id = ?",
                    (blob, algo, float(quality or 0), int(enabled), stamp, row["id"]))
                return row["id"]
            cur = conn.execute(
                "INSERT INTO user_faces (username, face_label, feature, feature_algo, quality, enabled) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (username, label, blob, algo, float(quality or 0), int(enabled)))
            return cur.lastrowid

    @staticmethod
    def list_by_user(username: str, only_enabled: bool = False) -> List[Dict]:
        """列出某用户的人脸记录（**不含 feature**，供接口/页面展示）"""
        sql = ("SELECT id, username, face_label, feature_algo, quality, enabled, created_at, updated_at "
               "FROM user_faces WHERE username = ?")
        if only_enabled:
            sql += " AND enabled = 1"
        sql += " ORDER BY id"
        with get_connection() as conn:
            return [dict(r) for r in conn.execute(sql, (username,)).fetchall()]

    @staticmethod
    def list_features(username: str = None) -> List[Dict]:
        """取可用于比对的记录（含解密后的特征），解密失败的记录自动跳过"""
        sql = ("SELECT id, username, face_label, feature, feature_algo, quality FROM user_faces "
               "WHERE enabled = 1")
        params = []
        if username:
            sql += " AND username = ?"
            params.append(username)
        with get_connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        out = []
        for row in rows:
            vector = decrypt_feature(row["feature"])
            if not vector:
                continue
            out.append({"id": row["id"], "username": row["username"], "label": row["face_label"],
                        "vector": vector, "algo": row["feature_algo"], "quality": row["quality"]})
        return out

    @staticmethod
    def get_by_id(face_id: int) -> Optional[Dict]:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT id, username, face_label, feature_algo, quality, enabled, created_at, updated_at "
                "FROM user_faces WHERE id = ?", (face_id,)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def delete(face_id: int, username: str = None) -> bool:
        """删除一张人脸；传 username 时校验归属（前台只能删自己的）"""
        sql = "DELETE FROM user_faces WHERE id = ?"
        params = [int(face_id)]
        if username:
            sql += " AND username = ?"
            params.append(username)
        with get_connection() as conn:
            cur = conn.execute(sql, params)
        return cur.rowcount > 0

    @staticmethod
    def clear(username: str) -> int:
        """清空某用户全部人脸（重置/删除用户时调用）"""
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM user_faces WHERE username = ?", (username,))
        return cur.rowcount

    @staticmethod
    def count(username: str) -> int:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM user_faces WHERE username = ?", (username,)).fetchone()
        return int(row["c"]) if row else 0

    @staticmethod
    def has_enabled(username: str) -> bool:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM user_faces WHERE username = ? AND enabled = 1",
                (username,)).fetchone()
        return bool(row and row["c"])
