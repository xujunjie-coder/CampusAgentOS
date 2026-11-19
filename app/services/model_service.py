"""
模型引擎服务层 —— 任务8
按 OpenAI 接口范式对「模型引擎管理」里配置的模型服务发起真实调用，供对话测试弹层使用：
- stream_chat_test：POST {api_url}/chat/completions（stream=true），异步生成器逐块产出事件 Dict
  （reasoning 思维链 / delta 正文 / usage 用量 / done 结束 / error 错误），含思维开关：
  thinking 开启时传 enable_thinking=true + chat_template_kwargs.enable_thinking=true（兼容
  vLLM/Qwen 与常见网关两种透传方式），关闭时传 false；不支持思维链的模型忽略该参数。
- embedding_test：POST {api_url}/embeddings，返回向量维度与前若干维预览。
- image_test：POST {api_url}/images/generations，返回图片 URL / base64 列表。

实现约定：
- 全部走 tornado.httpclient.AsyncHTTPClient，真异步不阻塞 IOLoop（区别于 agentica 同步链路）
- 流式响应用 streaming_callback 逐块解析 SSE 行，经 asyncio.Queue 转交给异步生成器
- 本层不读模型配置表：模型配置 dict 由控制层从 ModelEngineRepository 取出后传入
- 任务8.1：测试调用收到 usage 时落 model_token_logs 流水（TokenStatsRepository），
  上游未返回 usage 时按文本估算兜底（中文 ~1 token/字，其余 ~4 字符/token）
"""

import asyncio
import json
import math
import os
import re
from typing import AsyncIterator, Dict, List

from tornado.httpclient import AsyncHTTPClient, HTTPRequest

from app import config
from app.models.model_engine import ModelEngineRepository
from app.models.token_stats import TokenStatsRepository

# 对话测试超时：本地/远端大模型首 token 可能较慢，放宽到 120s
_CHAT_TIMEOUT = 120
# 嵌入/图片测试为一次性请求，60s 足够
_SIMPLE_TIMEOUT = 60


def chat_engine(employee=None):
    binding = str((employee or {}).get("model_binding") or "").strip()
    if binding.isascii() and binding.isdigit() and len(binding) <= 18:
        model = ModelEngineRepository.get_by_id(int(binding))
        if model and model["enabled"] and model["type"] in ("text", "multimodal", "vl"):
            return model
    model = ModelEngineRepository.get_default()
    if model and model["enabled"]:
        return model
    proxy_url = os.getenv("AHLLM_PROXY_BASE_URL")
    if proxy_url:
        url = proxy_url
        key = os.getenv("AHLLM_PROXY_API_KEY")
        model_id = os.getenv("AHLLM_PROXY_MODEL_ID")
    else:
        env = config.model_env()
        url, key, model_id = env["base_url"], env["api_key"], env["model_id"]
    if url and model_id:
        return {"api_url": url, "api_key": key or "", "model_id": model_id}
    return None


def _headers(model: Dict) -> Dict:
    headers = {"Content-Type": "application/json"}
    if model.get("api_key"):
        headers["Authorization"] = "Bearer " + model["api_key"]
    return headers


def _endpoint(model: Dict, path: str) -> str:
    return model["api_url"].rstrip("/") + path


_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uc000-\uc7ff]")


