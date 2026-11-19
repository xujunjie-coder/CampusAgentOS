"""Admin pages and authenticated actions for RAG and risk reviews."""
import io
import logging

import tornado.web
from tornado.ioloop import PeriodicCallback
from tornado.websocket import WebSocketClosedError, WebSocketHandler

from app.controllers.admin import AdminBaseHandler, AdminGuard, backend_required
from app.models import intelligence
from app.services.intelligence_service import index_document, review_pending


def _extract_doc_text(raw_bytes: bytes) -> str:
    """从旧版 .doc（OLE2 二进制格式）中提取纯文本。

    实现思路：
      1. 用 olefile 打开 OLE2 容器，读取 WordDocument 流（原始字节）。
      2. Word97-2003 正文段落存储在 WordDocument 流 + Table 流中；
         最简单的无依赖方法是扫描 WordDocument 流，取出所有
         ASCII/GBK/UTF-16LE 字符序列（段落标记为 0x0D）。
      3. 以 UTF-16LE 解码尝试（Word 内部存储为 Unicode）；
         失败则回退 GBK，再失败则 latin-1。
    依赖 olefile（已在 venv，0.47）；解析失败时抛出 ValueError。
    """
    try:
        import olefile  # noqa: PLC0415
    except ImportError as exc:
        raise ValueError("服务器未安装 olefile，无法解析 .doc 文件") from exc

    try:
        ole = olefile.OleFileIO(io.BytesIO(raw_bytes))
    except Exception as exc:
        raise ValueError(f"不是合法的 .doc（OLE2）文件：{exc}") from exc

    # Word 正文流名称（Word 97-2003 固定）
    if not ole.exists("WordDocument"):
        raise ValueError("文件缺少 WordDocument 流，可能不是 Word .doc 格式")

    raw = ole.openstream("WordDocument").read()
    ole.close()

    # Word97 文件头偏移 0x18(24) 存储 FIB.fcMin，0x1C(28) 存储 FIB.ccpText（字符数）
    # 偏移 0x0B(11) bit0=1 表示文档使用 Unicode（UTF-16LE）
    try:
        fib_flags = raw[11]
        is_unicode = bool(fib_flags & 0x01)
        # fcMin：正文在 WordDocument 流中的起始字节偏移
        fc_min = int.from_bytes(raw[24:28], "little")
        # ccpText：正文字符数
        ccp_text = int.from_bytes(raw[28:32], "little")

        if is_unicode and ccp_text > 0:
            char_bytes = ccp_text * 2
            text_raw = raw[fc_min: fc_min + char_bytes]
            text = text_raw.decode("utf-16-le", errors="ignore")
        else:
            text_raw = raw[fc_min: fc_min + ccp_text]
            # 尝试 GBK（中文 Word 文档常见编码），回退 latin-1
            for enc in ("gbk", "latin-1"):
                try:
                    text = text_raw.decode(enc, errors="ignore")
                    break
                except Exception:
                    continue
            else:
                text = text_raw.decode("latin-1", errors="replace")
    except Exception:
        # 回退：直接扫描全流，提取可打印 Unicode 字符块
        try:
            text = raw.decode("utf-16-le", errors="ignore")
        except Exception:
            text = raw.decode("gbk", errors="ignore")

    # 清理：段落分隔符 \r（0x0D）→ 换行；去掉控制字符
    text = text.replace("\r", "\n").replace("\x07", "\n")
    lines = [ln for ln in text.splitlines() if ln.strip() and not all(ord(c) < 32 for c in ln)]
    result = "\n".join(lines).strip()

    if not result:
        raise ValueError("未能从 .doc 文件中提取到可用文本，请改用 .docx 或 .txt 格式")
    return result


