"""
app/config.py —— 配置中心（任务13）

职责（唯一读取 .env 的地方）：
- 进程内只 load_dotenv() 一次，其余模块（application.py / app.py / services/*）不再各自加载、
  不再各自 os.getenv 散读；
- 集中做类型转换与范围校验，对外暴露两类只读视图：
  * 模块级大写常量（APP_PORT、COOKIE_SECRET、DB_DRIVER ...），供业务代码直接引用；
  * SETTINGS 快照对象（dataclass，frozen），供需要整体判定的场景使用；
- 必填项缺失 / 取值非法时抛 ConfigError（中文可读提示），启动期（make_app）即报错，禁止带病启动；
- reload(strict) 供测试在改动 os.environ 后重新解析（.env 仍只加载一次）。

安全约定：
- .env 内含密钥，只允许存在于开发者本机，不进仓库（.gitignore 已忽略 .env）；
- .env.example 只写占位符，不得出现任何真实密钥。
"""

import importlib.util
import os
import sys
from dataclasses import dataclass
from typing import List, Tuple


# 项目根目录：app/config.py → app → 仓库根
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
ENV_FILE = os.path.join(PROJECT_ROOT, ".env")

# 视为「未配置」的占位值：命中即按缺失处理，防止把示例值带上线
PLACEHOLDER_SECRETS = {
    "",
    "please-change-me",
    "changeme",
    "change-me",
    "your-secret-here",
    "govagentos-secret-key",
    "******",
}

_ENV_LOADED = False

# 合法取值域
DB_DRIVERS = ("sqlite", "mysql")
FACE_ENGINES = ("onnx", "fallback", "auto")
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


class ConfigError(RuntimeError):
    """配置缺失或不合法：启动期直接抛出，提示语面向项目维护者，可照做修复"""


@dataclass(frozen=True)
class Settings:
    """一份完整的配置快照（不可变），字段名与大写常量一一对应"""

    app_host: str
    app_port: int
    debug: bool
    cookie_secret: str
    xsrf_enabled: bool
    log_level: str
    db_driver: str
    db_path: str
    db_host: str
    db_port: int
    db_user: str
    db_password: str
    db_name: str
    db_charset: str
    session_ttl_hours: int
    login_max_fails: int
    login_lock_minutes: int
    face_engine: str
    face_threshold: float
    face_liveness_threshold: float
    face_model_dir: str
    cors_allow_origins: Tuple[str, ...]
    sse_heartbeat_seconds: int
    ws_heartbeat_seconds: int
    model_base_url: str
    model_api_key: str
    model_id: str
    jamendo_client_id: str
    # 成员 E：定时任务 + 消息通知（凭据全部可选，缺失时通知显式降级，不静默失败）
    scheduler_enabled: bool
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    smtp_ssl: bool
    mail_from: str
    mail_to: str
    qq_smtp_user: str
    qq_smtp_password: str
    qq_to: str
    qq_webhook_url: str


def _load_env_once(force: bool = False) -> None:
    """只把仓库根 .env 读进 os.environ 一次；不覆盖已存在的进程环境变量（便于测试/部署覆盖）"""
    global _ENV_LOADED
    if _ENV_LOADED and not force:
        return
    try:
        from dotenv import load_dotenv
    except ImportError:  # python-dotenv 缺失时退化为只读进程环境变量
        _ENV_LOADED = True
        return
    if os.path.isfile(ENV_FILE):
        # override=False：已存在的环境变量优先，命令行/CI 注入的配置不会被 .env 覆盖
        load_dotenv(ENV_FILE, override=False)
    _ENV_LOADED = True


def _raw(name: str, default: str = "") -> str:
    """取原始字符串配置：去掉首尾空白，空串视为未配置"""
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value if value != "" else default


def _str(name: str, default: str = "") -> str:
    return _raw(name, default)


def _int(name: str, default: int, errors: List[str], low: int = None, high: int = None,
         hint: str = "") -> int:
    """整数配置：非数字/越界都记一条中文错误，同时返回默认值保证后续字段能继续解析"""
    raw = _raw(name, "")
    if raw == "":
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        errors.append("%s=%r 不是合法整数%s" % (name, raw, ("，" + hint) if hint else ""))
        return default
    if low is not None and value < low:
        errors.append("%s=%r 不能小于 %d%s" % (name, value, low, ("，" + hint) if hint else ""))
    if high is not None and value > high:
        errors.append("%s=%r 不能大于 %d%s" % (name, value, high, ("，" + hint) if hint else ""))
    return value


def _float(name: str, default: float, errors: List[str], low: float = None,
           high: float = None, hint: str = "") -> float:
    raw = _raw(name, "")
    if raw == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        errors.append("%s=%r 不是合法数字%s" % (name, raw, ("，" + hint) if hint else ""))
        return default
    if low is not None and value < low:
        errors.append("%s=%r 不能小于 %s%s" % (name, value, low, ("，" + hint) if hint else ""))
    if high is not None and value > high:
        errors.append("%s=%r 不能大于 %s%s" % (name, value, high, ("，" + hint) if hint else ""))
    return value


