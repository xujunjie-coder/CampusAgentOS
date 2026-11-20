"""
西华师范大学（CWNU）校园专属智能体工具集（CampusAgentOS）

纯 Python 标准库实现，零外网强依赖，离线/内网答辩场景 100% 可用。
供 Agentica 数字员工在对话中按需调用，统一返回 UTF-8 JSON 字符串：
- campus_shuttle:   华凤 / 北湖两校区通勤校车与城市公交参考查询
- campus_calendar:  校历、考试周及重要校园时间节点动态计算查询
- campus_gpa:       课程成绩加权均分与 4.0/5.0 制绩点（GPA）及奖学金条件匹配
- campus_directory: 校内职能部门、场馆服务与心理危机热线检索
"""

import datetime
import json
import re
from typing import Dict, List, Optional, Tuple


# ==================== 1. 两校区通勤校车与交通查询 ====================

_SHUTTLE_ROUTES = [
    {
        "route": "华凤校区 ↔ 北湖校区 教职工/学生通勤班车",
        "stops": {
            "华凤校区": "华凤校区东门校车停靠点 / 一期教学楼前乘车点",
            "北湖校区": "北湖校区正大门内校车停靠站",
        },
        "weekday_windows": [
            {"period": "早高峰", "time": "07:20 – 08:15（每 15–20 分钟滚动发车）"},
            {"period": "上午课间", "time": "09:50 – 10:15（衔接第 3–4 节课）"},
            {"period": "午间班次", "time": "12:15 – 14:00（整点/半点班次）"},
            {"period": "下午课间", "time": "16:10 – 18:10（教学下课高峰集中发车）"},
            {"period": "晚间班次", "time": "19:30 / 21:00（自习与晚课返程）"},
        ],
        "weekend_windows": [
            {"period": "周末/节假日参考", "time": "08:30、10:30、14:00、17:30、20:30（班次按当月公告动态缩减）"},
        ],
        "duration_min": "约 20–30 分钟（视西华大道及市区路况）",
        "ticket_rule": "凭有效校园一卡通或学生证刷卡/登记乘车，请提前 5–10 分钟候车",
    },
    {
        "route": "华凤校区 ↔ 都京校区 / 南充市区 公交接驳参考",
        "stops": {
            "华凤校区": "师大二期/一期公交站",
            "北湖校区": "师大一校区/北湖路公交站",
            "都京校区": "都京港教育城公交站",
        },
        "weekday_windows": [
            {"period": "全天公交", "time": "06:30 – 21:30（南充城市公交参考间隔 8–15 分钟，票价 1–2 元）"},
        ],
        "weekend_windows": [
            {"period": "周末公交", "time": "06:45 – 21:30（支持公交卡及微信/支付宝乘车码）"},
        ],
        "duration_min": "华凤–北湖约 25–35 分钟；市区换乘都京约 45–60 分钟",
        "ticket_rule": "城市公共交通按站投币或扫码乘车，校内非机动车入校需登记并限速 ≤15km/h",
    },
]


def campus_shuttle(origin: str = "", time_hint: str = "") -> str:
    """查询西华师范大学华凤校区与北湖校区（含都京方向公交）通勤校车及乘车信息。

    Args:
        origin: 出发地或目标校区关键词，例如 "华凤"、"北湖"、"都京" 或留空查看全部。
        time_hint: 时段提示，例如 "早高峰"、"晚上"、"周末"、"现在"。
    """
    origin_q = (origin or "").strip()[:40]
    hint_q = (time_hint or "").strip()[:40]
    now = datetime.datetime.now()
    is_weekend = now.weekday() >= 5 or any(k in hint_q for k in ("周末", "周六", "周日", "节假"))

    matched = _SHUTTLE_ROUTES
    if origin_q:
        filtered = [
            r for r in _SHUTTLE_ROUTES
            if origin_q in r["route"] or any(origin_q in k or origin_q in v for k, v in r["stops"].items())
        ]
        if filtered:
            matched = filtered

    return json.dumps({
        "query": {"origin": origin_q or "全部校区", "time_hint": hint_q or now.strftime("%H:%M")},
        "day_type": "周末/节假日参考" if is_weekend else "工作日教学周参考",
        "routes": matched,
        "tips": [
            "教学高峰期建议提前 10 分钟到站排队，部分班次满座即发车。",
            "实际发车时刻表以西华师范大学后勤/交通服务中心及校园网最新公告为准。",
        ],
    }, ensure_ascii=False)


# ==================== 2. 校历与学术时间节点查询 ====================

