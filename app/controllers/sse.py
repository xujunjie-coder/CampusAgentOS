"""
SSE 基础封装（任务16）

背景：早期各端点自己拼 SSE 报文与响应头，写法各异，异常/断连处理也不统一。
本模块提供：

- SSEMixin：统一 SSE 响应头、事件编码（JSON + 防换行注入）、逐事件 flush、心跳、收尾；
- SSEBridge：把「线程池里的阻塞任务」通过 asyncio.Queue 转成 SSE 事件流
  （抽取自 warehouse 深采面板的既有模式），统一处理心跳、超时、取消与异常；
- Heartbeat：可选的后台心跳任务（长时间无事件的流用），可随时取消。

事件名与载荷保持与既有前端约定完全一致（assistant/delta/tool/reasoning/done/error、
progress/result/batch_done/heartbeat），前端零改动。
"""

import asyncio
import json
import logging

import tornado.ioloop

from app import config

logger = logging.getLogger(__name__)


class SSEMixin:
    """SSE 能力混入（BaseHandler 已继承，任意 Handler 可直接用）"""

    heartbeat_seconds = config.SSE_HEARTBEAT_SECONDS

    @staticmethod
    def format_event(event: str, data) -> str:
        """把事件编码成 SSE 报文：data 为 JSON（转义换行，杜绝事件被注入截断）"""
        payload = json.dumps(data, ensure_ascii=False)
        payload = payload.replace("\r", "\\r").replace("\n", "\\n")
        return "event: %s\ndata: %s\n\n" % (event, payload)

    def start_sse(self) -> None:
        """写 SSE 响应头（必须在第一次 write 前调用）"""
        self.set_status(200)
        self.set_header("Content-Type", "text/event-stream; charset=utf-8")
        self.set_header("Cache-Control", "no-cache")
        self.set_header("Connection", "keep-alive")
        self.set_header("X-Accel-Buffering", "no")  # 关闭 nginx 缓冲，保证真流式

    async def send_event(self, event: str, data) -> None:
        """发送一个事件并立即 flush（打字机/进度条的实时性依赖 flush）"""
        self.write(self.format_event(event, data))
        await self.flush()

    async def heartbeat(self, event: str = "heartbeat", data=None) -> None:
        """心跳：默认发注释行 ": ping"，指定 event 时发标准事件（兼容既有前端）"""
        if event:
            await self.send_event(event, {} if data is None else data)
        else:
            self.write(": ping\n\n")
            await self.flush()

    def client_gone(self) -> bool:
        """客户端是否已断开（EventSource 关闭 / 连接流关闭）"""
        try:
            connection = self.request.connection
            return connection is None or connection.stream.closed()
        except Exception:
            return True

    def finish_sse(self) -> None:
        """幂等收尾：断开或已结束时静默忽略，避免二次 finish 报错"""
        try:
            if not self._finished:
                self.finish()
        except Exception:
            pass


class SSEBridge:
    """线程池 → SSE 的事件桥

    用法：
        bridge = SSEBridge(self)
        bridge.submit(warehouse_service.deep_collect_one, executor, item, emit)
        result = await bridge.stream()
    """

    def __init__(self, handler: SSEMixin, heartbeat_seconds: int = None):
        self.handler = handler
        self.loop = tornado.ioloop.IOLoop.current()
        self.queue: asyncio.Queue = asyncio.Queue()
        self.heartbeat_seconds = int(heartbeat_seconds or config.SSE_HEARTBEAT_SECONDS)
        self.future = None

    # 线程侧调用：把事件安全地投递回 IOLoop
    def emit(self, **event) -> None:
        try:
            self.loop.add_callback(self.queue.put_nowait, event)
        except Exception:  # 事件循环已关闭（进程退出）
            pass

    def submit(self, fn, executor, *args):
        """把阻塞任务丢进线程池；emit 由任务内部调用"""
        self.future = self.loop.run_in_executor(executor, fn, self.emit, *args)
        return self.future

    async def stream(self, stop_events=("batch_done", "error"), result_event: str = "result",
                     result_timeout: float = 30, heartbeat_event: str = "heartbeat"):
        """消费事件队列直到任务结束；返回任务结果（同时以 result_event 下发）"""
        finished = False
        while not finished:
            if self.future is not None and self.future.done() and self.queue.empty():
                break  # 事件已全部入队且任务结束：立即收尾
            try:
                event = await asyncio.wait_for(self.queue.get(), timeout=self.heartbeat_seconds)
            except asyncio.TimeoutError:
                if self.future is not None and self.future.done():
                    break
                await self.handler.heartbeat(heartbeat_event, {})
                continue
            etype = event.get("type", "progress")
            await self.handler.send_event(etype, event)
            if etype in stop_events:
                finished = True
        result = await asyncio.wait_for(asyncio.wrap_future(self.future), timeout=result_timeout)
        await self.handler.send_event(result_event, {"data": result})
        return result


class Heartbeat:
    """可选后台心跳：长时间静默的流每 N 秒发一次，close() 时取消"""

    def __init__(self, handler: SSEMixin, seconds: int = None, event: str = ""):
        self.handler = handler
        self.seconds = int(seconds or config.SSE_HEARTBEAT_SECONDS)
        self.event = event
        self._task = None

    def start(self) -> "Heartbeat":
        self._task = tornado.ioloop.IOLoop.current().spawn_callback(self._run)
        return self

    async def _run(self):
        try:
            while not self.handler.client_gone():
                await asyncio.sleep(self.seconds)
                await self.handler.heartbeat(self.event, {})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("SSE 心跳结束", exc_info=True)

    def close(self) -> None:
        if self._task is not None:
            try:
                tornado.ioloop.IOLoop.current().remove_callback(self._task)
            except Exception:
                pass
            self._task = None
