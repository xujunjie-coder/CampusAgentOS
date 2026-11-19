"""
数据仓库深度采集服务（服务层）—— 任务7
职责：对采集管理抓回的「原数据」（collect_items）执行深度采集——抓取详情页正文 →
AI 模型引擎分析（摘要/关键词）→ 详细正文与分析结果入 warehouse_data 表。

设计说明（对应任务7 开发限制）：
- 深采引擎 = Crawl4AI + AI 模型引擎：优先 crawl4ai.AsyncWebCrawler（playwright 内核，
  前端渲染后导出 clean_markdown / media / 内部链接）；Crawl4AI 不可用（浏览器内核缺失/异常）
  时回退 requests + BeautifulSoup 启发式正文抽取，保证链路永不中断。
- 详情页请求头：信源 header 规则是为「列表页」配置的，其中 host / cookie / referer / sec-*
  等与站点绑定，直接透传到异域详情页会让服务端判定为异常请求（403 Forbidden /
  418 I'm a Teapot），故统一经 sanitize_headers() 剔除跨站头并兜底浏览器 UA。
- AI 模型引擎：任务8「模型引擎管理」未落地前，约定默认模型即 .env 的
  BASE_URL / API_KEY / MODEL_ID（与 agent_service、collect_service 同源），
  直接用 openai SDK 对话产出 {summary, keywords}；失败回退规则摘要（首段拼接）。
- 单一深采与批量深采共用 deep_collect_one 编排，全程经 progress(stage, percent, message, data)
  回调产出事件流，控制层转 SSE 推送给「采集过程执行面板」（进度/分析过程/采集结果实时展示）。
- 本模块全部是同步阻塞函数（抓取 / 大模型推理），控制层必须经 run_in_executor 放入线程池，
  避免阻塞 Tornado IOLoop（项目既有隐患约定，同 collect_service）。
"""

import asyncio
import json
import re
import threading
import urllib.parse
from collections import Counter
from typing import Callable, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from app.models.collect import CollectRepository
from app.models.warehouse import WarehouseRepository
from app.services.model_service import chat_engine

# 任务13：配置统一由 app.config 读取（进程内只加载一次 .env），不再各自 load_dotenv()

# 抓取与大模型超时（秒）
CRAWL_TIMEOUT = 60
LLM_TIMEOUT = 60
# 送入大模型的正文上限（控制 token 规模）
LLM_TEXT_LIMIT = 6000
# 批量深采单次条数上限（防止一次请求长期占用线程池）
MAX_BATCH_ITEMS = 50
# 视为「有效正文」的最小字数：低于此值多为 JS 渲染骨架页 / 反爬拦截页，按失败处理
MIN_CONTENT_CHARS = 60
# 详情页默认浏览器指纹：requests 裸 UA（python-requests/x.y）会被绝大多数站点反爬拦截
DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
# 跨站透传会指向错误站点或暴露非人类流量特征的请求头（host 指错域直接 403）
_SITE_BOUND_HEADERS = {"host", "connection", "content-length", "content-type",
                       "accept-encoding", "cache-control", "transfer-encoding",
                       "upgrade-insecure-requests", "cookie", "referer", "origin"}
# 浏览器安全上下文头（sec-ch-ua/sec-fetch-* 等）值随站点变化，跨站透传触发风控
_SITE_BOUND_PREFIXES = ("sec-", ":")
# 等 JS 渲染完成再取 HTML（仅 domcontentloaded 时部分站点只拿到骨架，实测某页 1.6KB → 38KB）
RENDER_DELAY = 1.5
# 反爬安全验证/拦截页特征词：这类页面会被当成正文入库污染数仓，必须判为失败
_BLOCK_MARKERS = ("百度安全验证", "请完成下方验证", "请完成验证后继续", "人机验证",
                  "请输入验证码", "请求过于频繁", "访问频率过高",
                  "Just a moment", "Enable JavaScript and cookies",
                  "Access Denied", "I'm a Teapot")

# crawl4ai 可选导入：缺失时服务自动降级为 requests 回退引擎，不影响模块加载
try:
    from crawl4ai import (AsyncWebCrawler, BrowserConfig,  # noqa: F401
                          CacheMode, CrawlerRunConfig)
    CRAWL4AI_AVAILABLE = True
except ImportError:
    CRAWL4AI_AVAILABLE = False

