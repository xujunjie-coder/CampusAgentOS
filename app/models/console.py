"""
数智大屏 / 统计报表 / 智能舆情专用的只读聚合层（成员 C）

成员 E 的 `app/models/stats.py` 已提供总览、日趋势、信源、风险、热词五类聚合，
本模块不重复实现，只补齐大屏额外需要的三个维度，并统一组装成一次可推送的快照：

- by_region  ：把「标题 + 摘要」中出现的省级行政区 / 省会城市做地理聚合。
                库内 collect_items / warehouse_data **没有 region 字段**，因此这里不伪造
                经纬度或行政区划编码，只按文本命中计数，页面上必须标注该口径。
- risk_trend ：近 N 日风险等级走势（预警台的迷你趋势、大屏的风险脉冲）。
- latest_risks / recent_items ：最新风险线索与最新采集条目（大屏滚动流、预警台实时流）。

约束：全部只读、无副作用；参数化 SQL；只依赖 models 层，不导入 service/controller。
"""

import datetime
import re
from typing import Dict, List

from app.models.db import get_connection
from app.models.stats import RISK_LABELS, RISK_LEVELS, StatsRepository


def _display_title(value):
    """Hide QQ image identifiers in display copies, keeping source records intact."""
    title = re.sub(r"\[B_[0-9a-fA-F]+X\d+\]", "", str(value or ""))
    return " ".join(title.split()) or "图片消息"

# 省级行政区（与 vendor/echarts/china.json 的 feature.name 对齐，均为简称）
PROVINCES = [
    "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
    "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南",
    "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州",
    "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆", "台湾",
    "香港", "澳门",
]

# 文本命中别名：省级全称 + 省会/直辖市/计划单列市，尽量把「成都」「深圳」这类写法也归到省
_PROVINCE_ALIASES: List[tuple] = [(name, name) for name in PROVINCES] + [
    ("北京市", "北京"), ("上海市", "上海"), ("天津市", "天津"), ("重庆市", "重庆"),
    ("河北省", "河北"), ("山西省", "山西"), ("内蒙古自治区", "内蒙古"),
    ("辽宁省", "辽宁"), ("吉林省", "吉林"), ("黑龙江省", "黑龙江"),
    ("江苏省", "江苏"), ("浙江省", "浙江"), ("安徽省", "安徽"), ("福建省", "福建"),
    ("江西省", "江西"), ("山东省", "山东"), ("河南省", "河南"), ("湖北省", "湖北"),
    ("湖南省", "湖南"), ("广东省", "广东"), ("广西壮族自治区", "广西"),
    ("海南省", "海南"), ("四川省", "四川"), ("贵州省", "贵州"), ("云南省", "云南"),
    ("西藏自治区", "西藏"), ("陕西省", "陕西"), ("甘肃省", "甘肃"), ("青海省", "青海"),
    ("宁夏回族自治区", "宁夏"), ("新疆维吾尔自治区", "新疆"),
    ("石家庄", "河北"), ("唐山", "河北"), ("太原", "山西"), ("呼和浩特", "内蒙古"),
    ("沈阳", "辽宁"), ("大连", "辽宁"), ("长春", "吉林"), ("哈尔滨", "黑龙江"),
    ("南京", "江苏"), ("苏州", "江苏"), ("无锡", "江苏"), ("杭州", "浙江"),
    ("宁波", "浙江"), ("温州", "浙江"), ("合肥", "安徽"), ("福州", "福建"),
    ("厦门", "福建"), ("泉州", "福建"), ("南昌", "江西"), ("济南", "山东"),
    ("青岛", "山东"), ("烟台", "山东"), ("郑州", "河南"), ("洛阳", "河南"),
    ("武汉", "湖北"), ("宜昌", "湖北"), ("长沙", "湖南"), ("广州", "广东"),
    ("深圳", "广东"), ("珠海", "广东"), ("东莞", "广东"), ("佛山", "广东"),
    ("南宁", "广西"), ("桂林", "广西"), ("海口", "海南"), ("三亚", "海南"),
    ("成都", "四川"), ("绵阳", "四川"), ("贵阳", "贵州"), ("遵义", "贵州"),
    ("昆明", "云南"), ("大理", "云南"), ("拉萨", "西藏"), ("西安", "陕西"),
    ("宝鸡", "陕西"), ("兰州", "甘肃"), ("敦煌", "甘肃"), ("西宁", "青海"),
    ("银川", "宁夏"), ("乌鲁木齐", "新疆"), ("喀什", "新疆"),
]

# 别名按长度倒序，避免「吉林市」被「吉林」抢先命中后重复计数（这里每个省每篇只计一次，顺序只影响可读性）
_ALIASES_SORTED = sorted(_PROVINCE_ALIASES, key=lambda kv: len(kv[0]), reverse=True)


def _today() -> datetime.date:
    return datetime.date.today()


