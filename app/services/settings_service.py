"""
系统设置服务（任务三：系统管理模块，成员 C）

职责边界：
- 存储：`system_settings` 表（key-value，成员 A/D 已建表，SystemSettingsRepository 读写），
  不新增表、不手改数据库文件；
- 生效：品牌类（系统名称/图标）通过 BaseHandler.render 注入模板，改完下一请求即时生效；
  运行参数（人脸引擎/阈值/登录策略）写回 `.env` 并调用 config.reload + db.reload_settings，
  当次进程内即时生效；数据库驱动切换需要先做连通性测试，失败自动回滚到原驱动；
- 安全：数据库密码只写 `.env`（与项目既有密钥同处），**不落 system_settings**，
  接口返回时统一掩码；图标上传只接受 png/jpeg/webp/svg 且限 64 KB，文件名随机化，
  避免路径穿越与可执行内容。

对外只暴露函数，不持有 Handler 依赖，便于测试直接调用。
"""

import base64
import binascii
import os
import re
import struct
import time
import uuid
from typing import Dict, Optional

from app import config
from app.models import db as db_module
from app.models.settings import SystemSettingsRepository

# 项目根目录（app/services/../..），用于定位 .env 与静态上传目录
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_ENV_PATH = os.path.join(_BASE_DIR, ".env")
BRAND_DIR = os.path.join(_BASE_DIR, "app", "static", "uploads", "brand")
BRAND_URL_PREFIX = "/static/uploads/brand/"

# 允许写入 system_settings 的键（白名单，防止接口被当成任意配置写入口）
DEFAULTS = {
    "site_name": "数据瞭望",
    "site_subtitle": "政务数据智能平台",
    "site_logo": "",
    "site_favicon": "",
    "ui_watermark": "1",
    "dashboard_refresh": "10",
    "tts_voice": "",
    "tts_rate": "1.05",
    "tts_autoplay": "1",
    "asr_enabled": "1",
    "face_engine": "auto",
    "face_threshold": "0.35",
    "session_ttl_hours": "12",
    "login_max_fails": "5",
    "login_lock_minutes": "10",
    "audit_keep_days": "30",
}

# 页面分组：设置页按卡片分区提交，接口按组校验
GROUPS = {
    "brand": ["site_name", "site_subtitle", "site_logo", "site_favicon", "ui_watermark",
              "dashboard_refresh"],
    "voice": ["tts_voice", "tts_rate", "tts_autoplay", "asr_enabled", "face_engine",
              "face_threshold"],
    "security": ["session_ttl_hours", "login_max_fails", "login_lock_minutes", "audit_keep_days"],
    "db": [],
}

# 与 .env 同名的运行参数：保存后写回 .env，保证重启后仍然生效
_ENV_KEYS = {
    "face_engine": "FACE_ENGINE",
    "face_threshold": "FACE_THRESHOLD",
    "session_ttl_hours": "SESSION_TTL_HOURS",
    "login_max_fails": "LOGIN_MAX_FAILS",
    "login_lock_minutes": "LOGIN_LOCK_MINUTES",
}

_DB_ENV_KEYS = ("DB_DRIVER", "DB_PATH", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD",
                "DB_NAME", "DB_CHARSET")

_brand_cache = {"ts": 0.0, "data": None}
_BRAND_TTL = 20.0


class SettingsError(Exception):
    """设置相关的可读错误（控制器转成 400 + 中文原因）"""


# ==================== 读取 ====================

def branding(force: bool = False) -> Dict[str, str]:
    """品牌信息（名称/副标题/图标），20 秒缓存，避免每请求一次 DB 查询"""
    now = time.time()
    if not force and _brand_cache["data"] is not None and now - _brand_cache["ts"] < _BRAND_TTL:
        return _brand_cache["data"]
    stored = SystemSettingsRepository.get_many(list(DEFAULTS.keys())) or {}
    data = {key: str(stored.get(key, DEFAULTS[key]) or DEFAULTS[key]) for key in DEFAULTS}
    data["site_name"] = (data.get("site_name") or DEFAULTS["site_name"]).strip()
    _brand_cache["data"] = data
    _brand_cache["ts"] = now
    return data


