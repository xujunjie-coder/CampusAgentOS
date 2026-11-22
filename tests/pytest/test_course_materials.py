import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app.models.digital_employee import DigitalEmployeeRepository
from app.services import course_materials
from conftest import ApiCase


class TestCourseMaterials(ApiCase):
    def setUp(self):
        super().setUp()
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.enterContext(patch.object(course_materials, "ROOT", root))
        entry = dict(title="Java Web 期末资料", aliases=["javaweb"], license="CC BY-SA 4.0",
                     credit="SCSWiki 贡献者", scope_id=321, knowledge_id=322,
                     original="javaweb-guide.pdf", preview="javaweb-guide.pdf", exam=True)
        reference = dict(title="历年离散数学卷", aliases=["离散数学"], scope_id=321,
                         credit="SCSWiki 资料目录", license="以原文件说明为准", exam=True,
                         external_url="https://scswiki.com/materials/discrete-mathematics/history.pdf")
        (root / "catalog.json").write_text(json.dumps({"javaweb-guide": entry, "discrete-exam": reference}), encoding="utf-8")
        self.pdf = b"%PDF-1.7\n%%EOF\n"
        (root / "javaweb-guide.pdf").write_bytes(self.pdf)

    def test_preview_and_original_download(self):
        base = "/api/course-materials/javaweb-guide"
        assert self.get_json(base + "/download").code == 401
        self.login()
        preview = self.get_json(base + "/preview")
        assert preview.code == 200
        assert (base + "/file").encode() in preview.body
        assert b"CC BY-SA 4.0" in preview.body
        inline = self.get_json(base + "/file")
        download = self.get_json(base + "/download")
        assert inline.headers["Content-Disposition"].startswith("inline;")
        assert download.headers["Content-Disposition"].startswith("attachment;")
        assert inline.body == download.body == self.pdf
        assert self.get_json("/api/course-materials/unknown/file").code == 404

    def test_chat_finds_local_files_without_a_model_call(self):
        self.login()
        eid = DigitalEmployeeRepository.create("资料助手测试", instructions="测试", rag_kb_ids=["321"])
        with patch("app.services.agent_service.build_agent", side_effect=AssertionError("no model needed")):
            resp = self.post_json("/api/chat", {"message": "有没有 Java Web 的期末资料？",
                                               "session_id": "course-file-test", "employee_id": eid})
        assert b"event: done" in resp.body
        assert b"/api/course-materials/javaweb-guide/preview" in resp.body
        history = self.get_json("/api/history?session_id=course-file-test")
        assert b"/api/course-materials/javaweb-guide/download" in history.body
        assert not course_materials.material_index("Java Web 期末资料", ["123"])
        matches = course_materials.material_index("Java Web 有哪些核心技术", ["321"])
        assert not course_materials.listing_reply("Java Web 有哪些核心技术", matches)

    def test_reference_only_exam_uses_original_file_without_local_download(self):
        self.login()
        query = "有离散数学期末试卷吗？"
        materials = course_materials.material_index(query, ["321"])
        reply = course_materials.listing_reply(query, materials)
        assert "[预览](/api/course-materials/discrete-exam/preview)" in reply
        assert "[原站文件](https://scswiki.com/materials/discrete-mathematics/history.pdf)" in reply
        assert "[下载]" not in reply and "学长学姐整理" not in reply
        preview = self.get_json("/api/course-materials/discrete-exam/preview")
        assert preview.code == 200
        assert b'<iframe src="https://scswiki.com/materials/discrete-mathematics/history.pdf"' in preview.body
        assert self.get_json("/api/course-materials/discrete-exam/download").code == 404
        assert not course_materials.reference_url({"external_url": "https://scswiki.com.example.com/materials/a/b.pdf"})