def _academic_milestones(today: datetime.date) -> List[Dict]:
    year = today.year
    # 按公历月份动态推算本学年与下一窗口节点
    spring_year = year if today.month <= 7 else year + 1
    autumn_year = year if today.month >= 8 else year - 1
    candidates = [
        ("秋季学期开学/老生报到参考", datetime.date(autumn_year, 9, 1), "教务处注册与正选课窗口开启"),
        ("奖学金/综合素质测评申请季", datetime.date(autumn_year, 9, 10), "国家奖学金、国家励志及校级综合奖学金评审（9 月中旬截止材料）"),
        ("秋季校园双选会与秋招黄金期", datetime.date(autumn_year, 10, 20), "招生就业处大型专场双选会与三方签约指导"),
        ("下半年教师资格证笔试参考", datetime.date(autumn_year, 9, 15), "师范生重点关注中小学教师资格考试报名与备考"),
        ("下半年全国大学英语四六级（CET）", datetime.date(autumn_year, 12, 14), "一般于 12 月中旬周六举行，请提前两周打印准考证"),
        ("全国硕士研究生招生初试参考", datetime.date(autumn_year, 12, 21), "通常安排在 12 月倒数第二或最后一个周末"),
        ("秋季学期期末考试周", datetime.date(spring_year, 1, 8), "图书馆通常会同步延长自习阅览开放时间"),
        ("春季学期开学注册与补退选", datetime.date(spring_year, 3, 2), "关注教务系统重修报名与学分核对通知"),
        ("春季校园双选会与毕业论文抽检", datetime.date(spring_year, 4, 15), "毕业生关注毕业论文查重答辩与省属校招信息"),
        ("上半年全国大学英语四六级（CET）", datetime.date(spring_year, 6, 13), "一般于 6 月中旬周六举行"),
        ("春季学期期末考试周", datetime.date(spring_year, 6, 26), "停课复习与期末考核集中周，7 月中旬起陆续进入暑假"),
    ]
    rows = []
    for title, dt, desc in candidates:
        diff = (dt - today).days
        rows.append({
            "event": title,
            "ref_date": dt.strftime("%Y-%m-%d"),
            "days_from_today": diff,
            "status": "即将到来" if diff >= 0 else "本轮已过（供来年参照）",
            "detail": desc,
        })
    return rows


def campus_calendar(query: str = "") -> str:
    """查询西华师范大学当前学期信息、校历参考节点、考试周与寒暑假安排。

    Args:
        query: 查询关键词，例如 "期末"、"四六级"、"奖学金"、"放假"、"开学"、"考研"。
    """
    q = (query or "").strip()[:60]
    today = datetime.date.today()
    weekdays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
    if 3 <= today.month <= 7:
        semester = f"{today.year - 1}–{today.year} 学年第二学期（春季学期参考）"
    elif today.month >= 9 or today.month == 1:
        acad_start = today.year if today.month >= 9 else today.year - 1
        semester = f"{acad_start}–{acad_start + 1} 学年第一学期（秋季学期参考）"
    else:
        semester = "假期时段（寒假 1 月下旬–2 月下旬 / 暑假 7 月中旬–8 月底参考）"

    all_events = _academic_milestones(today)
    matched = [
        e for e in all_events
        if q and (q in e["event"] or q in e["detail"] or q in e["ref_date"])
    ]
    if not matched:
        upcoming = [e for e in all_events if e["days_from_today"] >= 0]
        upcoming.sort(key=lambda e: e["days_from_today"])
        matched = upcoming[:5] if upcoming else all_events[:5]

    return json.dumps({
        "today": today.strftime("%Y-%m-%d"),
        "weekday": weekdays[today.weekday()],
        "semester_estimate": semester,
        "query": q or "近期日程概览",
        "milestones": matched,
        "notice": "校历准确周次与放假调休安排以西华师范大学党政办公室及教务处当年正式校历为准。",
    }, ensure_ascii=False)


# ==================== 3. 绩点（GPA）测算与奖学金匹配 ====================

def _score_to_gpa5(score: float) -> float:
    if score < 60.0:
        return 0.0
    return round(min(5.0, max(1.0, (score - 50.0) / 10.0)), 2)


def _score_to_gpa4(score: float) -> float:
    table = (
        (90.0, 4.0), (85.0, 3.7), (82.0, 3.3), (78.0, 3.0),
        (75.0, 2.7), (72.0, 2.3), (68.0, 2.0), (64.0, 1.7), (60.0, 1.0),
    )
    for cutoff, gpa in table:
        if score >= cutoff:
            return gpa
    return 0.0


