"""tests/test_frontend_theme.py — 验证前台「方案A：现代校园白蓝风」模板语法与关键 DOM 契约。"""
import os
import sys

import tornado.template

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TEMPLATE_DIR = os.path.join(BASE_DIR, "app", "templates")
STATIC_DIR = os.path.join(BASE_DIR, "app", "static")


def _read_utf8(rel_path: str) -> str:
    full = os.path.join(BASE_DIR, rel_path)
    with open(full, "r", encoding="utf-8") as f:
        return f.read()


def test_all_frontend_templates_compile():
    """所有修改过的前台 Tornado 模板都能正常解析编译，无语法错误。"""
    loader = tornado.template.Loader(TEMPLATE_DIR)
    for name in ("index.html", "login.html", "register.html", "avatar.html", "qa.html", "user.html"):
        tpl = loader.load(name)
        assert tpl is not None, f"Failed to load template: {name}"


def test_index_preserves_critical_dom_ids_and_cwnu_branding():
    """主对话页保留全部 JS 绑定 ID，并包含西华师大品牌与快捷门户入口。"""
    html = _read_utf8("app/templates/index.html")
    required_ids = [
        "chatApp", "sideAgentIcon", "sideAgentName", "sideAgentDesc",
        "clearBtn", "chatHistoryTab", "chatArchiveTab", "chatSessionList",
        "chatSideFoot", "sideFootToggle", "faceEntry", "exportPdfBtn",
        "chatAsst", "chatAsstBtn", "chatAsstPanel", "chatAsstList",
        "composerForm", "chatInput", "sendBtn", "faceMask",
    ]
    for dom_id in required_ids:
        assert f'id="{dom_id}"' in html, f"Missing DOM id in index.html: {dom_id}"
    assert "西华师大 · 智慧校园" in html
    assert "华小竹 3D 虚拟辅导员" in html
    assert "校园智能问数" in html


def test_chat_welcome_cards_and_style_a_tokens():
    """chat.js 包含三大校园欢迎卡片，chat.css 应用方案A白蓝配色变量。"""
    js = _read_utf8("app/static/js/chat.js")
    css = _read_utf8("app/static/css/chat.css")
    assert "你好，欢迎来到西华师大智慧校园" in js
    assert "学业与奖助" in js
    assert "就业与升学" in js
    assert "心理与生活" in js
    assert "js-prompt-chip" in js
    assert "cwnuConfirm" in js
    assert "window.confirm(" not in js
    assert "--cwnu-navy: #003087" in css
    assert ".chat-welcome-grid" in css
    assert ".cwnu-modal-card" in css


def test_login_and_register_cwnu_branding():
    """登录与注册页已更新为西华师范大学智慧校园文案且保留表单与人脸登录控件。"""
    login_html = _read_utf8("app/templates/login.html")
    reg_html = _read_utf8("app/templates/register.html")
    assert "CWNU SMART CAMPUS AGENT OS" in login_html
    assert "智慧华师" in login_html
    assert 'id="tabFace"' in login_html
    assert 'id="faceVideo"' in login_html
    assert "CWNU SMART CAMPUS AGENT OS" in reg_html
    assert 'name="confirm"' in reg_html


def test_avatar_qa_user_pages_consistent_style_a():
    """3D 数字人、智能问数、个人中心均统一为方案A白蓝配色并保留核心控件。"""
    avatar_html = _read_utf8("app/templates/avatar.html")
    avatar_css = _read_utf8("app/static/css/avatar.css")
    qa_css = _read_utf8("app/static/css/qa.css")
    user_css = _read_utf8("app/static/css/user.css")

    assert 'id="avatarQuickBar"' in avatar_html
    assert 'id="avatarStage"' in avatar_html
    assert "--cwnu-navy: #003087" in avatar_css
    assert "--cwnu-navy: #003087" in qa_css
    assert "--cwnu-navy: #003087" in user_css
