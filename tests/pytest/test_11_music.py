# -*- coding: utf-8 -*-
"""11 成员 D：@音乐 内置曲库（/api/music/search|play + 本地音频静态可播）"""

import json
import urllib.parse

from conftest import ApiCase
from unittest.mock import patch


def q(text):
    return urllib.parse.quote(text)


class TestMusic(ApiCase):
    def setUp(self):
        super().setUp()
        self.client_id_patch = patch("app.config.JAMENDO_CLIENT_ID", "")
        self.client_id_patch.start()
        self.addCleanup(self.client_id_patch.stop)
        self.login()

    def test_search_requires_login(self):
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.get_json("/api/music/search")
        assert resp.code == 401

    def test_search_hot_list(self):
        """空关键词 → 热门全量列表（种子 6 首，file 均指向 /static/music/）"""
        resp = self.get_json("/api/music/search?limit=20")
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        assert len(body["list"]) == 6
        for t in body["list"]:
            assert t["file"].startswith("/static/music/") and t["file"].endswith(".wav")
            assert t["title"] and t["style"]

    def test_search_by_style(self):
        resp = self.get_json("/api/music/search?q=" + q("电子"))
        body = json.loads(resp.body)
        assert body["ok"] is True
        assert len(body["list"]) == 2
        assert all(t["style"] == "电子" for t in body["list"])

    def test_search_multi_word(self):
        """多词交集：「钢琴 治愈」只命中同时含两词的曲目（疗愈之雨）"""
        resp = self.get_json("/api/music/search?q=" + q("钢琴 治愈"))
        body = json.loads(resp.body)
        titles = [t["title"] for t in body["list"]]
        assert titles == ["疗愈之雨"]

    def test_search_no_match(self):
        resp = self.get_json("/api/music/search?q=" + q("不存在曲目xyz"))
        assert json.loads(resp.body)["list"] == []

    def test_play_bumps_count(self):
        track_id = json.loads(self.get_json("/api/music/search?q=" + q("轻音乐")).body)["list"][0]["id"]
        before = json.loads(self.get_json("/api/music/search?limit=20").body)
        target = next(t for t in before["list"] if t["id"] == track_id)
        resp = self.post_json("/api/music/play", {"id": track_id})
        assert resp.code == 200
        body = json.loads(resp.body)
        assert body["ok"] is True
        assert body["track"]["play_count"] == target["play_count"] + 1

    def test_play_bad_id(self):
        assert self.post_json("/api/music/play", {"id": "abc"}).code == 400
        assert self.post_json("/api/music/play", {}).code == 400

    def test_play_unknown_id(self):
        resp = self.post_json("/api/music/play", {"id": 999999})
        assert resp.code == 404

    def test_audio_files_served(self):
        """种子音频真实落盘且可经静态路由下载（演示不哑火）"""
        for t in json.loads(self.get_json("/api/music/search?limit=20").body)["list"]:
            resp = self.fetch(t["file"], raise_error=False)
            assert resp.code == 200, "%s 不可访问" % t["file"]
            assert resp.body[:4] == b"RIFF"
            assert len(resp.body) > 10000
