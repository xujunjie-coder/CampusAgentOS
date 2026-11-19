"""
app/services/notify_service.py —— 定时任务结果推送：邮件 / QQ 消息通知封装（成员 E）

只做三件事：
1. 邮件通知：标准库 smtplib 发纯文本 / HTML 邮件，SMTP 参数全部来自配置中心（.env）；
2. QQ 消息通知：优先 QQ 机器人 HTTP webhook（QQ_WEBHOOK_URL），未配置时回退 QQ 邮箱 SMTP
   （smtp.qq.com，需授权码）；两者都不可用则显式降级；
3. 统一 dispatch：按渠道（email / qq / both / none）投递并汇总结果。

安全与可靠性约定（沿用项目「凭据只从运行环境读取、缺失即显式降级、绝不静默失败」的一贯做法）：
- 真实凭据（SMTP_PASSWORD / QQ_SMTP_PASSWORD）只存在于本机 .env，绝不写进代码 / 文档 / 日志；
- 未配置对应渠道时返回 {ok: False, degraded: True, reason: 中文说明}，不抛异常、不影响主链路；
- 发送有超时（默认 15s），网络/认证异常归一为失败结果，日志只记录渠道与原因、不记录口令；
- 本模块全部为同步阻塞函数，调度器需在线程池 / executor 中调用，不得直接在 IOLoop 里跑。
"""

import json
import logging
import smtplib
import ssl
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Dict, List, Optional

import app.config as config

logger = logging.getLogger(__name__)

SMTP_TIMEOUT = 15
QQ_SMTP_HOST = "smtp.qq.com"
QQ_SMTP_PORT = 465

CHANNELS = ("none", "email", "qq", "both")

# 通知配置 key 与 .env 常量的映射（DB 优先，缺失回退环境变量）
_NOTIFY_KEYS = {
    "smtp_host": "notify_smtp_host",
    "smtp_port": "notify_smtp_port",
    "smtp_user": "notify_smtp_user",
    "smtp_password": "notify_smtp_password",
    "smtp_ssl": "notify_smtp_ssl",
    "mail_from": "notify_mail_from",
    "mail_to": "notify_mail_to",
    "qq_webhook_url": "notify_qq_webhook_url",
    "qq_smtp_user": "notify_qq_smtp_user",
    "qq_smtp_password": "notify_qq_smtp_password",
    "qq_to": "notify_qq_to",
}


def _get_config(field: str, env_default="") -> str:
    """读取通知配置：数据库优先，缺失则回退 .env 常量"""
    try:
        from app.models.settings import SystemSettingsRepository
        key = _NOTIFY_KEYS.get(field, "notify_" + field)
        val = SystemSettingsRepository.get(key, "")
        if val:
            return val
    except Exception:
        pass  # 表不存在/DB异常时静默回退 env
    return str(env_default) if env_default else ""


def _to_list(value) -> List[str]:
    """收件人归一：字符串按逗号 / 分号分隔，列表原样去空白"""
    if not value:
        return []
    if isinstance(value, (list, tuple)):
        return [str(x).strip() for x in value if str(x).strip()]
    parts = str(value).replace(";", ",").split(",")
    return [p.strip() for p in parts if p.strip()]


def email_available() -> Dict:
    """邮件渠道是否可用（缺主机 / 发件人 / 收件人任一项即不可用）"""
    missing = []
    if not _get_config("smtp_host", config.SMTP_HOST):
        missing.append("SMTP_HOST")
    if not _get_config("mail_from", config.MAIL_FROM):
        missing.append("MAIL_FROM")
    if not _get_config("mail_to", config.MAIL_TO):
        missing.append("MAIL_TO")
    if missing:
        return {"available": False, "reason": "邮件渠道未配置：%s" % "、".join(missing)}
    return {"available": True, "reason": ""}


def qq_available() -> Dict:
    """QQ 渠道是否可用：webhook 或 QQ 邮箱 SMTP 任一具备即可"""
    if _get_config("qq_webhook_url", config.QQ_WEBHOOK_URL):
        return {"available": True, "reason": "", "mode": "webhook"}
    if _get_config("qq_smtp_user", config.QQ_SMTP_USER) and _get_config("qq_to", config.QQ_TO):
        return {"available": True, "reason": "", "mode": "smtp"}
    return {"available": False, "mode": "none",
            "reason": "QQ 渠道未配置：需 QQ_WEBHOOK_URL（机器人）或 QQ_SMTP_USER + QQ_TO（QQ 邮箱）"}


def channels_status() -> Dict:
    """两渠道可用性快照，供后台 / 接口显式标注降级（不泄露口令）"""
    return {"email": email_available(), "qq": qq_available()}


def _smtp_send(host: str, port: int, user: str, password: str, use_ssl: bool,
               sender: str, recipients: List[str], subject: str, body: str,
               html: bool = False) -> None:
    """建立 SMTP(S) 连接并投递一封邮件；异常向上抛出由调用方归一"""
    msg = MIMEText(body, "html" if html else "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr((str(Header("GovAgentOS", "utf-8")), sender))
    msg["To"] = ", ".join(recipients)
    context = ssl.create_default_context()
    if use_ssl:
        server = smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT, context=context)
    else:
        server = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT)
        try:
            server.starttls(context=context)
        except smtplib.SMTPNotSupportedError:
            pass  # 明文端口不支持 STARTTLS 时按明文发送
    try:
        if user:
            server.login(user, password)
        server.sendmail(sender, recipients, msg.as_string())
    finally:
        try:
            server.quit()
        except Exception:
            pass


