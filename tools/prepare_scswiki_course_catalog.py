"""Build a local import manifest from the inspected SCSWiki course catalog."""
import argparse
import json
from pathlib import Path
import re


ALIASES = {
    "computer-organization": ["计算机组成原理", "计组"],
    "computer-network": ["计算机网络原理", "计算机网络", "计网"],
    "database-theory": ["数据库原理", "数据库"],
    "discrete-mathematics": ["离散数学"],
    "computer-os": ["计算机操作系统", "操作系统", "计操"],
    "advanced-math": ["高等数学", "高数", "微积分"],
    "c": ["c语言程序设计", "c语言", "c程序设计"],
    "software": ["软件过程项目管理", "软件项目管理", "软件过程"],
    "physics": ["大学物理", "大物"],
    "linear-algebra": ["线性代数", "线代"],
    "web-frontend": ["web前端程序设计", "web前端设计", "web前端", "前端程序设计", "前端实训"],
    "microcontroller": ["单片机原理及应用", "单片机", "stm32", "嵌入式系统基础与实践"],
    "situation-and-policy": ["形势与政策", "形势政策", "形策"],
    "xjp": ["习近平新时代中国特色社会主义思想", "习思想", "习概"],
}

# Reviewed course notes and practice guides. Other listed files keep the original
# link when they are third-party packs, publisher materials, exams or school handouts.
LOCAL_FILES = {
    "computer-network/review-notes.pdf",
    "computer-network/question-bank.pdf",
    "computer-os/exam-review-notes.pdf",
    "advanced-math/review-notes-volume-1.pdf",
    "advanced-math/review-notes-volume-2.pdf",
    "software/review-notes.pdf",
    "microcontroller/stm32-final-exam-study-guide.pdf",
    "microcontroller/stm32-lab-final-exam-study-guide.pdf",
    "microcontroller/embedded-systems-exercises-study-guide.pdf",
    "xjp/final-practice.pdf",
} | {f"xjp/chapter-{number:02d}.pdf" for number in range(1, 18)}


def build_manifest(root):
    source = (root / "docs/.vitepress/materials.ts").read_text(encoding="utf-8")
    rows = []
    used = set()
    for course, block in re.findall(r"(?ms)^  '?([\w-]+)'?: \{\n(.*?)^  \},", source):
        if course not in ALIASES:
            continue
        course_title = re.search(r"title: '([^']+)'", block)[1]
        for group in re.split(r"(?m)^          \{\s*$", block)[1:]:
            group_title = re.search(r"title: '([^']+)'", group)[1]
            for title, path, role in re.findall(
                    r"title: '([^']+)',\s+href: '/materials/([^']+)',\s+format: '[^']+',\s+role: '([^']+)'", group):
                if path in used or not path.startswith(course + "/"):
                    raise ValueError("Unexpected course attachment: " + path)
                used.add(path)
                if not (root / "docs/public/materials" / path).is_file():
                    raise ValueError("Listed file is absent: " + path)
                if title not in group_title and group_title not in title:
                    title = f"{group_title} · {title}"
                if not any(alias in title.casefold() for alias in ALIASES[course]):
                    title = f"{course_title} · {title}"
                original_url = "https://scswiki.com/materials/" + path
                row = {"slug": f"{course}-{Path(path).stem}", "path": path, "title": title,
                       "aliases": ALIASES[course], "scope_title": "SCSWiki · 课程资料",
                       "source_url": "https://scswiki.com/materials/" + course,
                       "exam": bool(re.search(r"复习|题库|试[题卷]|练习|期末|考点|答案|评分", title + role)),
                       "credit": "SCSWiki 贡献者", "license": "CC BY-SA 4.0"}
                if path not in LOCAL_FILES:
                    row.update(external_url=original_url, credit="SCSWiki 资料目录",
                               license="附件许可以原文件或权利人说明为准")
                rows.append(row)
        expected = re.findall(r"href: '/materials/([^']+)'", block)
        if not expected or not set(expected) <= used:
            raise ValueError("Incomplete course catalog: " + course)
    if not LOCAL_FILES <= used or not all(any(row["slug"].startswith(course + "-") for row in rows) for course in ALIASES):
        raise ValueError("Course catalog did not match the reviewed snapshot")
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    entries = build_manifest(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(ALIASES)} courses, {len(LOCAL_FILES)} local files, {len(entries) - len(LOCAL_FILES)} original links")
