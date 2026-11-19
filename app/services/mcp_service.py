"""Client for a configured MCP Streamable HTTP search tool (2025-11-25)."""
import asyncio
import json
import os
import secrets
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree

from tornado.httpclient import AsyncHTTPClient, HTTPRequest

from app.config import APP_PORT

VERSION = "2025-11-25"
SEARCH_TOOL = "search_public_news"
LOCAL_TOKEN = secrets.token_urlsafe(32)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


async def search_public_news(query):
    """Fetch matching public news from the Google News search feed."""
    return await asyncio.to_thread(fetch_news, query)


def fetch_news(query):
    params = urlencode({"q": query, "hl": "zh-CN", "gl": "CN", "ceid": "CN:zh-Hans"})
    request = Request("https://news.google.com/rss/search?" + params, headers={
        "User-Agent": "Mozilla/5.0", "Accept": "application/rss+xml, application/xml"})
    try:
        with build_opener(NoRedirect()).open(request, timeout=8) as response:
            body = response.read(2_000_001)
        if len(body) > 2_000_000 or b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
            raise ValueError("Unsupported RSS content")
        root = ElementTree.fromstring(body)
    except (OSError, ElementTree.ParseError) as exc:
        raise ValueError("News feed unavailable") from exc
    if root.tag != "rss":
        raise ValueError("Expected an RSS feed")
    rows = []
    for item in root.findall("./channel/item")[:6]:
        title, url = item.findtext("title", "").strip(), item.findtext("link", "").strip()
        if title and urlsplit(url).scheme == "https" and len(url) <= 500:
            rows.append({"title": title[:200], "url": url, "published_at": item.findtext("pubDate", "")[:80],
                         "source": item.findtext("source", "")[:100]})
    return rows


async def mcp_search(keyword: str) -> str:
    """Search the Internet for public news and return source material."""
    keyword = keyword.strip()[:80]
    configured_url = os.getenv("MCP_URL")
    url = configured_url or f"http://127.0.0.1:{APP_PORT}/mcp/news"
    name = (os.getenv("MCP_SEARCH_TOOL") or SEARCH_TOOL) if configured_url else SEARCH_TOOL
    endpoint = urlsplit(url)
    if (not keyword or not name or
            not (endpoint.scheme == "https" or
                 (endpoint.scheme == "http" and endpoint.hostname in ("localhost", "127.0.0.1", "::1")))):
        return "MCP 新闻搜索不可用"
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    token = os.getenv("MCP_TOKEN") if configured_url else LOCAL_TOKEN
    if token:
        headers["Authorization"] = "Bearer " + token
    client = AsyncHTTPClient()

    async def send(method, params=None, request_id=None):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if request_id is not None:
            payload["id"] = request_id
        response = await client.fetch(HTTPRequest(
            url, method="POST", headers=headers, body=json.dumps(payload, ensure_ascii=False),
            connect_timeout=5, request_timeout=15, follow_redirects=False))
        if len(response.body) > 262144:
            raise ValueError("MCP response too large")
        if request_id is None:
            return {}, response.headers
        body = response.body.decode("utf-8")
        if response.headers.get("Content-Type", "").startswith("text/event-stream"):
            frames = body.replace("\r\n", "\n").split("\n\n")
            replies = [json.loads(data) for frame in frames if (data := "\n".join(
                line[5:].lstrip() for line in frame.splitlines() if line.startswith("data:")))]
        else:
            replies = [json.loads(body)]
        for reply in replies:
            if reply.get("id") == request_id:
                return reply["result"], response.headers
        raise ValueError("MCP 未返回对应结果")

    try:
        result, response_headers = await send("initialize", {
            "protocolVersion": VERSION, "capabilities": {},
            "clientInfo": {"name": "GovCheckDataAgentOS", "version": "1.0"},
        }, 1)
        if result.get("protocolVersion") != VERSION or "tools" not in result.get("capabilities", {}):
            return "MCP 服务不支持所需版本或工具能力"
        headers["MCP-Protocol-Version"] = VERSION
        if response_headers.get("Mcp-Session-Id"):
            headers["Mcp-Session-Id"] = response_headers["Mcp-Session-Id"]
        await send("notifications/initialized")
        result, _ = await send("tools/call", {"name": name, "arguments": {"query": keyword}}, 2)
        if result.get("isError"):
            return "MCP 新闻搜索执行失败"
        return json.dumps(result.get("structuredContent", result.get("content", [])),
                          ensure_ascii=False)[:6000]
    except Exception:
        return "MCP 新闻搜索暂不可用"
    finally:
        if "Mcp-Session-Id" in headers:
            try:
                await client.fetch(HTTPRequest(url, method="DELETE", headers=headers,
                                               request_timeout=3, follow_redirects=False))
            except Exception:
                pass
