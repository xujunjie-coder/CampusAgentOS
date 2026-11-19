"""
对话导出 PDF 服务层 —— 成员 D（任务2：对话导出 PDF）
用 reportlab Platypus 把某个会话的 messages 渲染成真实 PDF 字节流：
- 中文用 reportlab 内置 CID 字体 STSong-Light（无需外部字体文件，全离线）
- 消息正文先 xhtml_escape 再进 Paragraph，防标签注入
- 调用方（controllers/chat_export.py）已按 username 过滤，本层只管排版
"""

import re
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer

from tornado.escape import xhtml_escape

_FONT = "STSong-Light"
_font_ready = False

# 消息角色 → 展示名（assistant 优先用应答数字员工名，与历史气泡口径一致）
_ROLE_FALLBACK = {"user": "我", "assistant": "助手", "system": "系统", "tool": "工具"}


def _ensure_font() -> None:
    """CID 中文字体幂等注册（重复注册 reportlab 也允许，这里只做一次）"""
    global _font_ready
    if not _font_ready:
        pdfmetrics.registerFont(UnicodeCIDFont(_FONT))
        _font_ready = True


def _styles() -> dict:
    return {
        "title": ParagraphStyle("t", fontName=_FONT, fontSize=16, leading=22,
                                spaceAfter=6, textColor=colors.HexColor("#1f2d3d")),
        "meta": ParagraphStyle("m", fontName=_FONT, fontSize=9, leading=13,
                               textColor=colors.HexColor("#7a8899")),
        "who": ParagraphStyle("w", fontName=_FONT, fontSize=10.5, leading=15,
                              spaceBefore=8, textColor=colors.HexColor("#2e6da4")),
        "body": ParagraphStyle("b", fontName=_FONT, fontSize=10.5, leading=17,
                               textColor=colors.HexColor("#333d47")),
    }


def _safe(text: str) -> str:
    """转义 HTML 并把连续空行压成单个 <br/>，保持段落可读"""
    cleaned = re.sub(r"\r\n?", "\n", str(text or ""))
    return xhtml_escape(cleaned).replace("\n", "<br/>")


def build_chat_pdf(username: str, session_id: str, messages: list) -> bytes:
    """把消息列表（MessageRepository.list_recent 的输出）渲染为 PDF，返回字节流。
    messages 为空时生成一页「无记录」占位文档，调用方可据此提示用户。"""
    _ensure_font()
    st = _styles()
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=18 * mm, bottomMargin=16 * mm,
                            leftMargin=16 * mm, rightMargin=16 * mm,
                            title="对话记录_%s" % session_id, author=username)
    story = [
        Paragraph("GovAgentOS 对话记录导出", st["title"]),
        Paragraph("用户：%s　会话：%s　消息数：%d" % (
            xhtml_escape(username), xhtml_escape(session_id), len(messages)), st["meta"]),
        Spacer(1, 4 * mm),
        HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#d9e1ec")),
    ]
    if not messages:
        story.append(Paragraph("（该会话暂无消息记录）", st["body"]))
    for m in messages:
        who = _ROLE_FALLBACK.get(m.get("role"), m.get("role") or "?")
        if m.get("role") == "assistant" and m.get("employee_name"):
            who = "%s（%s）" % (who, m["employee_name"])
        story.append(Paragraph("%s · %s" % (xhtml_escape(who),
                                            xhtml_escape(m.get("created_at") or "")), st["who"]))
        content = _safe(m.get("content")) or "（空消息）"
        if m.get("is_partial"):
            content += "<br/><font color='#c0392b'>（该条回复中断，内容不完整）</font>"
        story.append(Paragraph(content, st["body"]))
    doc.build(story)
    return buf.getvalue()
