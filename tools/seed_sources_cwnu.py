#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""向数据库插入西华师范大学（CWNU）相关信源（幂等，重复执行安全）。

用法（在仓库根执行）：
    .\\venv\\Scripts\\python.exe tools\\seed_sources_cwnu.py

5 个信源：
    1. 西华师范大学新闻网
    2. 四川省教育厅政策公告
    3. 中国研究生招生信息网
    4. 百度资讯-西华师大
    5. 中国大学生就业网
"""
import json
import os
import sys

# 保证从仓库根运行时能正确导入 app 包
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from app.models.db import IntegrityError, get_connection  # noqa: E402

# ---------------------------------------------------------------------------
# 信源定义
# sources 表字段：id, name, url, headers, description, enabled, created_at
# 注：表中无 source_type / update_frequency 列，故不插入该字段
# ---------------------------------------------------------------------------
SOURCES = [
    {
        "name": "西华师范大学新闻网",
        "url": "http://news.cwnu.edu.cn/list.htm",
        "description": "西华师范大学官方新闻，包含学校动态、政策通知、学术活动等",
        "enabled": 1,
        "headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        },
    },
    {
        "name": "四川省教育厅政策公告",
        "url": "https://edu.sc.gov.cn/scjyt/c100630/list_1.shtml",
        "description": "四川省教育厅发布的高等教育政策、毕业生就业、奖学金政策等",
        "enabled": 1,
        "headers": {"User-Agent": "Mozilla/5.0"},
    },
    {
        "name": "中国研究生招生信息网",
        "url": "https://yz.chsi.com.cn/",
        "description": "考研报名、录取信息、各院校招生简章",
        "enabled": 1,
        "headers": {"User-Agent": "Mozilla/5.0"},
    },
    {
        "name": "百度资讯-西华师大",
        "url": (
            "https://www.baidu.com/s?ie=utf-8&bsst=1&rsv_dl=news_b_pn"
            "&tn=news&cl=2&medium=0&rtt=1"
            "&wd={关键字}&pn={分页步长pn=0=第一页，pn=10=第二页}"
        ),
        "description": "百度资讯搜索，用于监测西华师范大学相关舆情",
        "enabled": 1,
        "headers": {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.baidu.com/",
        },
    },
    {
        "name": "中国大学生就业网",
        "url": "https://www.yingjiesheng.com/",
        "description": "应届毕业生就业信息、招聘公告、实习机会",
        "enabled": 1,
        "headers": {"User-Agent": "Mozilla/5.0"},
    },
]


def seed() -> None:
    inserted = 0
    skipped = 0

    with get_connection() as conn:
        for src in SOURCES:
            # 幂等：按 name 检查是否已存在
            row = conn.execute(
                "SELECT id FROM sources WHERE name = ?", (src["name"],)
            ).fetchone()
            if row:
                print(f"  [跳过] 已存在：{src['name']}")
                skipped += 1
                continue

            try:
                conn.execute(
                    "INSERT INTO sources (name, url, headers, description, enabled) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        src["name"],
                        src["url"],
                        json.dumps(src["headers"], ensure_ascii=False),
                        src["description"],
                        src["enabled"],
                    ),
                )
                print(f"  [插入] {src['name']}")
                inserted += 1
            except IntegrityError:
                # 极罕见的并发竞态：name 唯一约束触发
                print(f"  [跳过] 并发冲突（name 唯一约束）：{src['name']}")
                skipped += 1

    print()
    print("=" * 50)
    print(f"执行摘要：共 {len(SOURCES)} 个信源")
    print(f"  新增：{inserted} 个")
    print(f"  跳过：{skipped} 个（已存在）")
    print("=" * 50)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print("西华师范大学信源种子脚本启动…")
    print()
    seed()
    print("完成。")