def invalidate_cache() -> None:
    _brand_cache["data"] = None
    _brand_cache["ts"] = 0.0


def database_status() -> Dict:
    """当前数据库驱动的目标与连通性（只读探活，不抛异常）"""
    driver = config.DB_DRIVER
    if driver == "mysql":
        target = "%s@%s:%s/%s" % (config.DB_USER, config.DB_HOST, config.DB_PORT, config.DB_NAME)
    else:
        target = config.DB_PATH
    status = {"driver": driver, "label": "MySQL" if driver == "mysql" else "SQLite",
              "target": target, "ok": False, "error": ""}
    try:
        with db_module.get_connection() as conn:
            conn.execute("SELECT 1")
        status["ok"] = True
    except Exception as exc:  # 连接失败只报可读原因，不把堆栈返回前端
        status["error"] = str(exc)[:180]
    return status


def mysql_params() -> Dict:
    """当前 MySQL 连接参数（密码掩码，供设置页回显）"""
    return {
        "host": config.DB_HOST,
        "port": config.DB_PORT,
        "user": config.DB_USER,
        "password": "******" if config.DB_PASSWORD else "",
        "name": config.DB_NAME,
        "charset": config.DB_CHARSET,
        "has_password": bool(config.DB_PASSWORD),
    }


def load_all() -> Dict:
    """设置页所需的全部数据：分组键值 + 运行状态 + 默认值"""
    values = branding(force=True)
    for key in DEFAULTS:
        values.setdefault(key, DEFAULTS[key])
    return {
        "values": {key: values.get(key, DEFAULTS[key]) for key in DEFAULTS},
        "defaults": DEFAULTS,
        "groups": GROUPS,
        "database": database_status(),
        "mysql": mysql_params(),
        "drivers": [{"code": d, "label": "SQLite（默认，零配置）" if d == "sqlite" else "MySQL"}
                    for d in config.DB_DRIVERS],
        "face_engines": [{"code": e, "label": {"auto": "自动（优先 ONNX，缺失则降级）",
                                               "onnx": "ONNX 真实模型",
                                               "fallback": "轻量降级后端"}[e]}
                         for e in config.FACE_ENGINES],
        "env_path": os.path.relpath(_ENV_PATH, _BASE_DIR),
    }


# ==================== 校验 ====================

def _to_int(key: str, raw, low: int, high: int) -> str:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        raise SettingsError("%s 需要整数" % key)
    if value < low or value > high:
        raise SettingsError("%s 需在 %d~%d 之间" % (key, low, high))
    return str(value)


def _to_float(key: str, raw, low: float, high: float) -> str:
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        raise SettingsError("%s 需要数字" % key)
    if value < low or value > high:
        raise SettingsError("%s 需在 %.1f~%.1f 之间" % (key, low, high))
    return "%.2f" % value


_SITE_NAME_RE = re.compile(r"^[^\s<>\"'\\]{1,48}$")
_SITE_SUB_RE = re.compile(r"^[^\n<>]{0,64}$")
_TTS_VOICE_RE = re.compile(r"^[\w\s\-\.\u4e00-\u9fa5:]{0,64}$")


def _clean_text(key: str, raw) -> str:
    text = str(raw or "").strip()
    if key == "site_name":
        if not _SITE_NAME_RE.match(text):
            raise SettingsError("系统名称需为 1~48 字，且不能包含空白、尖括号或引号")
        return text
    if key == "site_subtitle":
        if not _SITE_SUB_RE.match(text):
            raise SettingsError("副标题最多 64 字，且不能换行或包含尖括号")
        return text
    if key == "tts_voice":
        if not _TTS_VOICE_RE.match(text):
            raise SettingsError("语音名称含非法字符")
        return text
    if key in ("site_logo", "site_favicon"):
        if text and not text.startswith(BRAND_URL_PREFIX):
            raise SettingsError("图标只接受本系统上传的静态资源")
        return text
    raise SettingsError("未知配置项：%s" % key)


