"""
seed_employees.py —— 西华师范大学数字员工种子脚本

向 digital_employees 表写入3个西华师范大学专属数字员工。
幂等执行：已存在同名员工则跳过，不报错、不覆盖。

用法（在项目根目录下执行）：
    python tools/seed_employees.py

依赖：app/models/db.py 中的 get_connection()（会自动读取 .env 配置）
"""

import json
import sys
import os

# 把项目根目录加入 sys.path，使 app.models.db 可被正常 import
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from app.models.db import get_connection  # noqa: E402


# ─────────────────────────── 员工数据 ───────────────────────────

EMPLOYEES = [
    {
        "name": "华师小助手",
        "description": "校园综合助手",
        "avatar": "fas fa-graduation-cap",
        "enabled": 1,
        "is_default": 1,
        "instructions": """你是西华师范大学的官方智能助手，名叫"华师小助手"。

## 你的职责
- 解答学生关于校规校纪、教务政策、奖学金申请的问题
- 提供校园生活指导（图书馆、宿舍、食堂等）
- 帮助查询考试安排、课程选择建议
- 推荐适合的学习资源和校内活动

## 回答原则
1. 只回答与西华师范大学相关的问题
2. 信息来源优先使用知识库中的官方文件
3. 不确定的信息要明确说明"请以官网公告为准"
4. 语气友好、简洁、鼓励学生
5. 对涉及个人隐私或敏感内容，建议联系相关部门

## 禁止事项
- 不得捏造学校政策和数据
- 不得替代心理咨询专业服务
- 不得承诺无法确认的事项

西华师范大学简介：位于四川省南充市，建校于1946年，是四川省属重点大学，以教师教育为特色，拥有全国最大的自然博物馆之一。""",
    },
    {
        "name": "就业顾问",
        "description": "就业指导专家",
        "avatar": "fas fa-briefcase",
        "enabled": 1,
        "is_default": 0,
        "instructions": """你是西华师范大学就业指导中心的AI就业顾问。

## 你的专长
- 分析当前四川省及全国的就业形势
- 提供简历优化建议（教师教育类、理工类、文科类）
- 解读毕业生就业补贴政策（市级、省级、国家级）
- 推荐适合西华师大毕业生的就业方向（教育行业优先）
- 协助备考教师资格证、公务员、事业单位

## 核心能力
对毕业生提问时，优先结合西华师大的专业背景和地方就业市场特点给出建议。

## 回答风格
专业、务实、充满正能量。给出可操作的具体建议，而非笼统的鼓励。

注意：就业数据以官方最新发布为准，建议学生同时关注学校就业处官方通知。""",
    },
    {
        "name": "心理健康助手",
        "description": "心理健康支持",
        "avatar": "fas fa-heart",
        "enabled": 1,
        "is_default": 0,
        "instructions": """你是西华师范大学学生心理健康中心的AI支持助手。

## ⚠️ 重要声明（每次会话必须说明）
我是AI助手，不能替代专业心理咨询。如你遇到严重心理困扰，请立即：
- 联系学校心理咨询中心
- 拨打全国心理援助热线：400-161-9995
- 拨打北京心理危机研究与干预中心：010-82951332
- 拨打全国24小时自杀干预热线：400-821-1215

## 我能做什么
- 倾听你的心声，给予情感支持
- 分享减压技巧（冥想、运动、时间管理）
- 解释常见的心理现象（焦虑、抑郁征兆的一般性说明）
- 推荐校内外心理健康资源
- 鼓励你勇敢寻求专业帮助

## 安全红线（必须遵守）
- 检测到自伤/自杀意图：立即提供危机热线，劝其联系专业人员
- 不进行任何诊断
- 不给出任何药物建议
- 不替代心理治疗""",
    },
]


# ─────────────────────────── 插入逻辑 ───────────────────────────

def seed():
    """把 EMPLOYEES 写入数据库；已存在同名员工跳过（幂等）。返回 (inserted, skipped) 计数。"""
    inserted = 0
    skipped = 0

    with get_connection() as conn:
        # 检查表内是否已有 is_default=1 的员工（影响新员工 is_default 写法）
        existing_default = conn.execute(
            "SELECT COUNT(*) AS c FROM digital_employees WHERE is_default = 1"
        ).fetchone()["c"] > 0

        for emp in EMPLOYEES:
            # 幂等检查：按 name 判断是否已存在
            row = conn.execute(
                "SELECT id FROM digital_employees WHERE name = ?", (emp["name"],)
            ).fetchone()

            if row:
                print(f"  [跳过] {emp['name']}（已存在，id={row['id']}）")
                skipped += 1
                continue

            # is_default 策略：
            # - 若表内已有默认员工，则新员工 is_default=0（哪怕配置里写 1，也不抢默认位）
            # - 若表内没有默认员工，才按配置写 is_default=1
            is_default = emp["is_default"] if not existing_default else 0
            # 一旦插入一个 is_default=1 的员工，后续员工不再争默认位
            if is_default:
                existing_default = True

            conn.execute(
                "INSERT INTO digital_employees "
                "(name, description, avatar, instructions, link_files, tools, "
                "workspace_path, model_binding, rag_kb_ids, enabled, is_default, "
                "enable_long_term_memory, enable_experience_capture) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    emp["name"],
                    emp["description"],
                    emp["avatar"],
                    emp["instructions"],
                    json.dumps([], ensure_ascii=False),   # link_files
                    json.dumps([], ensure_ascii=False),   # tools
                    "workspace",                          # workspace_path
                    "",                                   # model_binding（空=使用系统默认）
                    json.dumps([], ensure_ascii=False),   # rag_kb_ids
                    emp["enabled"],
                    is_default,
                    1,                                    # enable_long_term_memory
                    1,                                    # enable_experience_capture
                ),
            )
            print(f"  [插入] {emp['name']}（description={emp['description']}，is_default={is_default}）")
            inserted += 1

    return inserted, skipped


# ─────────────────────────── 入口 ───────────────────────────

def main():
    print("=" * 60)
    print("西华师范大学数字员工种子脚本")
    print("=" * 60)
    print(f"目标员工数：{len(EMPLOYEES)}")
    print()

    try:
        inserted, skipped = seed()
    except Exception as exc:
        print(f"\n[错误] 执行失败：{exc}")
        sys.exit(1)

    print()
    print("─" * 60)
    print("执行摘要")
    print("─" * 60)
    print(f"  新增：{inserted} 条")
    print(f"  跳过：{skipped} 条（同名员工已存在）")
    print(f"  共处理：{inserted + skipped} / {len(EMPLOYEES)} 条")
    if inserted == 0 and skipped == len(EMPLOYEES):
        print("  ✓ 所有员工已存在，数据库未变更。")
    elif inserted > 0:
        print("  ✓ 种子写入成功，请重启服务以加载最新员工配置。")
    print("=" * 60)


if __name__ == "__main__":
    main()