# 正文容器启发式优先级（新闻详情页常见结构）
_MAIN_SELECTORS = ("article", "div.article-content", "div.content", "div.article",
                   "div#artibody", "div.main-content", "td#articlecontent", "div.post-content")
_NOISE_TAGS = ("script", "style", "noscript", "iframe", "form", "button",
               "nav", "footer", "header", "aside", "svg")


class WarehouseError(ValueError):
    """深采业务错误（抓取失败 / 原数据不存在等），控制层据此返回友好提示"""


# ---------------- 正文抓取 ----------------

# Crawl4AI 失败根因（线程局部）：内核缺失/浏览器启动失败不能静默降级，
# 否则面板只见下游 requests 的 403/418，看不到真正原因
_C4A_STATE = threading.local()


def _c4a_set_error(msg: str) -> None:
    _C4A_STATE.error = msg or ""


def crawl4ai_error() -> str:
    """当前线程最近一次 Crawl4AI 失败根因（供错误提示/执行面板展示），无失败返回空串"""
    return getattr(_C4A_STATE, "error", "") or ""


def _same_site(url_a: str, url_b: str) -> bool:
    """两个 URL 是否同站（hostname 相同或为父子域），用于判断 cookie/referer 能否沿用"""
    ha = (urllib.parse.urlparse(url_a or "").hostname or "").lower()
    hb = (urllib.parse.urlparse(url_b or "").hostname or "").lower()
    if not ha or not hb:
        return False
    return ha == hb or ha.endswith("." + hb) or hb.endswith("." + ha)


def _source_site(headers: Optional[Dict]) -> str:
    """从信源请求头反推列表页站点：优先 host，其次 referer，都没有返回空串"""
    lowered = {(k or "").lower(): v for k, v in (headers or {}).items()}
    host = str(lowered.get("host") or "").strip()
    if host:
        return "http://" + host
    return str(lowered.get("referer") or "").strip()


def sanitize_headers(url: str, headers: Optional[Dict] = None) -> Dict:
    """构造详情页请求头：信源 header 规则是为「列表页」配的，其中 host / cookie / referer /
    sec-* 等与站点绑定，直接透传到异域详情页会让服务端判定异常请求：
    实测 host=www.baidu.com 请求 donews/ithome 直接 403，带百度 cookie 请求 autohome 返回
    418 I'm a Teapot。故仅同站时保留 cookie/referer，其余一律剔除，并兜底浏览器 UA。"""
    src = dict(headers or {})
    same_site = _same_site(url, _source_site(src))
    out = {}
    for key, value in src.items():
        lk = (key or "").lower()
        if not lk or value in (None, ""):
            continue
        if lk.startswith(_SITE_BOUND_PREFIXES):
            continue
        if lk in _SITE_BOUND_HEADERS:
            # cookie/referer/origin 同站才有意义，异域带上就是伪造身份
            if lk in ("cookie", "referer", "origin") and same_site:
                out[lk] = value
            continue
        out[lk] = value
    out.setdefault("user-agent", DEFAULT_UA)
    out.setdefault("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,"
                            "image/avif,image/webp,*/*;q=0.8")
    out.setdefault("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
    return out


def _parse_c4a_result(result) -> Dict:
    """把 crawl4ai 抓取结果转为统一的 {markdown, text, images, engine} 结构"""
    md = getattr(result, "clean_markdown", None) or getattr(result, "markdown", None) or ""
    media = getattr(result, "media", None) or {}
    images = []
    for key in ("images", "videos", "audios"):
        for m in media.get(key, []) or []:
            src = m.get("src") or m.get("url") or ""
            if src.startswith("http"):
                images.append(src)
    if not images:  # 老版本 media 结构兜底
        for m in (getattr(result, "imgs", None) or []):
            src = m.get("src") or m.get("url") or "" if isinstance(m, dict) else str(m or "")
            if src.startswith("http"):
                images.append(src)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)  # 去图片语法后的纯文本
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # 链接保留锚文本
    return {"markdown": md.strip(), "text": text.strip(), "images": images[:50],
            "engine": "crawl4ai"}