def _parse_score_entries(raw: str) -> List[Tuple[str, float, float]]:
    if not raw or not raw.strip():
        return []
    text = raw.replace("，", ",").replace("；", ",").replace("：", ":").replace("／", "/")
    parts = [p.strip() for p in re.split(r"[,\n;]+", text) if p.strip()]
    entries: List[Tuple[str, float, float]] = []
    for idx, part in enumerate(parts, 1):
        # 支持: "高数:92/4", "高数 92 4", "92/3", "92"
        m = re.match(r"^(?:([^:\d/]+?)\s*[:\s]+)?(\d+(?:\.\d+)?)\s*(?:分)?(?:\s*[/\s*]\s*(\d+(?:\.\d+)?)\s*(?:学分)?)?$", part)
        if not m:
            nums = re.findall(r"\d+(?:\.\d+)?", part)
            if not nums:
                continue
            score = float(nums[0])
            credit = float(nums[1]) if len(nums) > 1 else 1.0
            name = re.sub(r"[:/\d.\s分学分]+", "", part).strip() or f"课程{idx}"
        else:
            name = (m.group(1) or "").strip() or f"课程{idx}"
            score = float(m.group(2))
            credit = float(m.group(3)) if m.group(3) else 1.0
        score = max(0.0, min(100.0, score))
        credit = max(0.5, min(20.0, credit))
        entries.append((name[:30], score, credit))
    return entries


_SCHOLARSHIP_GUIDE = [
    {"name": "国家奖学金", "amount": "8000元/年", "rank_req": "专业同年级前 5%，全部课程无不及格，大二及以上"},
    {"name": "国家励志奖学金", "amount": "5000元/年", "rank_req": "专业同年级前 20%，无不及格且通过家庭经济困难认定（与国家助学金不可兼得）"},
    {"name": "校级一等奖学金", "amount": "2000元/年（参考）", "rank_req": "综合素质测评专业前 5%（学业通常占 60%–70%）"},
    {"name": "校级二等奖学金", "amount": "1500元/年（参考）", "rank_req": "综合素质测评专业前 15%"},
    {"name": "校级三等奖学金", "amount": "1000元/年（参考）", "rank_req": "综合素质测评专业前 25%"},
]


def campus_gpa(scores_text: str = "", category: str = "") -> str:
    """测算课程加权均分与 4.0 / 5.0 制参考绩点（GPA），并返回西华师大奖学金评定参考条件。

    Args:
        scores_text: 成绩清单，支持 "高数:92/4, 大学英语:86/3" 或 "92, 88, 84"（逗号/换行分隔）。
        category: 奖学金意向类别，例如 "国家奖学金"、"国家励志奖学金"、"校级奖学金"。
    """
    entries = _parse_score_entries(scores_text or "")
    cat_q = (category or "").strip()[:30]
    matched_scholarships = [
        s for s in _SCHOLARSHIP_GUIDE if cat_q and cat_q in s["name"]
    ] or _SCHOLARSHIP_GUIDE

    summary: Optional[Dict] = None
    breakdown: List[Dict] = []
    if entries:
        total_credits = sum(c for _, _, c in entries)
        weighted_score = sum(s * c for _, s, c in entries) / total_credits
        weighted_gpa5 = sum(_score_to_gpa5(s) * c for _, s, c in entries) / total_credits
        weighted_gpa4 = sum(_score_to_gpa4(s) * c for _, s, c in entries) / total_credits
        failed = [name for name, score, _ in entries if score < 60.0]
        summary = {
            "course_count": len(entries),
            "total_credits": round(total_credits, 2),
            "weighted_avg_score": round(weighted_score, 2),
            "gpa_5_scale": round(weighted_gpa5, 3),
            "gpa_4_scale": round(weighted_gpa4, 3),
            "failed_courses": failed,
            "eligible_national_tier_academic": len(failed) == 0,
        }
        breakdown = [
            {
                "course": name,
                "score": score,
                "credit": credit,
                "gpa_5": _score_to_gpa5(score),
                "gpa_4": _score_to_gpa4(score),
            }
            for name, score, credit in entries[:20]
        ]

    return json.dumps({
        "calculation": summary,
        "breakdown": breakdown,
        "scholarships": matched_scholarships,
        "formula_note": "5.0 制按常见 60分=1.0、每增1分+0.1 估算，4.0 制按分段换算；教务系统官方 GPA 口径以《西华师范大学学生手册》与教务处成绩单为准。",
    }, ensure_ascii=False)


# ==================== 4. 校内机构与办事黄页检索 ====================

