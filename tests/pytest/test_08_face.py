# -*- coding: utf-8 -*-
"""08 人脸：本人接口 + 后台人脸管理（任务13）"""

import json

from conftest import ApiCase


class TestFace(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()

    def test_face_status_requires_login(self):
        self.post_form("/auth/logout", {}, follow=False)
        resp = self.get_json("/api/face/status")
        assert resp.code == 401
        assert json.loads(resp.body)["code"] == "UNAUTHORIZED"

    def test_face_status_fields(self):
        body = json.loads(self.get_json("/api/face/status").body)
        assert body["ok"] is True
        assert body["engine"] in ("onnx", "fallback")
        assert isinstance(body["real"], bool)
        assert body["threshold"] > 0
        assert "faces" in body and isinstance(body["faces"], list)

    def test_face_enroll_requires_image(self):
        resp = self.post_json("/api/face/enroll", {})
        assert resp.code == 400
        assert "图片" in json.loads(resp.body)["error"]

    def test_face_verify_without_enrollment(self):
        resp = self.post_json("/api/face/verify", {})
        assert resp.code == 404
        assert "尚未录入" in json.loads(resp.body)["error"]

    def test_face_delete_unknown(self):
        resp = self.delete("/api/face/99999")
        assert resp.code == 404

    def test_admin_faces_unknown_user(self):
        resp = self.get_json("/api/admin/users/99999/faces")
        assert resp.code == 404
        assert "用户不存在" in json.loads(resp.body)["error"]

    def test_admin_faces_of_admin(self):
        from app.models.user import UserRepository
        admin = UserRepository.get_user_by_username("admin")
        body = json.loads(self.get_json("/api/admin/users/%d/faces" % admin["id"]).body)
        assert body["ok"] is True
        assert isinstance(body["faces"], list)
        # 不允许下发特征向量
        for row in body["faces"]:
            assert "feature" not in row
