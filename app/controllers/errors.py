"""
统一异常与错误响应（任务15）

- APIError：业务异常（status + code + 中文 message），Controller/Service 抛出后由 BaseHandler.write_error 统一出口；
- exception_to_api_error：把 db.IntegrityError / HTTPError / ValueError / TimeoutError 等映射成 APIError，
  **500 一律使用固定中文文案**，绝不把 SQL、文件路径、堆栈、密钥回给客户端；
- STATUS_CODES：状态码 → 机器可读 code（前端据此分支，不依赖中文文案）。
"""

from tornado.web import HTTPError

from app.models import db

STATUS_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    429: "TOO_MANY_REQUESTS",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
}

# Tornado 自带的英文错误文案换成中文（前端直接展示）
HTTP_MESSAGES = {
    400: "请求参数不合法",
    401: "未登录或登录已过期",
    403: "无权访问该资源",
    404: "页面或接口不存在",
    405: "请求方法不被允许",
    413: "请求体过大",
    500: "服务器内部错误，请稍后重试",
}


def default_code(status: int) -> str:
    return STATUS_CODES.get(int(status), "ERROR")


class APIError(Exception):
    """业务异常：携带 HTTP 状态码与机器可读 code"""

    def __init__(self, message: str, status: int = 400, code: str = ""):
        super().__init__(message)
        self.message = message or HTTP_MESSAGES.get(int(status), "请求处理失败")
        self.status = int(status)
        self.code = code or default_code(self.status)


def exception_to_api_error(exc: Exception) -> APIError:
    """异常 → APIError：已知类型给出可读中文，未知类型统一 500 且不泄露细节"""
    if isinstance(exc, APIError):
        return exc
    if exc is None:
        return APIError("请求处理失败", 500)
    if isinstance(exc, db.IntegrityError):
        return APIError("数据冲突：记录已存在或违反唯一约束", 409, "CONFLICT")
    if isinstance(exc, db.OperationalError):
        return APIError("数据库操作失败，请稍后重试", 503, "DB_UNAVAILABLE")
    if isinstance(exc, HTTPError):
        status = int(getattr(exc, "status_code", 500) or 500)
        return APIError(HTTP_MESSAGES.get(status, "请求处理失败"), status)
    if isinstance(exc, PermissionError):
        return APIError("无权访问该资源", 403)
    if isinstance(exc, FileNotFoundError):
        return APIError("资源不存在", 404)
    if isinstance(exc, TimeoutError):
        return APIError("处理超时，请稍后重试", 504)
    if isinstance(exc, (ValueError, TypeError, KeyError)):
        return APIError("请求参数不合法", 400)
    return APIError("服务器内部错误，请稍后重试", 500, "INTERNAL_ERROR")


def message_for_status(status: int) -> str:
    """没有异常上下文时（如 send_error(404)）按状态码给中文文案"""
    return HTTP_MESSAGES.get(int(status), "请求处理失败" if status < 500 else "服务器内部错误，请稍后重试")