def send_email(subject: str, body: str, to: Optional[str] = None,
               html: bool = False) -> Dict:
    """发送一封邮件通知。未配置渠道时显式降级；发送异常归一为失败结果。"""
    status = email_available()
    if not status["available"]:
        return {"channel": "email", "ok": False, "degraded": True, "reason": status["reason"]}
    recipients = _to_list(to) or _to_list(_get_config("mail_to", config.MAIL_TO))
    if not recipients:
        return {"channel": "email", "ok": False, "degraded": True, "reason": "邮件收件人为空"}
    try:
        smtp_ssl_val = _get_config("smtp_ssl", "1" if config.SMTP_SSL else "0")
        smtp_port_val = _get_config("smtp_port", config.SMTP_PORT)
        _smtp_send(
            _get_config("smtp_host", config.SMTP_HOST),
            int(smtp_port_val),
            _get_config("smtp_user", config.SMTP_USER),
            _get_config("smtp_password", config.SMTP_PASSWORD),
            smtp_ssl_val in ("1", "true", "yes", "on"),
            _get_config("mail_from", config.MAIL_FROM),
            recipients, subject, body, html=html)
        logger.info("邮件通知已发送：subject=%r to=%d 人", subject, len(recipients))
        return {"channel": "email", "ok": True, "degraded": False, "recipients": len(recipients)}
    except Exception as exc:  # 网络/认证/编码异常统一归一，不外泄口令
        logger.warning("邮件通知发送失败：%s", exc)
        return {"channel": "email", "ok": False, "degraded": False,
                "reason": "邮件发送失败：%s" % (exc,)}


def _send_qq_webhook(url: str, subject: str, body: str) -> Dict:
    """QQ 机器人 webhook 通道：标准库 urllib POST JSON，避免额外依赖"""
    from urllib.request import Request, urlopen

    payload = json.dumps({"content": ("%s\n%s" % (subject, body))[:1800]}).encode("utf-8")
    req = Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=SMTP_TIMEOUT) as resp:  # noqa: S310 - url 来自本机配置
        ok = 200 <= resp.status < 300
        return {"channel": "qq", "ok": bool(ok), "degraded": False,
                "mode": "webhook", "reason": "" if ok else "webhook 返回状态 %s" % resp.status}


def send_qq(subject: str, body: str, to: Optional[str] = None) -> Dict:
    """发送 QQ 消息通知：webhook 优先，回退 QQ 邮箱 SMTP；都不可用则显式降级。"""
    status = qq_available()
    if not status["available"]:
        return {"channel": "qq", "ok": False, "degraded": True, "reason": status["reason"]}
    if status["mode"] == "webhook":
        try:
            return _send_qq_webhook(_get_config("qq_webhook_url", config.QQ_WEBHOOK_URL), subject, body)
        except Exception as exc:
            logger.warning("QQ webhook 发送失败：%s", exc)
            return {"channel": "qq", "ok": False, "degraded": False, "mode": "webhook",
                    "reason": "QQ webhook 发送失败：%s" % (exc,)}
    # QQ 邮箱 SMTP 通道
    recipients = _to_list(to) or _to_list(_get_config("qq_to", config.QQ_TO))
    try:
        qq_user = _get_config("qq_smtp_user", config.QQ_SMTP_USER)
        _smtp_send(QQ_SMTP_HOST, QQ_SMTP_PORT, qq_user,
                   _get_config("qq_smtp_password", config.QQ_SMTP_PASSWORD),
                   True, qq_user, recipients, subject, body)
        logger.info("QQ 邮箱通知已发送：subject=%r to=%d 人", subject, len(recipients))
        return {"channel": "qq", "ok": True, "degraded": False, "mode": "smtp",
                "recipients": len(recipients)}
    except Exception as exc:
        logger.warning("QQ 邮箱发送失败：%s", exc)
        return {"channel": "qq", "ok": False, "degraded": False, "mode": "smtp",
                "reason": "QQ 邮箱发送失败：%s" % (exc,)}


def notify(channel: str, subject: str, body: str, to: Optional[str] = None) -> Dict:
    """按渠道投递：none 直接跳过；email / qq / both 分别调用并汇总。

    返回 {channel, skipped, results:[...], ok, degraded}：
    - ok：所有已尝试渠道是否全部成功；
    - degraded：是否至少有一个渠道因未配置而降级（供上层显式提示）。
    """
    channel = channel if channel in CHANNELS else "none"
    if channel == "none":
        return {"channel": "none", "skipped": True, "results": [], "ok": True, "degraded": False}
    results: List[Dict] = []
    if channel in ("email", "both"):
        results.append(send_email(subject, body, to=to))
    if channel in ("qq", "both"):
        results.append(send_qq(subject, body, to=to))
    attempted = [r for r in results if not r.get("degraded")]
    ok = all(r.get("ok") for r in attempted) if attempted else False
    degraded = any(r.get("degraded") for r in results)
    return {"channel": channel, "skipped": False, "results": results, "ok": ok, "degraded": degraded}


def build_task_report(task: Dict, status: str, result: str, detail: str = "") -> Dict:
    """把一次任务运行结果整理成通知的标题与正文（供 scheduler_service 调用）"""
    from app.models.task import STATUS_SUCCESS

    label = "成功" if status == STATUS_SUCCESS else ("运行中" if status == "running" else "失败")
    subject = "[GovAgentOS 定时任务] %s（%s）%s" % (task.get("name", "未命名任务"),
                                                    task.get("task_type", ""), label)
    body_lines = [
        "任务名称：%s" % task.get("name", ""),
        "任务类型：%s" % task.get("task_type", ""),
        "运行结果：%s" % label,
        "结果摘要：%s" % (result or "（无）"),
    ]
    if detail:
        body_lines.append("详细信息：%s" % detail)
    return {"subject": subject, "body": "\n".join(body_lines)}