def _bool(name: str, default: bool) -> bool:
    """布尔配置：1/true/yes/on/y/t 为真，其余为假；空值用默认值"""
    raw = _raw(name, "")
    if raw == "":
        return default
    return raw.lower() in ("1", "true", "yes", "on", "y", "t")


def _list(name: str, default: Tuple[str, ...]) -> Tuple[str, ...]:
    """逗号分隔列表，去空白去空项（用于 CORS 白名单）"""
    raw = _raw(name, "")
    if raw == "":
        return default
    return tuple(x.strip() for x in raw.split(",") if x.strip())


def _choice(name: str, default: str, allowed: Tuple[str, ...], errors: List[str]) -> str:
    raw = _raw(name, "").lower()
    if raw == "":
        return default
    if raw not in allowed:
        errors.append("%s=%r 非法，可选值：%s" % (name, raw, " | ".join(allowed)))
        return default
    return raw


def _abs_path(path: str) -> str:
    """相对路径一律相对仓库根解析，避免从不同工作目录启动时落库位置漂移"""
    if not path:
        return ""
    return path if os.path.isabs(path) else os.path.abspath(os.path.join(PROJECT_ROOT, path))


def _read(strict: bool) -> Settings:
    """解析 + 校验全部配置；strict=True 时把错误汇总成 ConfigError 抛出"""
    errors: List[str] = []

    cookie_secret = _str("COOKIE_SECRET", "")
    if cookie_secret in PLACEHOLDER_SECRETS or len(cookie_secret) < 32:
        errors.append(
            "COOKIE_SECRET 未配置或仍为示例值/长度不足 32 位：请在 %s 中设置 "
            "COOKIE_SECRET=<至少32位的随机串>，可用 python -c "
            "\"import secrets;print(secrets.token_urlsafe(48))\" 生成" % ENV_FILE)
        if not strict:
            # 开发期兜底：给进程内临时密钥（重启即失效，不会掩盖线上配置缺失）
            cookie_secret = "dev-only-insecure-%s" % os.urandom(16).hex()

    db_driver = _choice("DB_DRIVER", "sqlite", DB_DRIVERS, errors)
    if db_driver == "mysql" and importlib.util.find_spec("pymysql") is None:
        errors.append(
            "DB_DRIVER=mysql 但未安装 pymysql：请执行 \"%s\" -m pip install pymysql"
            "（不会静默回退 SQLite）" % sys.executable)

    face_engine = _choice("FACE_ENGINE", "auto", FACE_ENGINES, errors)
    face_threshold = _float("FACE_THRESHOLD", 0.35, errors, low=0.0, high=1.0,
                            hint="相似度阈值允许范围 0~1")
    face_liveness_threshold = _float("FACE_LIVENESS_THRESHOLD", 0.75, errors, low=0.5, high=1.0,
                                     hint="活体阈值允许范围 0.5~1")

    log_level = _raw("LOG_LEVEL", "INFO").upper()
    if log_level not in LOG_LEVELS:
        errors.append("LOG_LEVEL=%r 非法，可选值：%s" % (log_level, " | ".join(LOG_LEVELS)))
        log_level = "INFO"

    debug = _bool("DEBUG", True)
    settings = Settings(
        # 默认监听地址：调试模式只绑本机，生产（DEBUG=0）绑全部网卡
        app_host=_str("APP_HOST", "127.0.0.1" if debug else "0.0.0.0"),
        app_port=_int("APP_PORT", 10086, errors, low=1, high=65535, hint="端口范围 1~65535"),
        debug=debug,
        cookie_secret=cookie_secret,
        xsrf_enabled=_bool("XSRF_ENABLED", True),
        log_level=log_level,
        db_driver=db_driver,
        db_path=_abs_path(_str("DB_PATH", os.path.join("database", "govagentos.db"))),
        db_host=_str("DB_HOST", "127.0.0.1"),
        db_port=_int("DB_PORT", 3306, errors, low=1, high=65535, hint="端口范围 1~65535"),
        db_user=_str("DB_USER", "root"),
        db_password=_str("DB_PASSWORD", ""),
        db_name=_str("DB_NAME", "govagentos"),
        db_charset=_str("DB_CHARSET", "utf8mb4"),
        session_ttl_hours=_int("SESSION_TTL_HOURS", 12, errors, low=1, high=24 * 365),
        login_max_fails=_int("LOGIN_MAX_FAILS", 5, errors, low=1, high=100),
        login_lock_minutes=_int("LOGIN_LOCK_MINUTES", 10, errors, low=0, high=24 * 60),
        face_engine=face_engine,
        face_threshold=face_threshold,
        face_liveness_threshold=face_liveness_threshold,
        face_model_dir=_abs_path(_str("FACE_MODEL_DIR", os.path.join("database", "models", "face"))),
        cors_allow_origins=_list("CORS_ALLOW_ORIGINS", ()),
        sse_heartbeat_seconds=_int("SSE_HEARTBEAT_SECONDS", 15, errors, low=1, high=600),
        ws_heartbeat_seconds=_int("WS_HEARTBEAT_SECONDS", 30, errors, low=5, high=600),
        model_base_url=_str("BASE_URL", ""),
        model_api_key=_str("API_KEY", ""),
        model_id=_str("MODEL_ID", ""),
        jamendo_client_id=_str("JAMENDO_CLIENT_ID", ""),
        # ---- 定时任务与消息通知（成员 E）：均为非必填，缺失只影响通知渠道可用性 ----
        scheduler_enabled=_bool("SCHEDULER_ENABLED", True),
        smtp_host=_str("SMTP_HOST", ""),
        smtp_port=_int("SMTP_PORT", 465, errors, low=1, high=65535, hint="SMTP 端口范围 1~65535"),
        smtp_user=_str("SMTP_USER", ""),
        smtp_password=_str("SMTP_PASSWORD", ""),
        smtp_ssl=_bool("SMTP_SSL", True),
        mail_from=_str("MAIL_FROM", "") or _str("SMTP_USER", ""),
        mail_to=_str("MAIL_TO", ""),
        qq_smtp_user=_str("QQ_SMTP_USER", ""),
        qq_smtp_password=_str("QQ_SMTP_PASSWORD", ""),
        qq_to=_str("QQ_TO", ""),
        qq_webhook_url=_str("QQ_WEBHOOK_URL", ""),
    )

    if strict and errors:
        raise ConfigError(
            "配置校验未通过，请修正 %s 后重启：\n  - %s" % (ENV_FILE, "\n  - ".join(errors)))
    return settings


