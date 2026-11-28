"""Add or refresh the official CWNU search source without browser cookies."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.models.source import SourceRepository
from app.services.cwnu_source import SOURCE_URL, is_source


def main():
    name = "西华师范大学官网"
    description = "学校官网公开搜索，支持关键词及分页；保留原文链接与发布日期，搜索索引覆盖不代表全校最新政策。"
    existing = next((s for s in SourceRepository.get_all() if s["name"] == name or is_source(s["url"])), None)
    if existing:
        error = SourceRepository.update(existing["id"], url=SOURCE_URL, headers={},
                                        description=description, enabled=1)
        if error:
            raise ValueError(error)
        print("Updated official CWNU source", existing["id"])
    else:
        if not SourceRepository.create(name, SOURCE_URL, headers={}, description=description):
            raise ValueError("Could not create official CWNU source")
        print("Created official CWNU source")


if __name__ == "__main__":
    main()