def _validate_bool(key: str, raw) -> str:
    text = str(raw).strip().lower()
    if text in ("1", "0"):
        return text
    if text in ("true", "on", "yes"):
        return "1"
    if text in ("false", "off", "no"):
        return "0"
    raise SettingsError("%s 只能是开或关" % key)


def _validate_one(key: str, raw) -> str:
    if key not in DEFAULTS:
        raise SettingsError("不允许写入的配置项：%s" % key)
    if key in ("site_name", "site_subtitle", "site_logo", "site_favicon", "tts_voice"):
        return _clean_text(key, raw)
    if key in ("ui_watermark", "tts_autoplay", "asr_enabled"):
        return _validate_bool(key, raw)
    if key == "dashboard_refresh":
        return _to_int(key, raw, 5, 120)
    if key == "tts_rate":
        return _to_float(key, raw, 0.5, 2.5)
    if key == "face_engine":
        value = str(raw or "").strip()
        if value not in config.FACE_ENGINES:
            raise SettingsError("人脸引擎只能是 %s" % " / ".join(config.FACE_ENGINES))
        return value
    if key == "face_threshold":
        return _to_float(key, raw, 0.2, 0.9)
    if key == "session_ttl_hours":
        return _to_int(key, raw, 1, 24 * 365)
    if key == "login_max_fails":
        return _to_int(key, raw, 1, 100)
    if key == "login_lock_minutes":
        return _to_int(key, raw, 0, 24 * 60)
    if key == "audit_keep_days":
        return _to_int(key, raw, 1, 365)
    raise SettingsError("未知配置项：%s" % key)


# ==================== 保存 ====================

def save(group: str, payload: Dict, actor: str = "") -> Dict:
    """按分组保存配置：白名单 + 分组校验 + 运行参数热生效，返回生效后的全量值"""
    if group not in GROUPS:
        raise SettingsError("未知的设置分组：%s" % group)
    allowed = GROUPS[group]
    unknown = [k for k in payload if k not in allowed]
    if unknown:
        raise SettingsError("该分组不接受配置项：%s" % "、".join(unknown))
    if not payload:
        raise SettingsError("没有需要保存的配置项")

    normalized = {key: _validate_one(key, value) for key, value in payload.items()}
    SystemSettingsRepository.set_many(normalized)
    invalidate_cache()

    # 运行参数写回 .env 并热重载（strict=False：避免历史遗留的其它非法项阻断保存）
    env_patch = {_ENV_KEYS[key]: value for key, value in normalized.items() if key in _ENV_KEYS}
    if env_patch:
        _write_env(env_patch)
        os.environ.update(env_patch)
        try:
            config.reload(strict=False)
            db_module.reload_settings()
        except Exception:
            pass

    return {"saved": normalized, "values": load_all()["values"], "actor": actor}


# ==================== 图标上传 ====================

_IMAGE_SIGNATURES = {
    b"\x89PNG\r\n\x1a\n": "png",
    b"\xff\xd8\xff": "jpg",
    b"GIF89a": "gif",
    b"GIF87a": "gif",
}


def _detect_image(data: bytes) -> Optional[str]:
    for sig, ext in _IMAGE_SIGNATURES.items():
        if data.startswith(sig):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    head = data.lstrip()[:200].lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in head):
        return "svg"
    return None


