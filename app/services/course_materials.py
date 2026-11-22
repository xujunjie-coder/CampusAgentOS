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
    filename = material["original"] if download else material["preview"]
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
        if str(item["scope_id"]) in bound
        and any(alias in normalized for alias in item["aliases"])
        and (reference_url(item) or (file_path(item, False) and file_path(item, True)))
    ]


def listing_reply(query, materials):
    if not materials or not re.search(r"资料|复习提纲|题库|练习题|(?:历年|期末)试[题卷]|真题|预测题|讲义|文档|课件|下载|预览|PDF|Word", query, re.I):
        return ""
    if not re.search(r"有没有|有没|是否有|有哪些|有.*吗|找|推荐|下载|预览|给我|发我|想要|(?:期末|复习|开卷|课程)资料\s*[？?。]?$", query):
        return ""
    if re.search(r"解释|怎么|为什么|区别|原理是什么|举例", query):
        return ""
    if re.search(r"期末|开卷|考试|真题|预测题", query):
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
    if all(not reference_url(item) for _, item in materials):
        lines.append("\n资料为本校学长学姐整理，考试范围以任课教师通知为准。")
    else:
        lines.append("\n考试范围以任课教师通知为准。")
    return "\n".join(lines)