def _crawl_with_crawl4ai(url: str, headers: Optional[Dict] = None) -> Optional[Dict]:
    """Crawl4AI 引擎抓取：返回 {markdown, text, images, engine}；
    浏览器内核缺失 / 运行时异常返回 None（由调用方回退 requests 引擎），
    失败根因写入线程局部状态，供 crawl4ai_error() 展示。"""
    if not CRAWL4AI_AVAILABLE:
        _c4a_set_error("crawl4ai 未安装")
        return None

    async def _run(browser_config):
        async with AsyncWebCrawler(config=browser_config) as crawler:
            return await crawler.arun(
                url=url,
                config=CrawlerRunConfig(cache_mode=CacheMode.BYPASS,
                                        page_timeout=CRAWL_TIMEOUT * 1000,
                                        wait_until="domcontentloaded",
                                        delay_before_return_html=RENDER_DELAY),
                headers=headers or None,
            )

    # 依次尝试：内置 chromium 内核 → 系统 Edge → 系统 Chrome
    # （playwright 内核未下载时用 chrome_channel 复用本机浏览器，无需额外下载）
    last_error = ""
    for label, extra in (("内置 chromium", {}),
                         ("系统 Edge", {"chrome_channel": "msedge"}),
                         ("系统 Chrome", {"chrome_channel": "chrome"})):
        try:
            result = asyncio.run(_run(BrowserConfig(headless=True, user_agent=DEFAULT_UA,
                                                    verbose=False, **extra)))
        except Exception as e:
            first = (str(e) or e.__class__.__name__).splitlines()[0].strip()
            last_error = "%s 启动失败：%s" % (label, first[:120])
            continue
        if result is None or not getattr(result, "success", False):
            detail = (getattr(result, "error_message", "") or "页面未返回内容").splitlines()[0]
            last_error = "%s 抓取未成功：%s" % (label, detail[:120])
            continue
        parsed = _parse_c4a_result(result)
        _c4a_set_error("")
        return parsed
    _c4a_set_error(last_error)
    return None


def _heuristic_main_content(html: str, base_url: str = "") -> Dict:
    """回退引擎正文抽取：按容器优先级找正文节点（article/.content 等），
    找不到则退化为「文本最长的容器」；输出 Markdown 化正文 + 图片列表"""
    import urllib.parse

    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup(list(_NOISE_TAGS)):
        tag.decompose()

    node = None
    for sel in _MAIN_SELECTORS:
        try:
            found = soup.select_one(sel)
        except Exception:
            found = None
        if found and len(found.get_text(strip=True)) > 200:
            node = found
            break
    if node is None:
        candidates = soup.select("div, article, section, main, td") or [soup]
        node = max(candidates, key=lambda c: len(c.get_text(strip=True)))

    lines, images = [], []
    for el in node.find_all(["h1", "h2", "h3", "h4", "p", "li", "img"], recursive=True):
        if el.name == "img":
            src = el.get("src") or el.get("data-src") or ""
            if src:
                images.append(urllib.parse.urljoin(base_url, src))
            continue
        text = el.get_text(" ", strip=True)
        if not text or len(text) < 4:
            continue
        prefix = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### ", "li": "- "}.get(el.name, "")
        lines.append(prefix + text)
    # 容器自身直出文本（无子段落时兜底）
    if not lines:
        text = node.get_text("\n", strip=True)
        lines = [ln for ln in text.split("\n") if len(ln.strip()) >= 4]
    return {"markdown": "\n\n".join(lines).strip(),
            "text": "\n".join(lines).strip(),
            "images": images[:50],
            "engine": "heuristic"}


def _fetch_with_requests(url: str, headers: Optional[Dict] = None) -> str:
    """requests 抓取页面源码（Crawl4AI 回退路径），非 2xx / 网络异常抛 WarehouseError"""
    import requests

    try:
        resp = requests.get(url, headers=headers or {}, timeout=20)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise WarehouseError("抓取失败：%s" % e)
    if not resp.encoding or resp.encoding.lower() in ("iso-8859-1", "ascii"):
        resp.encoding = resp.apparent_encoding or "utf-8"
    return resp.text


def _enough(text: str) -> bool:
    """正文是否达到可用阈值：JS 骨架页/反爬拦截页往往只回几十字提示文案"""
    return len((text or "").strip()) >= MIN_CONTENT_CHARS


def blocked_marker(text: str) -> str:
    """识别反爬安全验证页（如百度安全验证/Cloudflare 挑战页）：
    命中时返回特征词，供调用方判失败——否则验证页文案会当成正文写进数仓。"""
    probe = (text or "").strip()[:300]
    if not probe:
        return ""
    for marker in _BLOCK_MARKERS:
        if marker in probe:
            return marker
    return ""