def save_brand_image(kind: str, data_uri: str) -> Dict:
    """保存系统图标：data URI → 静态文件，返回可直接用于 <img>/<link> 的 URL

    只接受 png/jpeg/gif/webp/svg，≤ 64 KB；文件名随机，扩展名由真实字节判定，
    不信任客户端给的 MIME / 文件名，避免上传可执行文件或路径穿越。
    """
    if kind not in ("logo", "favicon"):
        raise SettingsError("图标类型只能是 logo 或 favicon")
    if not data_uri or "," not in data_uri:
        raise SettingsError("请选择图片文件")
    header, _, b64 = data_uri.partition(",")
    if not header.startswith("data:image/"):
        raise SettingsError("只支持图片格式")
    try:
        raw = base64.b64decode(b64)
    except (binascii.Error, ValueError):
        raise SettingsError("图片数据损坏，请重新选择")
    if len(raw) > 64 * 1024:
        raise SettingsError("图片不能超过 64 KB")
    ext = _detect_image(raw)
    if not ext:
        raise SettingsError("无法识别的图片格式（支持 png/jpg/gif/webp/svg）")
    os.makedirs(BRAND_DIR, exist_ok=True)
    name = "%s-%s.%s" % (kind, uuid.uuid4().hex[:12], ext)
    path = os.path.join(BRAND_DIR, name)
    with open(path, "wb") as fh:
        fh.write(raw)
    url = BRAND_URL_PREFIX + name
    SystemSettingsRepository.set("site_logo" if kind == "logo" else "site_favicon", url)
    invalidate_cache()
    return {"url": url, "kind": kind, "size": len(raw), "ext": ext}


# ==================== 数据库切换 ====================

def test_database(driver: str, params: Optional[Dict] = None) -> Dict:
    """连通性测试：sqlite 校验目录可写，mysql 真实建连并取版本号"""
    if driver == "sqlite":
        path = (params or {}).get("path") or config.DB_PATH
        directory = os.path.dirname(os.path.abspath(path)) or "."
        if not os.path.isdir(directory):
            raise SettingsError("SQLite 目录不存在：%s" % directory)
        probe = os.path.join(directory, ".write-probe-%s" % uuid.uuid4().hex[:8])
        try:
            with open(probe, "w", encoding="utf-8") as fh:
                fh.write("ok")
            os.remove(probe)
        except OSError as exc:
            raise SettingsError("SQLite 目录不可写：%s" % exc)
        return {"driver": "sqlite", "ok": True, "detail": "目录可写，数据库文件：%s" % path,
                "version": "SQLite"}

    if driver != "mysql":
        raise SettingsError("未知数据库驱动：%s" % driver)
    try:
        import pymysql  # 延迟导入：默认 sqlite 部署无需该依赖
    except ImportError:
        raise SettingsError("未安装 PyMySQL，请先执行：python -m pip install pymysql")

    p = dict(params or {})
    host = str(p.get("host") or "127.0.0.1").strip()
    try:
        port = int(p.get("port") or 3306)
    except (TypeError, ValueError):
        raise SettingsError("端口需为整数")
    user = str(p.get("user") or "root").strip()
    password = str(p.get("password") or "")
    if not password or password.startswith("****"):
        # 前端回显的是掩码 / 留空表示"沿用当前密码"，不能用掩码去连库
        password = config.DB_PASSWORD
    name = str(p.get("name") or "").strip()
    charset = str(p.get("charset") or "utf8mb4").strip()
    if not name or not re.match(r"^[A-Za-z0-9_\-]{1,64}$", name):
        raise SettingsError("数据库名需为字母/数字/下划线，1~64 位")

    try:
        conn = pymysql.connect(host=host, port=port, user=user, password=password,
                               database=name, charset=charset, connect_timeout=5,
                               autocommit=True)
    except Exception as exc:
        code = exc.args[0] if exc.args else ""
        if code == 1049:
            raise SettingsError("目标库 %s 不存在，请先在 MySQL 中创建" % name)
        if code == 1045:
            raise SettingsError("MySQL 账号或密码错误")
        raise SettingsError("MySQL 连接失败：%s" % str(exc)[:160])
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT VERSION()")
            version = (cur.fetchone() or ["?"])[0]
    finally:
        conn.close()
    return {"driver": "mysql", "ok": True, "version": "MySQL %s" % version,
            "detail": "已连接 %s@%s:%s/%s" % (user, host, port, name)}