def estimate_tokens(text: str) -> int:
    """任务8.1：上游未返回 usage 时的估算兜底：中文/日韩 ~1 token/字，其余 ~4 字符/token"""
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    other = len(text) - cjk
    return max(1, cjk + other // 4)


def _usage_from_texts(prompt_text: str, completion_text: str) -> Dict:
    p, c = estimate_tokens(prompt_text), estimate_tokens(completion_text)
    return {"prompt_tokens": p, "completion_tokens": c, "total_tokens": p + c, "estimated": True}


def _record_usage(model: Dict, usage: Dict, kind: str = "model_test", username: str = "") -> None:
    """任务8.1：把一次真实调用的 usage 落流水；字段缺失/落库异常都不影响主链路"""
    try:
        TokenStatsRepository.record(
            model["id"], kind,
            int(usage.get("prompt_tokens") or 0),
            int(usage.get("completion_tokens") or 0),
            int(usage.get("total_tokens") or 0),
            username)
    except Exception:
        pass


async def _stream_once(model: Dict, body: Dict) -> AsyncIterator[Dict]:
    """单次流式请求：逐块产出事件，最后以 __resp__ 事件交出 HTTPResponse 供外层判错。
    注意：设置 streaming_callback 后响应体（含错误体）只进回调不进 resp.body，
    因此这里同步累积原始字节（raw），供错误详情与兼容性回退判定使用。"""
    queue: asyncio.Queue = asyncio.Queue()
    buffer = ""
    raw = bytearray()

    def on_chunk(chunk: bytes) -> None:
        """streaming_callback 在 IOLoop 线程回调：按行切 SSE，解析 choices.delta 入队"""
        nonlocal buffer
        raw.extend(chunk)
        buffer += chunk.decode("utf-8", "replace")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                queue.put_nowait({"type": "__done__"})
                continue
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            for choice in obj.get("choices") or []:
                delta = choice.get("delta") or {}
                reasoning = delta.get("reasoning_content")
                if reasoning:
                    queue.put_nowait({"type": "reasoning", "text": reasoning})
                content = delta.get("content")
                if content:
                    queue.put_nowait({"type": "delta", "text": content})
            usage = obj.get("usage")
            if usage:
                queue.put_nowait({"type": "usage", "usage": usage})

    request = HTTPRequest(
        _endpoint(model, "/chat/completions"),
        method="POST",
        headers=_headers(model),
        body=json.dumps(body, ensure_ascii=False),
        streaming_callback=on_chunk,
        connect_timeout=10,
        request_timeout=_CHAT_TIMEOUT,
    )
    future = AsyncHTTPClient().fetch(request, raise_error=False)

    # 边流边吐：队列有事件立即产出；请求结束且队列排空后收尾
    while True:
        if not queue.empty():
            event = queue.get_nowait()
        elif future.done():
            break
        else:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.2)
            except asyncio.TimeoutError:
                continue
        if event["type"] == "__done__":
            break
        yield event

    yield {"type": "__resp__", "resp": await future, "raw": bytes(raw)}


async def stream_chat_test(model: Dict, messages: List[Dict], thinking: bool = False) -> AsyncIterator[Dict]:
    """OpenAI 范式流式对话测试。messages 为 [{role, content}, ...] 多轮上下文；
    thinking 仅在模型配置 thinking=1 时生效（思维开关）。事件约定与前台 SSE 一致：
    delta 的 text 为纯文本串，reasoning/usage/notice/error 为对象。

    兼容性回退：部分上游后端（如 DashScope 系商业模型）限制 enable_thinking 只能为 True，
    关闭思维会收到 400；此时去掉思维参数按模型默认行为重试一次，并产出 notice 提示前端。

    任务8.1：调用成功收尾时把本轮 usage 落 token 流水；上游流内未带 usage 时
    按「输入 messages 文本 + 输出正文（含思维链）」估算兜底。"""
    body = {
        "model": model["model_id"],
        "messages": messages,
        "stream": True,
    }
    if model.get("thinking"):
        # 双通道下发思维开关：顶层 enable_thinking（网关常见）+ chat_template_kwargs（vLLM/Qwen）
        body["enable_thinking"] = bool(thinking)
        body["chat_template_kwargs"] = {"enable_thinking": bool(thinking)}

    emitted = False
    resp = None
    raw = b""
    usage: Dict = {}
    answer_parts, reasoning_parts = [], []
    async for event in _stream_once(model, body):
        if event["type"] == "__resp__":
            resp, raw = event["resp"], event["raw"]
            break
        if event["type"] == "usage":
            usage = event.get("usage") or usage
        elif event["type"] == "delta":
            answer_parts.append(event["text"])
        elif event["type"] == "reasoning":
            reasoning_parts.append(event["text"])
        emitted = True
        yield event

    # 尚未吐出任何内容就被拒，且错误指向 enable_thinking 限制 → 去掉思维参数重试
    if (resp is not None and resp.code == 400 and not emitted and not thinking
            and model.get("thinking") and b"enable_thinking" in raw):
        yield {"type": "notice",
               "message": "该模型服务限制 enable_thinking 只能为 True，已按模型默认行为继续测试"}
        fallback = {k: v for k, v in body.items() if k not in ("enable_thinking", "chat_template_kwargs")}
        async for event in _stream_once(model, fallback):
            if event["type"] == "__resp__":
                resp, raw = event["resp"], event["raw"]
                break
            if event["type"] == "usage":
                usage = event.get("usage") or usage
            elif event["type"] == "delta":
                answer_parts.append(event["text"])
            elif event["type"] == "reasoning":
                reasoning_parts.append(event["text"])
            yield event

    if resp is not None and resp.code != 200:
        detail = (raw or resp.body or b"").decode("utf-8", "replace")[:500]
        yield {"type": "error", "message": "模型服务返回 HTTP %s：%s" % (resp.code, detail or resp.error)}
    elif resp is not None and resp.code == 200:
        # 任务8.1：成功调用收尾落账（含估算兜底），随 done 前下发最终 usage 事件
        if not usage:
            prompt_text = "\n".join(str(m.get("content") or "") for m in messages)
            usage = _usage_from_texts(prompt_text, "".join(answer_parts) + "".join(reasoning_parts))
            yield {"type": "usage", "usage": usage}
        _record_usage(model, usage)
    yield {"type": "done"}


