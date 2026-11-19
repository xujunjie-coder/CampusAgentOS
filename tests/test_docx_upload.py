"""tests/test_docx_upload.py — 测试 .docx 文件解析辅助函数。

运行方式（在项目根目录）：
    venv\\Scripts\\python.exe -m pytest tests/test_docx_upload.py -v
"""
import io
import sys
import os

import pytest

# 确保能 import 项目包
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _make_docx_bytes(paragraphs: list[str]) -> bytes:
    """用 python-docx 在内存中生成包含指定段落的 .docx 字节流。"""
    import docx

    doc = docx.Document()
    for text in paragraphs:
        doc.add_paragraph(text)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ------------------------------------------------------------------
# 导入被测函数
# ------------------------------------------------------------------
from app.controllers.intelligence import _extract_docx_text


class TestExtractDocxText:
    """_extract_docx_text 单元测试。"""

    def test_basic_paragraphs(self):
        """正常段落能被正确提取并以换行拼接。"""
        raw = _make_docx_bytes(["第一段", "第二段", "第三段"])
        result = _extract_docx_text(raw)
        assert "第一段" in result
        assert "第二段" in result
        assert "第三段" in result

    def test_empty_paragraphs_stripped(self):
        """空白段落不应出现在输出中。"""
        raw = _make_docx_bytes(["有内容", "", "   ", "也有内容"])
        result = _extract_docx_text(raw)
        lines = result.split("\n")
        assert all(line.strip() != "" for line in lines)

    def test_chinese_content(self):
        """中文内容能被正确保留。"""
        raw = _make_docx_bytes(["西华师范大学成立于1946年，位于四川省南充市。"])
        result = _extract_docx_text(raw)
        assert "西华师范大学" in result
        assert "南充市" in result

    def test_invalid_bytes_raises_value_error(self):
        """传入非 docx 字节时应抛出 ValueError。"""
        with pytest.raises(ValueError, match="无法解析"):
            _extract_docx_text(b"this is not a docx file at all")

    def test_returns_string(self):
        """返回值始终为 str 类型。"""
        raw = _make_docx_bytes(["测试"])
        result = _extract_docx_text(raw)
        assert isinstance(result, str)
