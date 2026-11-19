"""Loopback MCP endpoint for the bundled public-news search tool."""
import hmac
import json

from tornado.web import HTTPError, RequestHandler

from app.services.mcp_service import LOCAL_TOKEN, SEARCH_TOOL, VERSION, search_public_news


class NewsMcpHandler(RequestHandler):
    def check_xsrf_cookie(self):
        # Protocol calls use a process-local bearer token instead of browser cookies.
        pass

    def prepare(self):
        token = self.request.headers.get("Authorization", "").encode("utf-8")
        if (self.request.remote_ip not in ("127.0.0.1", "::1") or
                "Origin" in self.request.headers or
                not hmac.compare_digest(token, ("Bearer " + LOCAL_TOKEN).encode("ascii"))):
            raise HTTPError(403)

    async def post(self):
        try:
            message = json.loads(self.request.body)
        except (ValueError, UnicodeError):
            self.reply(None, code=-32700, error="Invalid JSON")
            return
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            self.reply(None, code=-32600, error="Invalid request")
            return
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params", {})
        if not isinstance(params, dict):
            self.reply(request_id, code=-32602, error="Invalid params")
            return
        if method == "initialize":
            self.reply(request_id, result={"protocolVersion": VERSION, "capabilities": {"tools": {}},
                                           "serverInfo": {"name": "govcheck-news", "version": "1.0"}})
            return
        if self.request.headers.get("MCP-Protocol-Version", VERSION) != VERSION:
            raise HTTPError(400)
        if method == "notifications/initialized" and "id" not in message:
            self.set_status(202)
        elif method == "tools/list":
            self.reply(request_id, result={"tools": [{
                "name": SEARCH_TOOL,
                "description": "查询公开新闻并返回标题、发布时间与链接。",
                "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}},
                                "required": ["query"]},
            }]})
        elif method == "tools/call":
            arguments = params.get("arguments")
            query = arguments.get("query") if isinstance(arguments, dict) else None
            if params.get("name") != SEARCH_TOOL or not isinstance(query, str) or not query.strip() or len(query) > 80:
                self.reply(request_id, code=-32602, error="Invalid tool or query")
                return
            try:
                rows = await search_public_news(query.strip())
            except (ValueError, OSError):
                self.reply(request_id, result={"isError": True, "content": [
                    {"type": "text", "text": "新闻订阅服务暂不可用"},
                ]})
                return
            data = {"news": rows}
            self.reply(request_id, result={"structuredContent": data, "content": [
                {"type": "text", "text": json.dumps(data, ensure_ascii=False)},
            ]})
        else:
            self.reply(request_id, code=-32601, error="Unknown method")

    def reply(self, request_id, *, result=None, code=None, error=None):
        response = {"jsonrpc": "2.0", "id": request_id}
        if code is None:
            response["result"] = result
        else:
            response["error"] = {"code": code, "message": error}
        self.write(response)