def _reject_blocked(text: str) -> None:
    """正文命中反爬特征时直接判失败，阻止验证页污染数仓"""
    marker = blocked_marker(text)
    if marker:
        raise WarehouseError("目标站点触发反爬安全验证（%s），无法自动抓取正文" % marker)


def _with_c4a_hint(message: str) -> str:
    """回退引擎的报错拼上 Crawl4AI 真实根因，避免「抓取失败」掩盖真正问题"""
    err = crawl4ai_error()
    return "%s（Crawl4AI 未生效：%s）" % (message, err) if err else message


def crawl_page(url: str, headers: Optional[Dict] = None) -> Dict:
    """深采抓取入口：Crawl4AI 优先，异常回退 requests+启发式；两路都失败抛 WarehouseError。
    headers 先经 sanitize_headers 净化：信源头按列表页配置，异域详情页沿用会触发反爬。"""
    if url.startswith("file:"):
        # 本地夹具/离线页面：Crawl4AI 对 file:// 支持有限，直接读文件走回退引擎
        path = url.replace("file:///", "").replace("file://", "")
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return _heuristic_main_content(f.read(), url)
    req_headers = sanitize_headers(url, headers)
    result = _crawl_with_crawl4ai(url, req_headers)
    if result and _enough(result["text"]):
        _reject_blocked(result["text"])
        return result
    try:
        html = _fetch_with_requests(url, req_headers)
    except WarehouseError as e:
        raise WarehouseError(_with_c4a_hint(str(e)))
    result = _heuristic_main_content(html, url)
    if not _enough(result["text"]):
        raise WarehouseError(_with_c4a_hint(
            "页面无可抽取正文（仅 %d 字，多为 JS 渲染页或反爬拦截）" % len(result["text"])))
    _reject_blocked(result["text"])
    return result


# ---------------- AI 模型引擎分析 ----------------

def ai_analyze(title: str, text: str) -> Dict:
    """调用默认模型引擎（模型引擎管理 is_default=1，OpenAI chat/completions 范式）：
    产出 {summary, keywords, model, used}；不可用/超时/输出不合法时 used=False 由调用方回退规则摘要"""
    engine = chat_engine()
    if not engine:
        return {"summary": "", "keywords": [], "model": "", "used": False,
                "error": "默认模型引擎未配置"}
    try:
        from tornado.httpclient import HTTPRequest

        prompt = (
            "你是数据仓库内容分析专员。阅读以下新闻正文，输出严格 JSON（不要解释、不要围栏）：\n"
            '{"summary": "不超过120字的中文摘要", "keywords": ["关键词1", "关键词2", "关键词3"]}\n\n'
            "标题：%s\n正文：%s" % (title, text[:LLM_TEXT_LIMIT]))
        body = {"model": engine["model_id"],
                "messages": [{"role": "user", "content": prompt}], "stream": False}
        if engine.get("thinking"):
            body["enable_thinking"] = False
            body["chat_template_kwargs"] = {"enable_thinking": False}
        request = HTTPRequest(
            engine["api_url"].rstrip("/") + "/chat/completions",
            method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + (engine["api_key"] or "")},
            body=json.dumps(body, ensure_ascii=False),
            connect_timeout=10, request_timeout=LLM_TIMEOUT)
        content = ""

        async def _call():
            from tornado.httpclient import AsyncHTTPClient
            resp = await AsyncHTTPClient().fetch(request, raise_error=False)
            if resp.code != 200:
                detail = (resp.body or b"").decode("utf-8", "replace")[:200]
                raise ValueError("模型服务返回 HTTP %s：%s" % (resp.code, detail or resp.error))
            return json.loads(resp.body.decode("utf-8", "replace"))

        obj = asyncio.run(_call())
        choices = obj.get("choices") or [{}]
        content = (choices[0].get("message") or {}).get("content") or ""
        content = content.strip()
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.M).strip()
        start, end = content.find("{"), content.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型未输出 JSON 对象")
        data = json.loads(content[start:end + 1])
        summary = str(data.get("summary") or "").strip()
        keywords = [str(k).strip() for k in (data.get("keywords") or []) if str(k).strip()][:8]
        if not summary:
            raise ValueError("模型摘要为空")
        return {"summary": summary[:500], "keywords": keywords,
                "model": engine.get("name", engine["model_id"]), "used": True, "error": ""}
    except Exception as e:
        return {"summary": "", "keywords": [], "model": engine.get("name", ""),
                "used": False, "error": str(e)}