def _publish(settings: Settings) -> None:
    """把快照铺成模块级大写常量（业务代码直接 import 使用）"""
    globals().update({
        "APP_HOST": settings.app_host,
        "APP_PORT": settings.app_port,
        "DEBUG": settings.debug,
        "COOKIE_SECRET": settings.cookie_secret,
        "XSRF_ENABLED": settings.xsrf_enabled,
        "LOG_LEVEL": settings.log_level,
        "DB_DRIVER": settings.db_driver,
        "DB_PATH": settings.db_path,
        "DB_HOST": settings.db_host,
        "DB_PORT": settings.db_port,
        "DB_USER": settings.db_user,
        "DB_PASSWORD": settings.db_password,
        "DB_NAME": settings.db_name,
        "DB_CHARSET": settings.db_charset,
        "SESSION_TTL_HOURS": settings.session_ttl_hours,
        "LOGIN_MAX_FAILS": settings.login_max_fails,
        "LOGIN_LOCK_MINUTES": settings.login_lock_minutes,
        "FACE_ENGINE": settings.face_engine,
        "FACE_THRESHOLD": settings.face_threshold,
        "FACE_LIVENESS_THRESHOLD": settings.face_liveness_threshold,
        "FACE_MODEL_DIR": settings.face_model_dir,
        "CORS_ALLOW_ORIGINS": settings.cors_allow_origins,
        "SSE_HEARTBEAT_SECONDS": settings.sse_heartbeat_seconds,
        "WS_HEARTBEAT_SECONDS": settings.ws_heartbeat_seconds,
        "MODEL_BASE_URL": settings.model_base_url,
        "MODEL_API_KEY": settings.model_api_key,
        "MODEL_ID": settings.model_id,
        "JAMENDO_CLIENT_ID": settings.jamendo_client_id,
        "SCHEDULER_ENABLED": settings.scheduler_enabled,
        "SMTP_HOST": settings.smtp_host,
        "SMTP_PORT": settings.smtp_port,
        "SMTP_USER": settings.smtp_user,
        "SMTP_PASSWORD": settings.smtp_password,
        "SMTP_SSL": settings.smtp_ssl,
        "MAIL_FROM": settings.mail_from,
        "MAIL_TO": settings.mail_to,
        "QQ_SMTP_USER": settings.qq_smtp_user,
        "QQ_SMTP_PASSWORD": settings.qq_smtp_password,
        "QQ_TO": settings.qq_to,
        "QQ_WEBHOOK_URL": settings.qq_webhook_url,
    })


def reload(strict: bool = True) -> Settings:
    """按当前 os.environ 重新解析（测试/热调整用）；strict=True 时非法配置抛 ConfigError"""
    _load_env_once()
    settings = _read(strict)
    _publish(settings)
    return settings


def model_env() -> dict:
    """大模型兜底配置（动态读取，便于运行期/测试覆盖环境变量）"""
    return {
        "base_url": _raw("BASE_URL", ""),
        "api_key": _raw("API_KEY", ""),
        "model_id": _raw("MODEL_ID", ""),
    }


def model_env_ready() -> bool:
    """三项兜底配置是否齐全（缺任一项则说明未接入任何大模型）"""
    env = model_env()
    return all(env[k] for k in ("base_url", "api_key", "model_id"))


# 首次导入即解析：strict=True —— 配置不合法直接让进程起不来，避免带病运行
SETTINGS = reload(strict=True)
