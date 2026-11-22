"""Map route authentication, local model integrity and knowledge presentation."""
import hashlib
import json
from pathlib import Path
import struct

from conftest import ApiCase
from app.services.intelligence_service import knowledge_display_text


class TestCampusMap(ApiCase):
    def test_map_page_requires_login_and_sidebar_links_to_it(self):
        assert self.fetch("/campus-map", follow_redirects=False).code == 302
        self.login()
        page = self.fetch("/campus-map")
        assert page.code == 200
        assert b'id="mapStage"' in page.body
        assert b"OpenStreetMap" in page.body
        assert b'id="mapLabelLayer"' in page.body
        assert b'id="mapSearchForm"' in page.body
        assert b'href="/campus-map"' in self.fetch("/").body
        assert self.fetch("/static/js/campus-map.js").code == 200
        response = self.fetch("/static/maps/xingshu-campus/xingshu-campus.glb")
        assert response.code == 200 and response.body[:4] == b"glTF"

    def test_all_buildings_have_review_records_without_claiming_real_3d(self):
        self.login()
        ids = []
        for group in ("01-14", "15-28", "29-42"):
            response = self.fetch("/static/maps/xingshu-campus/buildings-" + group + ".json")
            assert response.code == 200
            data = json.loads(response.body)
            for feature in data["features"]:
                assert feature["reviewStatus"] == "needs-review"
                assert isinstance(feature["issues"], list) and feature["modelName"]
                ids.append(feature["id"])
        assert len(ids) == len(set(ids)) == 42


def test_model_matches_manifest_and_has_every_selectable_building():
    root = Path(__file__).resolve().parents[2] / "app/static/maps/xingshu-campus"
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    data = (root / "xingshu-campus.glb").read_bytes()
    assert hashlib.sha256(data).hexdigest() == manifest["model"]["sha256"]
    size, kind = struct.unpack_from("<II", data, 12)
    assert kind == 0x4E4F534A
    gltf = json.loads(data[20:20 + size])
    names = {node.get("name") for node in gltf["nodes"]}
    assert all("feature__" + feature["id"] in names for feature in manifest["features"])
    assert not gltf.get("extensionsRequired")  # compatible with bundled GLTFLoader


def test_gate_markers_follow_reference_registration():
    root = Path(__file__).resolve().parents[2] / "app/static/maps/xingshu-campus"
    data = json.loads((root / "landmarks.json").read_text(encoding="utf-8"))
    assert {gate["name"] for gate in data["landmarks"]} == {"西门", "南门"}
    for gate in data["landmarks"]:
        px, py = gate["referencePixel"]
        affine = data["pixelToLocalAffine"]
        x = sum(v*w for v, w in zip(affine["x"], [px, py, 1]))
        north = sum(v*w for v, w in zip(affine["y"], [px, py, 1]))
        assert abs(gate["positionLocal"][0] - x) < 0.001
        assert abs(gate["positionLocal"][2] + north) < 0.001
        assert gate["status"] == "approximate"


def test_map_vue_code_becomes_local_link_without_enabling_html():
    component = '<ClientOnly>\n<XingshuCampusMap />\n<template #fallback>加载中</template>\n</ClientOnly>'
    content = component + '\n原文：https://scswiki.com/start/xingshu-campus-map'
    shown = knowledge_display_text(content)
    assert "[打开行署校区三维地图](/campus-map)" in shown
    assert "ClientOnly" not in shown and "template" not in shown
    assert "原文：https://scswiki.com/" in shown
    assert knowledge_display_text(component) == component