_STOP_WORDS = set("的了是在和与就都而也被于以而且其这那之有着没不要为对你我他她它它们一个"
                  "我们你们他们因为所以但是如果虽然然而并且或者以及等等因为于一种新的")


def heuristic_analyze(title: str, text: str) -> Dict:
    """规则分析引擎（大模型回退）：摘要取前 3 个有效段落拼接（≤120字），
    关键词按 2-gram 词频粗提（去停用词/标点），保证深采结果总有分析与摘要"""
    paragraphs = [p.strip() for p in re.split(r"\n{2,}|。", text or "") if len(p.strip()) >= 10]
    summary = ""
    for p in paragraphs:
        if len(summary) + len(p) > 118:
            break
        summary += (p + "。") if summary else p
    summary = (summary or title or text or "")[:120]
    joined = re.sub(r"[^a-zA-Z\u4e00-\u9fff]+", " ", text or "")
    grams = Counter()
    for seg in joined.split():
        if re.match(r"^[a-zA-Z]{3,}$", seg):
            grams[seg.lower()] += 1
        chars = [c for c in seg if c not in _STOP_WORDS]
        s = "".join(chars)
        for n in (2, 3):
            for i in range(len(s) - n + 1):
                grams[s[i:i + n]] += 1
    keywords = [g for g, c in sorted(grams.items(), key=lambda kv: -kv[1]) if c >= 2][:6]
    if not keywords and title:
        keywords = [title[:6]]
    return {"summary": summary, "keywords": keywords, "used": False, "error": ""}


# ---------------- 深采编排 ----------------

def _emit(progress: Optional[Callable], stage: str, percent: int, message: str,
          data: Dict = None) -> None:
    """进度事件出口：回调异常不影响采集主流程（面板断连等场景继续跑完落库）"""
    if not progress:
        return
    try:
        progress(stage=stage, percent=percent, message=message, data=data or {})
    except Exception:
        pass


