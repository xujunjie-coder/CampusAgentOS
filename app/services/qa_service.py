"""
智能问数服务层 —— 成员 D（任务1核心：选数字人 → 分析 → 问数报告）
链路：数据仓库/统计聚合（models/stats.py，成员 E 交付）组装上下文 →
交给选定数字员工绑定的模型（model_service.chat_engine，任务8引擎优先级）→
要求模型输出结构化 JSON 问数报告；模型不可用/返回非法时降级为启发式规则报告，
保证 /qa 在离线与 pytest 环境同样可跑通、可演示。

报告契约（前端 qa.js 与 PDF/历史回放共用）：
{
  "title": str, "summary": str,
  "metrics": [{"name": str, "value": str, "unit": str}, ...],
  "chart": {"type": "bar"|"line", "labels": [str], "values": [number], "name": str},
  "insights": [str, ...], "advice": str
}
外加服务侧字段：source("model"|"heuristic")、model、generated_at。
"""

import json
import logging
from datetime import datetime

from app.models.stats import StatsRepository
from app.services import model_service

logger = logging.getLogger(__name__)

_INSTRUCTION = (
    "你是西华师范大学智慧校园平台（CampusAgentOS）的智能问数分析师。用户会给出一个问题和从数据仓库统计接口聚合的真实数据快照，"
    "你必须只基于数据快照回答，禁止编造数字。输出一个 JSON 对象（不要 markdown 围栏、不要多余文字），"
    '字段：title(15字内报告标题), summary(80字内结论), '
    'metrics(数组,2-5项,每项{name,value,unit},value为字符串数字), '
    'chart({type:bar或line,labels:不超过8个字符串,values:等长数字数组,name:指标名}), '
    'insights(数组,2-4条要点), advice(30字内建议)。'
)


def _collect_context() -> dict:
    """组装数据快照：总览 + 近7日趋势 + 信源分布 + 风险分布 + 高频词（字段口径见 StatsRepository）"""
    return {
        "overview": StatsRepository.overview(),
        "trend_7d": StatsRepository.daily_trend(7),
        "by_source": StatsRepository.by_source(8),
        "by_risk": StatsRepository.by_risk(),
        "top_keywords": StatsRepository.top_keywords(10),
    }


def _num(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _as_list(value) -> list:
    return value if isinstance(value, list) else []


def _normalize_model_report(raw: dict, context: dict) -> dict:
    """模型返回的 JSON 做字段级校验与清洗，任何关键字段非法即抛 ValueError 走兜底"""
    title = str(raw.get("title") or "").strip()[:60]
    summary = str(raw.get("summary") or "").strip()[:300]
    if not title or not summary:
        raise ValueError("模型报告缺少 title/summary")
    metrics = []
    for item in _as_list(raw.get("metrics"))[:5]:
        if not isinstance(item, dict):
            continue
        metrics.append({"name": str(item.get("name") or "")[:20],
                        "value": str(item.get("value") or "")[:24],
                        "unit": str(item.get("unit") or "")[:10]})
    chart_raw = raw.get("chart") or {}
    labels = [str(x)[:20] for x in _as_list(chart_raw.get("labels"))[:8]]
    values = [_num(v) for v in _as_list(chart_raw.get("values"))[:8]]
    chart = {}
    if labels and len(values) == len(labels):
        chart = {"type": "line" if chart_raw.get("type") == "line" else "bar",
                 "labels": labels, "values": values,
                 "name": str(chart_raw.get("name") or "分布")[:20]}
    insights = [str(x)[:120] for x in _as_list(raw.get("insights"))[:4] if str(x).strip()]
    report = {"title": title, "summary": summary, "metrics": metrics,
              "chart": chart, "insights": insights,
              "advice": str(raw.get("advice") or "")[:80]}
    if not metrics and not chart:
        raise ValueError("模型报告缺少可用指标与图表")
    return report


def _heuristic_report(question: str, context: dict) -> dict:
    """规则兜底：直接从统计快照生成报告（无模型/模型异常时），口径真实可核对"""
    ov = context["overview"]
    trend = context["trend_7d"]
    sources = context["by_source"]
    risks = context["by_risk"]
    keywords = context["top_keywords"]

    total = _num(ov.get("collect_total"))
    metrics = [
        {"name": "采集总量", "value": str(int(total)), "unit": "条"},
        {"name": "今日新增", "value": str(int(_num(ov.get("collect_today")))), "unit": "条"},
        {"name": "信源数", "value": str(len(sources)), "unit": "个"},
    ]
    high_risk = next((r for r in risks if r.get("level") == "high"), {})
    if high_risk and _num(high_risk.get("count")) > 0:
        metrics.append({"name": "高风险数据", "value": str(int(_num(high_risk.get("count")))), "unit": "条"})

    if sources:
        chart = {"type": "bar", "labels": [s.get("source_name") or "未知" for s in sources][:8],
                 "values": [_num(s.get("count")) for s in sources][:8], "name": "信源分布"}
    elif trend:
        chart = {"type": "line", "labels": [t.get("date") or "" for t in trend][:7],
                 "values": [_num(t.get("collect")) for t in trend][:7], "name": "近7日采集趋势"}
    else:
        chart = {"type": "bar", "labels": [], "values": [], "name": "暂无数据"}

    insights = ["问题聚焦：%s" % (question[:60] or "整体数据概况")]
    if sources:
        top = sources[0]
        insights.append("占比最高信源为「%s」，共 %s 条" % (top.get("source_name"), int(_num(top.get("count")))))
    if trend:
        latest = trend[-1]
        insights.append("最近一天（%s）新增 %s 条" % (latest.get("date"), int(_num(latest.get("collect")))))
    if keywords:
        words = "、".join(k.get("keyword") or "" for k in keywords[:5] if k.get("keyword"))
        if words:
            insights.append("高频采集关键词：%s" % words)
    return {
        "title": "数据仓库问数速览",
        "summary": "当前仓库共 %d 条数据、覆盖 %d 个信源；模型暂不可用，本报告由统计快照直接生成。"
                   % (int(total), len(sources)),
        "metrics": metrics, "chart": chart,
        "insights": insights[:4],
        "advice": "可稍后重试获取模型深度分析，或到采集中心补充信源后再次问数",
    }


async def ask(question: str, employee=None) -> dict:
    """一次问数：真实统计快照 +（可用时）模型结构化分析；永不抛模型异常"""
    context = _collect_context()
    model = model_service.chat_engine(employee)
    if model:
        try:
            raw = await model_service.complete_json(
                model, _INSTRUCTION,
                json.dumps({"question": question, "data_snapshot": context}, ensure_ascii=False))
            report = _normalize_model_report(raw, context)
            report["source"] = "model"
            report["model"] = model.get("model_id") or ""
            report["generated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            return report
        except Exception as exc:  # 模型不可用/输出非法 → 启发式兜底，不向前台抛错
            logger.info("问数模型分析降级 rid_ctx=%s: %s", len(context), exc)
    report = _heuristic_report(question, context)
    report["source"] = "heuristic"
    report["model"] = ""
    report["generated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return report