_DIRECTORY_ENTRIES = [
    {
        "unit": "教务处",
        "keywords": "选课 成绩 绩点 毕业 学籍 补考 重修 四六级 转专业",
        "campus": "华凤校区行政办公区域",
        "hours": "工作日 08:30–12:00，14:30–18:00",
        "service": "选课学分、成绩复核、缓考补考、学籍证明自助打印与培养方案咨询；可通过学校官网「教务处 / 智慧教务系统」查询最新通知与科室联系方式。",
    },
    {
        "unit": "学生工作部（学生资助管理中心）",
        "keywords": "奖学金 助学金 助学贷款 困难认定 违纪 宿舍 评优",
        "campus": "华凤校区学工办公楼",
        "hours": "工作日 08:30–12:00，14:30–18:00",
        "service": "国家奖助学金、生源地/校园地助学贷款回执、家庭经济困难认定、综合素质测评与评优评先；详情见学校官网「学工在线」。",
    },
    {
        "unit": "招生就业处",
        "keywords": "双选会 宣讲会 三方协议 就业 派遣 档案 考研 招聘",
        "campus": "华凤校区招生就业服务大厅",
        "hours": "工作日 08:30–12:00，14:30–18:00",
        "service": "就业协议书（三方协议）审核、校园双选会预约、简历门诊、就业去向登记与基层就业补贴政策咨询。",
    },
    {
        "unit": "图书馆（华凤校区 / 北湖校区 / 都京校区）",
        "keywords": "图书馆 借书 还书 论文 知网 VPN 自习室 座位 开放时间",
        "campus": "华凤校区主馆 / 北湖校区与都京校区分馆",
        "hours": "自习阅览室 07:30–22:30，主借阅室 08:00–22:00（期末按公告适当延长）",
        "service": "图书借阅续借（本科生参考 10–15 册）、CNKI/万方/维普校内网及校外 VPN 访问、文献传递与考研自习室。",
    },
    {
        "unit": "大学生心理健康教育中心",
        "keywords": "心理 情绪 焦虑 失眠 压力 咨询 倾诉 危机 热线",
        "campus": "华凤校区 / 北湖校区心理咨询预约点",
        "hours": "工作时间按预约时段开放；紧急危机请立即拨打 24 小时公益热线",
        "service": "面向在校生的免费个体心理咨询预约、心理测评与团体辅导。全国24小时心理援助热线：400-161-9995 / 400-821-1215；北京心理危机干预中心：010-82951332。",
    },
    {
        "unit": "后勤保障处与校园物业维修",
        "keywords": "报修 宿舍 水电 空调 一卡通 食堂 校车",
        "campus": "各校区宿管站 / 后勤服务大厅",
        "hours": "线上报修 24 小时受理，常规维修工作日及值班时段响应",
        "service": "宿舍水电照明报修、浴室热水卡务、食堂餐饮监督及跨校区通勤校车信息发布。",
    },
    {
        "unit": "网络与信息化管理处",
        "keywords": "校园网 WiFi VPN 邮箱 统一身份认证 密码 重置",
        "campus": "华凤校区信息化服务窗口",
        "hours": "工作日 08:30–12:00，14:30–18:00",
        "service": "校园无线网与宿舍宽带认证、校外 VPN 访问图书馆数据库、统一身份认证密码重置。",
    },
    {
        "unit": "校医院与保卫处（校园安全服务）",
        "keywords": "校医院 体检 医保 就医 挂号 丢卡 报警 安全 门禁",
        "campus": "华凤校区 / 北湖校区对应服务点",
        "hours": "保卫巡逻及门岗 24 小时值班；校医院按门诊及急诊排班接诊",
        "service": "校园安全报警、电动车入校登记、校卡遗失拾遗协助；常规门诊、入学体检及大学生医保报销指导。",
    },
]


def campus_directory(keyword: str = "") -> str:
    """检索西华师范大学校内办事部门、场馆开放时间、线上入口与心理援助热线。

    Args:
        keyword: 办事或部门关键词，例如 "图书馆"、"奖学金"、"心理"、"选课"、"报修"、"校园网"。
    """
    kw = (keyword or "").strip()[:40]
    if kw:
        hits = [
            e for e in _DIRECTORY_ENTRIES
            if kw in e["unit"] or kw in e["keywords"] or kw in e["service"] or kw in e["campus"]
        ]
    else:
        hits = _DIRECTORY_ENTRIES[:6]

    return json.dumps({
        "keyword": kw or "校内常用机构总览",
        "count": len(hits),
        "entries": hits or _DIRECTORY_ENTRIES[:4],
        "crisis_hotlines": {
            "全国心理援助热线": "400-161-9995",
            "北京心理危机研究与干预中心": "010-82951332",
            "全国24小时心理干预热线": "400-821-1215",
        },
        "notice": "具体科室办公室房间号及最新值班分机请查阅西华师范大学官网「机构设置」或官方公众号。",
    }, ensure_ascii=False)
