"""CWNU's public, visitor-accessible structured site search."""
import base64
import json
from urllib.parse import urlencode, urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

ORIGIN = "https://www.cwnu.edu.cn"
SEARCH_PATH = "/aop_views/search/modules/resultpcall/soso.html"
SOURCE_URL = ORIGIN + SEARCH_PATH + "?keyword={关键字}"
ENDPOINT = ORIGIN + "/aop_component/webber/search/search/search/queryPage"
OWNER = "2088659175"


def is_source(url):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == "https" and parsed.netloc == "www.cwnu.edu.cn"
                and parsed.path in ("", "/", SEARCH_PATH))
    except ValueError:
        return False


def search_url(keyword):
    query = {"keyWord": keyword, "owner": OWNER, "token": "tourist",
             "urlPrefix": "/aop_component/", "lang": "i18n_zh_CN"}
    encoded = base64.b64encode(json.dumps(query, ensure_ascii=False).encode()).decode()
    return ORIGIN + SEARCH_PATH + "?" + urlencode({"query": encoded})


def _official_url(value):
    try:
        url = urljoin(ORIGIN, str(value or "").strip())
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if (parsed.scheme in ("https", "http") and not parsed.username and not parsed.password
                and (host == "cwnu.edu.cn" or host.endswith(".cwnu.edu.cn"))
                and parsed.port in (None, 80, 443)):
            return url
    except ValueError:
        pass
    return ""


def parse_results(payload):
    if not isinstance(payload, dict) or str(payload.get("code")) != "0000":
        raise ValueError("学校官网搜索返回异常，请稍后重试")
    page = (payload.get("data") or {}).get("page")
    if not isinstance(page, dict):
        raise ValueError("学校官网搜索结果格式已变化")
    records = page.get("records") or []
    if not isinstance(records, list):
        raise ValueError("学校官网搜索结果格式已变化")
    items, seen = [], set()
    for row in records[:10]:
        if not isinstance(row, dict):
            continue
        title = BeautifulSoup(str(row.get("title") or ""), "html.parser").get_text("", strip=True)
        url = _official_url(row.get("url"))
        if not title or not url or url in seen:
            continue
        seen.add(url)
        summary = BeautifulSoup(str(row.get("intro") or ""), "html.parser").get_text(" ", strip=True)
        pictures = row.get("picture") or []
        cover = next((_official_url(p) for p in pictures if isinstance(p, str) and _official_url(p)), "") if isinstance(pictures, list) else ""
        items.append({"title": title, "url": url, "summary": summary[:500],
                      "time": str(row.get("createDate") or ""), "cover": cover})
    return items


def search(keyword, page_index=1):
    body = {"aliasName": "article_data,open_data", "keyWord": keyword,
            "searchKeyWord": False, "orderType": "date", "searchType": "text",
            "searchScope": "1", "searchOperator": 1, "language": "chinese",
            "allsite": True, "owner": OWNER, "token": "tourist",
            "filterTerm": {"wbsourceid": ["0", "6"]},
            "isMatchQuery": keyword.isascii() and keyword.isalpha(),
            "page": {"current": max(0, int(page_index) - 1), "size": 10}}
    try:
        response = requests.post(ENDPOINT, json=body, timeout=25,
                                 headers={"Authorization": "tourist", "owner": OWNER,
                                          "appId": "app-search", "allsite": "1"})
        response.raise_for_status()
        return parse_results(response.json())
    except requests.RequestException as exc:
        raise ValueError("学校官网搜索连接失败，请稍后重试") from exc
