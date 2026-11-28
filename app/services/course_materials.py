"""Local catalog of course files that have been cleared for hosting."""
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from app import config

ROOT = Path(config.DB_PATH).with_name("course-materials")
CATALOG = "catalog.json"
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def catalog():
    try:
        return json.loads((ROOT / CATALOG).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def file_path(material, download):
    filename = material.get("original" if download else "preview", "")
    if not re.fullmatch(r"[a-z0-9-]+\.(?:pdf|docx)", filename):
        return None
    path = ROOT / filename
    return path if path.is_file() else None


def reference_url(material):
    url = material.get("external_url", "")
    try:
        parsed = urlsplit(url)
    except ValueError:
        return ""
    if (parsed.scheme == "https" and parsed.netloc == "scswiki.com"
            and re.fullmatch(r"/materials/[a-z0-9-]+/[a-z0-9-]+\.(?:pdf|zip)", parsed.path)
            and not parsed.query and not parsed.fragment):
        return url
    return ""


def material_index(query, ids):
    """Return locally hosted materials matching a named course and assistant scope."""
    normalized = re.sub(r"\s+", "", query.casefold())
    bound = set(map(str, ids))
    return [
        (slug, item) for slug, item in catalog().items()
        if ({str(item.get("scope_id", "")), str(item.get("knowledge_id", ""))} & bound)
        and any(alias in normalized for alias in item["aliases"])
        and (reference_url(item) or (file_path(item, False) and file_path(item, True)))
    ]


def _local_materials(materials):
    return [(slug, item) for slug, item in materials
            if file_path(item, False) and file_path(item, True)]


def available_local_materials(ids):
    bound = set(map(str, ids))
    return [(slug, item) for slug, item in catalog().items()
            if ({str(item.get("scope_id", "")), str(item.get("knowledge_id", ""))} & bound)
            and file_path(item, False) and file_path(item, True)]


def listing_reply(query, materials):
    if not materials or not re.search(r"资料|复习提纲|题库|练习题|(?:历年|期末)试[题卷]|真题|预测题|讲义|文档|课件|下载|预览|PDF|Word", query, re.I):
        return ""
    explicit_request = re.search(r"有没有|有没|是否有|有哪些|有.*吗|找|推荐|下载|预览|给我|发我|想要", query)
    short_material_query = (len(query.strip()) <= 80 and
                            re.search(r"(?:资料|讲义|课件)\s*[？?。！!]*$", query))
    if not (explicit_request or short_material_query):
        return ""
    if re.search(r"解释|怎么|为什么|区别|原理是什么|举例|总结|整理|生成|讲解|讲讲|复习一下", query):
        return ""
    local = _local_materials(materials)
    # Prefer a copy actually stored on this server. Only expose SCSWiki file links
    # when there is no matching local copy for the requested course.
    if local:
        materials = local
    else:
        materials = [(slug, item) for slug, item in materials if reference_url(item)]
    if re.search(r"真题|试卷|预测题|题库|习题|练习题|答案", query):
        focused = [(slug, item) for slug, item in materials if item.get("exam")]
        if focused:
            materials = focused
    materials = sorted(materials, key=lambda entry: bool(reference_url(entry[1])))
    lines = []
    for slug, item in materials:
        url = f"/api/course-materials/{slug}"
        external = reference_url(item)
        if external:
            preview = f" · [预览]({url}/preview)" if external.endswith(".pdf") else ""
            lines.append(f'- **{item["title"]}**{preview} · [原站文件]({external})')
        else:
            lines.append(f'- **{item["title"]}** · [预览]({url}/preview) · [下载]({url}/download)')
    if local:
        credits = sorted({f"{item.get('credit', '资料贡献者')}（{item.get('license', '许可见原文件')}）"
                          for _, item in materials})
        lines.append("\n以上为本站已收录的本地附件；署名与许可：" + "；".join(credits) + "。考试范围以任课教师通知为准。")
    else:
        lines.append("\n本站暂未收录匹配的本地附件，以上为 SCSWiki 原站资料入口；考试范围以任课教师通知为准。")
    return "\n".join(lines)
