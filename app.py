"""
应用入口（任务13：端口/调试/密钥全部读配置中心；任务17：启动日志走 logging）

启动：venv\\Scripts\\python.exe app.py
配置：仓库根 .env（参照 .env.example），缺必填项会直接报错并提示修复方式。
"""

import logging

import tornado.httpserver
import tornado.ioloop
import tornado.netutil
import tornado.web

import app.config as config
from app.application import make_app
from app.services import face_service

logger = logging.getLogger("govagentos")


def _setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL, logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


def main() -> None:
    _setup_logging()
    webapp = make_app()
    from app.models.qq_channel import recover_interrupted
    recover_interrupted()
    # 绑定地址来自配置：DEBUG 默认 127.0.0.1，生产可设 0.0.0.0
    sockets = tornado.netutil.bind_sockets(config.APP_PORT, address=config.APP_HOST)
    server = tornado.httpserver.HTTPServer(webapp)
    for sock in sockets:
        server.add_socket(sock)
    port = sockets[0].getsockname()[1]
    logger.info("服务器启动：http://%s:%d  DB驱动=%s  DEBUG=%s",
                config.APP_HOST, port, config.DB_DRIVER, config.DEBUG)
    face_service.warmup_async()
    tornado.ioloop.IOLoop.current().start()


if __name__ == "__main__":
    main()