class ConsoleStatsRepository:
    """大屏 / 报表 / 预警台的聚合入口（静态方法，无实例状态）"""

    # -------------------- 地理维度（文本口径） --------------------
    @staticmethod
    def by_region(limit: int = 34) -> Dict:
        """按标题+摘要中的省级行政区/省会城市命中计数

        返回 {"list": [{"name","value"}], "matched": 命中行数, "scanned": 扫描行数}
        口径说明由调用方（页面）展示：这是**文本提及热度**，不是采集地的真实地理分布。
        """
        rows = []
        with get_connection() as conn:
            rows = [dict(r) for r in conn.execute(
                "SELECT title, COALESCE(summary, '') AS brief FROM collect_items "
                "ORDER BY id DESC LIMIT 3000")]
            rows += [dict(r) for r in conn.execute(
                "SELECT title, COALESCE(ai_summary, '') AS brief FROM warehouse_data "
                "ORDER BY id DESC LIMIT 3000")]

        counts = {name: 0 for name in PROVINCES}
        matched = 0
        for row in rows:
            text = "%s %s" % (row.get("title") or "", row.get("brief") or "")
            if not text.strip():
                continue
            hit = set()
            for alias, province in _ALIASES_SORTED:
                if alias in text:
                    hit.add(province)
            if not hit:
                continue
            matched += 1
            for province in hit:
                counts[province] += 1

        data = [{"name": name, "value": value} for name, value in counts.items() if value > 0]
        data.sort(key=lambda d: (-d["value"], d["name"]))
        return {
            "list": data[:limit],
            "matched": matched,
            "scanned": len(rows),
            "max": data[0]["value"] if data else 0,
            "empty": not data,
        }

    # -------------------- 预警维度 --------------------
    @staticmethod
    def latest_risks(limit: int = 10, level: str = "") -> List[Dict]:
        """最新风险线索（默认全部等级，可只取 high/watch）"""
        sql = (
            "SELECT c.id AS item_id, c.title, c.url, c.source_name, r.level, r.reason, "
            "r.evidence, r.reviewed_at "
            "FROM risk_reviews r JOIN collect_items c ON c.id = r.item_id "
        )
        params = []
        if level in RISK_LEVELS:
            sql += "WHERE r.level = ? "
            params.append(level)
        sql += "ORDER BY r.reviewed_at DESC, c.id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 50)))
        with get_connection() as conn:
            rows = [dict(r) for r in conn.execute(sql, tuple(params))]
        for row in rows:
            row["title"] = _display_title(row["title"])
            row["level_label"] = RISK_LABELS.get(row["level"], row["level"])
        return rows

    @staticmethod
    def risk_trend(days: int = 7) -> Dict:
        """近 N 日各风险等级的每日新增数（缺失日期补 0，便于直接喂给 ECharts）"""
        days = max(1, min(int(days), 90))
        start = _today() - datetime.timedelta(days=days - 1)
        dates = [(start + datetime.timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)]
        with get_connection() as conn:
            rows = [dict(r) for r in conn.execute(
                "SELECT substr(reviewed_at, 1, 10) AS d, level, COUNT(*) AS c "
                "FROM risk_reviews WHERE substr(reviewed_at, 1, 10) >= ? "
                "GROUP BY d, level", (dates[0],))]
        series = {level: [0] * days for level in RISK_LEVELS}
        index = {date: i for i, date in enumerate(dates)}
        for row in rows:
            i = index.get(row["d"])
            if i is not None and row["level"] in series:
                series[row["level"]][i] = row["c"]
        return {
            "dates": dates,
            "series": [{"key": level, "label": RISK_LABELS.get(level, level),
                        "data": series[level]} for level in RISK_LEVELS],
        }

    # -------------------- 采集流 --------------------
    @staticmethod
    def recent_items(limit: int = 12) -> List[Dict]:
        """最新采集条目（大屏滚动条 / 报表底部清单）"""
        with get_connection() as conn:
            rows = [dict(r) for r in conn.execute(
                "SELECT id, title, url, source_name, keyword, collected_at, published_at "
                "FROM collect_items ORDER BY id DESC LIMIT ?", (max(1, min(int(limit), 50)),))]
        for row in rows:
            row["title"] = _display_title(row["title"])
        return rows

    # -------------------- 快照（大屏/报表/SSE 共用） --------------------
    @staticmethod
    def snapshot(days: int = 14) -> Dict:
        """一次组装完整快照：总览 + 趋势 + 信源 + 风险 + 热词 + 地理 + 最新流

        所有子块都复用成员 E 的 StatsRepository，避免同一指标两套口径。
        生成时间由服务端给出，前端只做展示，不在浏览器本地算"数据时间"。
        """
        days = max(7, min(int(days), 90))
        risk = StatsRepository.by_risk()
        return {
            "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "days": days,
            "overview": StatsRepository.overview(),
            "trend": StatsRepository.daily_trend(days=days),
            "by_source": StatsRepository.by_source(limit=10),
            "by_risk": risk,
            "keywords": StatsRepository.top_keywords(limit=16),
            "by_region": ConsoleStatsRepository.by_region(),
            "risk_trend": ConsoleStatsRepository.risk_trend(days=7),
            "latest_risks": ConsoleStatsRepository.latest_risks(limit=8),
            "high_risks": ConsoleStatsRepository.latest_risks(limit=5, level="high"),
            "recent_items": ConsoleStatsRepository.recent_items(limit=10),
        }