def switch_database(driver: str, params: Optional[Dict], actor: str = "") -> Dict:
    """切换数据库驱动（先测通再切，任何一步失败都回滚到原驱动）

    切换成功后会调用 init_db() 在目标库建表；目标库为空属于**预期行为**，
    数据不会自动迁移，页面上必须提示"切换后需重新采集/导入，切回 SQLite 数据仍在"。
    """
    if driver not in config.DB_DRIVERS:
        raise SettingsError("未知数据库驱动：%s" % driver)
    if driver == config.DB_DRIVER and driver == "sqlite":
        raise SettingsError("当前已是 SQLite，无需切换")

    test_database(driver, params)

    old_env = {key: os.environ.get(key) for key in _DB_ENV_KEYS}
    patch = dict((k, v) for k, v in (params or {}).items() if k)
    new_env = {"DB_DRIVER": driver}
    password = str(patch.get("password") or "")
    if not password or password.startswith("****"):
        password = config.DB_PASSWORD
    if driver == "mysql":
        new_env.update({
            "DB_HOST": str(patch.get("host") or config.DB_HOST),
            "DB_PORT": str(int(patch.get("port") or 3306)),
            "DB_USER": str(patch.get("user") or config.DB_USER),
            "DB_PASSWORD": password,
            "DB_NAME": str(patch.get("name") or config.DB_NAME),
            "DB_CHARSET": str(patch.get("charset") or "utf8mb4"),
        })
    else:
        new_env["DB_PATH"] = str(patch.get("path") or config.DB_PATH)

    try:
        os.environ.update(new_env)
        config.reload(strict=True)
        db_module.reload_settings()
        db_module.init_db()
        _write_env(new_env)
    except Exception as exc:
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        try:
            config.reload(strict=False)
            db_module.reload_settings()
        except Exception:
            pass
        invalidate_cache()
        raise SettingsError("切换失败，已回滚到原数据库：%s" % str(exc)[:160])

    # 目标库是全新的 system_settings 表：把品牌信息补写回去，避免切库后名称/图标"丢配置"
    saved = {"db_driver": driver}
    try:
        for key in ("site_name", "site_subtitle", "site_logo", "site_favicon", "ui_watermark",
                    "dashboard_refresh"):
            SystemSettingsRepository.set(key, branding().get(key, DEFAULTS[key]))
    except Exception:
        pass
    invalidate_cache()
    return {"driver": driver, "database": database_status(), "saved": saved,
            "note": "切换已生效；目标库为空表结构，历史数据不会自动迁移"}


# ==================== .env 写回 ====================

_ENV_LINE_RE = None


def _write_env(patch: Dict[str, str]) -> None:
    """把配置写回 .env（保留注释与顺序，仅替换同名键；缺失键追加到文件末尾）

    写入走临时文件 + os.replace，避免写一半被进程读到；这是本机文件，不做跨平台锁。
    """
    if not patch:
        return
    keys = set(patch)
    lines = []
    if os.path.exists(_ENV_PATH):
        with open(_ENV_PATH, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    replaced = set()
    out = []
    pattern = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")
    for line in lines:
        match = pattern.match(line)
        if match and match.group(1) in keys:
            key = match.group(1)
            out.append("%s=%s" % (key, _env_value(patch[key])))
            replaced.add(key)
        else:
            out.append(line)
    missing = [k for k in patch if k not in replaced]
    if missing:
        if out and out[-1].strip():
            out.append("")
        out.append("# ---- 系统管理（后台保存，%s）----" % time.strftime("%Y-%m-%d %H:%M:%S"))
        for key in missing:
            out.append("%s=%s" % (key, _env_value(patch[key])))
    content = "\n".join(out) + "\n"
    tmp = _ENV_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
    os.replace(tmp, _ENV_PATH)


def _env_value(value) -> str:
    """含空格/特殊字符的值加引号，避免 dotenv 解析截断"""
    text = str(value)
    if re.search(r"[\s#\"']", text):
        return '"%s"' % text.replace('"', '\\"')
    return text
