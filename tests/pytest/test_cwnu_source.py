import base64
import json
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from app.services import collect_service, cwnu_source


def test_search_page_link_and_scoped_source_detection():
    url = collect_service.build_url(cwnu_source.SOURCE_URL, "奖学金")
    value = parse_qs(urlsplit(url).query)["query"][0]
    decoded = json.loads(base64.b64decode(value))
    assert decoded["keyWord"] == "奖学金" and decoded["token"] == "tourist"
    assert cwnu_source.is_source("https://www.cwnu.edu.cn/")
    assert not cwnu_source.is_source("https://www.cwnu.edu.cn.example.com/")
    assert not cwnu_source.is_source("https://www.cwnu.edu.cn/info/1067/45421.htm")


def test_structured_collection_pagination_and_untrusted_urls():
    payload = {"code": "0000", "data": {"page": {"records": [
        {"title": "学校设立<span>奖学金</span>", "intro": "<b>捐赠仪式</b>",
         "url": "//www.cwnu.edu.cn:443/info/1067/45421.htm", "createDate": "2024-05-09 08:42:21"},
        {"title": "学生工作部公告", "url": "https://xgb.cwnu.edu.cn/info/1/2.htm"},
        {"title": "外站假冒", "url": "https://cwnu.edu.cn.example.com/x"},
        {"title": "注入链接", "url": "javascript:alert(1)"},
    ]}}}
    response = Mock()
    response.json.return_value = payload
    source = {"id": 987, "name": "西华师范大学官网", "url": cwnu_source.SOURCE_URL, "headers": "{}"}
    with patch.object(cwnu_source.requests, "post", return_value=response) as request, \
            patch.object(collect_service, "fetch_html", side_effect=AssertionError("no page scraping")), \
            patch.object(collect_service.CollectRepository, "save_items", return_value={"new": 2, "saved": 2}) as save:
        result = collect_service.collect(source, "奖学金", page_index=2)
    assert result["ok"] and result["engine"] == "official_api" and result["fetched"] == 2
    kwargs = request.call_args.kwargs
    assert kwargs["json"]["page"] == {"current": 1, "size": 10}
    assert kwargs["headers"]["Authorization"] == "tourist"
    assert "Cookie" not in kwargs["headers"]
    items = save.call_args.args[-1]
    assert items[0]["title"] == "学校设立奖学金"
    assert items[0]["summary"] == "捐赠仪式"
    assert items[0]["time"] == "2024-05-09 08:42:21"


def test_api_failure_does_not_become_fake_empty_success():
    with patch.object(cwnu_source.requests, "post") as request:
        request.return_value.json.return_value = {"code": "9999", "msg": "unavailable"}
        result = collect_service.collect({"id": 987, "name": "官网", "url": cwnu_source.SOURCE_URL}, "奖学金")
    assert result["ok"] is False and "异常" in result["error"]