async def embedding_test(model: Dict, text: str) -> Dict:
    """嵌入模型测试：POST /embeddings，返回 {dim, preview, usage}；失败抛 RuntimeError"""
    request = HTTPRequest(
        _endpoint(model, "/embeddings"),
        method="POST",
        headers=_headers(model),
        body=json.dumps({"model": model["model_id"], "input": text}, ensure_ascii=False),
        connect_timeout=10,
        request_timeout=_SIMPLE_TIMEOUT,
    )
    resp = await AsyncHTTPClient().fetch(request, raise_error=False)
    if resp.code != 200:
        detail = (resp.body or b"").decode("utf-8", "replace")[:500]
        raise RuntimeError("模型服务返回 HTTP %s：%s" % (resp.code, detail or resp.error))
    obj = json.loads(resp.body.decode("utf-8", "replace"))
    data = (obj.get("data") or [{}])[0]
    vector = data.get("embedding") or []
    usage = obj.get("usage") or {}
    if usage.get("total_tokens"):  # 任务8.1：嵌入调用也落流水
        _record_usage(model, usage)
    return {"dim": len(vector), "preview": vector[:8], "usage": usage}


async def image_test(model: Dict, prompt: str) -> Dict:
    """图片模型测试：POST /images/generations，返回 {images:[{url,b64}...]}；失败抛 RuntimeError"""
    request = HTTPRequest(
        _endpoint(model, "/images/generations"),
        method="POST",
        headers=_headers(model),
        body=json.dumps({"model": model["model_id"], "prompt": prompt, "n": 1, "size": "1024x1024"},
                        ensure_ascii=False),
        connect_timeout=10,
        request_timeout=_SIMPLE_TIMEOUT,
    )
    resp = await AsyncHTTPClient().fetch(request, raise_error=False)
    if resp.code != 200:
        detail = (resp.body or b"").decode("utf-8", "replace")[:500]
        raise RuntimeError("模型服务返回 HTTP %s：%s" % (resp.code, detail or resp.error))
    obj = json.loads(resp.body.decode("utf-8", "replace"))
    images = [{"url": d.get("url") or "", "b64": d.get("b64_json") or ""} for d in (obj.get("data") or [])]
    return {"images": images}

async def embed_texts(model: Dict, texts: List[str]) -> list:
    response = await AsyncHTTPClient().fetch(HTTPRequest(
        _endpoint(model, "/embeddings"), method="POST", headers=_headers(model),
        body=json.dumps({"model": model["model_id"], "input": texts}, ensure_ascii=False),
        connect_timeout=10, request_timeout=_SIMPLE_TIMEOUT))
    rows = sorted(json.loads(response.body)["data"], key=lambda row: row["index"])
    if [row["index"] for row in rows] != list(range(len(texts))):
        raise ValueError("嵌入模型返回了不完整的向量")
    vectors = []
    for row in rows:
        vector = [float(value) for value in row["embedding"]]
        norm = math.hypot(*vector)
        if not norm or not math.isfinite(norm):
            raise ValueError("嵌入模型返回了无效向量")
        vectors.append([value / norm for value in vector])
    return vectors


async def complete_json(model: Dict, instruction: str, content: str) -> Dict:
    if not model:
        raise ValueError("对话模型未配置")
    response = await AsyncHTTPClient().fetch(HTTPRequest(
        _endpoint(model, "/chat/completions"), method="POST", headers=_headers(model),
        body=json.dumps({"model": model["model_id"], "stream": False, "messages": [
            {"role": "system", "content": instruction}, {"role": "user", "content": content},
        ]}, ensure_ascii=False),
        connect_timeout=10, request_timeout=_SIMPLE_TIMEOUT))
    answer = json.loads(response.body)["choices"][0]["message"]["content"].strip()
    if answer.startswith("```") and answer.endswith("```"):
        answer = answer.split("\n", 1)[-1][:-3].strip()
    result = json.loads(answer)
    if not isinstance(result, dict):
        raise ValueError("模型回复必须是 JSON 对象")
    return result