def _extract_docx_text(raw_bytes: bytes) -> str:
    """从 .docx 二进制内容中提取纯文本（段落以换行拼接）。

    依赖 python-docx；解析失败时抛出 ValueError。
    """
    try:
        import docx  # noqa: PLC0415
    except ImportError as exc:
        raise ValueError("服务器未安装 python-docx，无法解析 .docx 文件") from exc
    try:
        doc = docx.Document(io.BytesIO(raw_bytes))
        lines = [para.text for para in doc.paragraphs if para.text.strip()]
        return "\n".join(lines)
    except Exception as exc:
        raise ValueError(f"无法解析 .docx 文件：{exc}") from exc


class KnowledgeHandler(AdminBaseHandler):
    nav_url = "/admin/knowledge"
    template_name = "admin/knowledge.html"
    page_name = "知识仓库"

    def get_context(self):
        return {"documents": intelligence.documents(), "error": ""}

    @tornado.web.authenticated
    @backend_required
    async def post(self):
        if not self.require_menu(self.nav_url):
            return
        action = self.get_body_argument("action", "")
        if action == "remove":
            doc_id = self.get_body_argument("doc_id", "")
            if not doc_id.isascii() or not doc_id.isdigit() or len(doc_id) > 18:
                raise tornado.web.HTTPError(400)
            intelligence.remove_document(int(doc_id))
        elif action == "index":
            title = self.get_body_argument("title", "").strip()
            content = self.get_body_argument("content", "").strip()
            uploaded = self.request.files.get("document", [])
            try:
                if uploaded and not content:
                    file = uploaded[0]
                    fname = file.filename.lower()
                    if len(file.body) > 300000:
                        raise ValueError("请选择 300 KB 以内的文件")
                    if fname.endswith((".md", ".txt")):
                        content = file.body.decode("utf-8-sig").strip()
                    elif fname.endswith(".docx"):
                        content = _extract_docx_text(file.body)
                    elif fname.endswith(".doc"):
                        content = _extract_doc_text(file.body)
                    else:
                        raise ValueError("请选择 TXT、Markdown、Word .docx 或旧版 Word .doc 文件")
                    title = title or file.filename
                if not title or len(title) > 160 or not content or len(content) > 40000:
                    raise ValueError("请输入标题和正文，标题最多 160 字，正文最多 4 万字")
                await index_document(title, content)
            except UnicodeDecodeError:
                self.render_admin(documents=intelligence.documents(), error="请上传 UTF-8 文档")
                return
            except ValueError as exc:
                self.render_admin(documents=intelligence.documents(), error=str(exc))
                return
            except Exception:
                logging.exception("Knowledge indexing failed")
                self.render_admin(documents=intelligence.documents(), error="向量入库失败，请检查嵌入模型配置")
                return
        else:
            raise tornado.web.HTTPError(400)
        self.redirect(self.nav_url, status=303)


class SentimentHandler(AdminBaseHandler):
    nav_url = "/admin/sentiment"
    template_name = "admin/sentiment.html"
    page_name = "智能舆情"

    def get_context(self):
        return {"reviews": intelligence.reviews()}

    @tornado.web.authenticated
    @backend_required
    async def post(self):
        if not self.require_menu(self.nav_url):
            return
        result = await review_pending()
        if self.request.headers.get("X-Requested-With") == "XMLHttpRequest":
            self.write_json({"ok": True, "busy": result is None, "result": result})
            return
        self.redirect(self.nav_url, status=303)



class SentimentSocket(WebSocketHandler, AdminGuard):
    """Stream changed risk results to authorized dashboard sessions."""
    api = True

    def prepare(self):
        if not self.current_user:
            raise tornado.web.HTTPError(401)
        if not self.require_menu("/admin/sentiment"):
            return

    def open(self):
        self.last_rows = None
        self.refresh = PeriodicCallback(self.publish, 3000)
        self.refresh.start()
        return self.publish()

    async def publish(self):
        rows = intelligence.reviews()
        if rows == self.last_rows:
            return
        try:
            await self.write_message({"reviews": rows})
        except WebSocketClosedError:
            return
        self.last_rows = rows

    def on_close(self):
        if hasattr(self, "refresh"):
            self.refresh.stop()