def deep_collect_one(item: Dict, username: str = "", use_ai: bool = True,
                     use_crawl4ai: bool = True, source_headers: Optional[Dict] = None,
                     progress: Optional[Callable] = None,
                     base_percent: int = 0, span_percent: int = 100) -> Dict:
    """单条原数据深度采集编排：抓取正文 → AI 分析 → 入 warehouse_data。
    全程按 base_percent..base_percent+span_percent 区间回报进度事件。
    返回 {ok, collect_item_id, warehouse_id, title, word_count, engine, llm_used,
    ai_error, summary, keywords, images, error}（失败不抛异常，便于批量续跑）。"""
    def p(stage, pct, msg, data=None):
        _emit(progress, stage, int(base_percent + span_percent * pct / 100), msg, data)

    url = (item.get("url") or "").strip()
    title = item.get("title") or ""
    p("start", 2, "开始深采：%s" % (title[:40] or url[:60]), {"title": title})
    if not url:
        p("error", 100, "原数据缺少链接，无法深采", {"error": "url 为空"})
        wh_id = WarehouseRepository.save_deep(item, {"ok": False, "error": "url 为空",
                                                     "engine": ""}, username)
        return {"ok": False, "collect_item_id": item["id"], "warehouse_id": wh_id,
                "title": title, "error": "url 为空"}

    # 1) 正文抓取（Crawl4AI 优先，回退 requests+启发式）
    p("crawl", 10, "抓取正文（引擎：%s）…" % ("Crawl4AI" if use_crawl4ai else "requests 回退"))
    try:
        page = crawl_page(url, source_headers) if use_crawl4ai \
            else _fallback_crawl(url, source_headers)
    except WarehouseError as e:
        p("error", 100, str(e), {"error": str(e)})
        wh_id = WarehouseRepository.save_deep(item, {"ok": False, "error": str(e),
                                                     "engine": "heuristic"}, username)
        return {"ok": False, "collect_item_id": item["id"], "warehouse_id": wh_id,
                "title": title, "error": str(e)}
    text = page["text"]
    p("parsed", 45, "正文抽取完成：%d 字（引擎 %s，图片 %d 张）"
      % (len(text), page["engine"], len(page["images"])),
      {"word_count": len(text), "engine": page["engine"], "images": len(page["images"])})

    # 2) AI 模型引擎分析（模型引擎管理默认模型，失败回退规则摘要）
    analysis, llm_error = None, ""
    if use_ai and chat_engine():
        p("ai", 55, "AI 模型引擎分析中（摘要 + 关键词）…")
        analysis = ai_analyze(title, text)
        if analysis["used"]:
            p("ai_done", 80, "AI 分析完成：%d 个关键词" % len(analysis["keywords"]),
              {"summary": analysis["summary"], "keywords": analysis["keywords"]})
        else:
            llm_error = analysis.get("error") or "AI 输出不合法"
            p("ai_fallback", 70, "AI 分析失败已回退规则摘要：%s" % llm_error[:60])
    if analysis is None or not analysis.get("used"):
        rule = heuristic_analyze(title, text)
        analysis = {"summary": rule["summary"], "keywords": rule["keywords"],
                    "model": (analysis or {}).get("model", ""),
                    "used": False, "error": llm_error}
        p("rule_done", 80, "规则摘要完成（%d 字）" % len(analysis["summary"]),
          {"summary": analysis["summary"], "keywords": analysis["keywords"]})

    # 3) 详细正文入库 warehouse_data
    result = {"ok": True, "title": title, "url": url,
              "content_md": page["markdown"], "content_text": text,
              "word_count": len(text), "ai_summary": analysis["summary"],
              "ai_keywords": analysis["keywords"], "images": page["images"],
              "engine": page["engine"], "llm_used": analysis["used"]}
    wh_id = WarehouseRepository.save_deep(item, result, username)
    p("saved", 95, "已入数据仓库（#%d，%d 字）" % (wh_id, len(text)),
      {"warehouse_id": wh_id, "word_count": len(text)})
    return {"ok": True, "collect_item_id": item["id"], "warehouse_id": wh_id,
            "title": title, "word_count": len(text), "engine": page["engine"],
            "llm_used": analysis["used"], "ai_error": llm_error,
            "summary": analysis["summary"], "keywords": analysis["keywords"],
            "images": len(page["images"]), "error": ""}


def _fallback_crawl(url: str, headers: Optional[Dict] = None) -> Dict:
    """显式关闭 Crawl4AI 时的抓取路径（仍走 crawl_page 的 requests 分支语义）"""
    html = _fetch_with_requests(url, sanitize_headers(url, headers))
    result = _heuristic_main_content(html, url)
    if not _enough(result["text"]):
        raise WarehouseError("页面无可抽取正文（仅 %d 字，多为 JS 渲染页或反爬拦截）"
                             % len(result["text"]))
    _reject_blocked(result["text"])
    return result


def deep_collect_batch(items: List[Dict], username: str = "", use_ai: bool = True,
                       use_crawl4ai: bool = True, source_headers: Optional[Dict] = None,
                       progress: Optional[Callable] = None) -> List[Dict]:
    """批量深采：逐条执行 deep_collect_one，条间均分进度区间，单条失败不中断批量。
    返回每条结果汇总列表。"""
    if not items:
        raise WarehouseError("没有可深采的原数据")
    if len(items) > MAX_BATCH_ITEMS:
        raise WarehouseError("单次批量深采最多 %d 条" % MAX_BATCH_ITEMS)
    total = len(items)
    results = []
    _emit(progress, stage="batch_start", percent=0,
          message="批量深采开始：共 %d 条" % total, data={"total": total})
    for idx, item in enumerate(items):
        try:
            r = deep_collect_one(item, username, use_ai, use_crawl4ai, source_headers,
                                 progress=progress, base_percent=int(idx * 100 / total),
                                 span_percent=int(100 / total))
        except Exception as e:  # 兜底：未预期异常记失败继续跑
            r = {"ok": False, "collect_item_id": item.get("id"), "title": item.get("title"),
                 "error": str(e)}
        results.append(r)
    done = sum(1 for r in results if r.get("ok"))
    _emit(progress, stage="batch_done", percent=100,
          message="批量深采结束：成功 %d / 失败 %d" % (done, total - done),
          data={"total": total, "success": done, "failed": total - done})
    return results
