"""Knowledge bindings reject unusable references at the API boundary."""
import json
import uuid

from conftest import ApiCase


class TestKnowledgeBindingApi(ApiCase):
    def setUp(self):
        super().setUp()
        self.login()
        from app.models import intelligence
        from app.models.digital_employee import DigitalEmployeeRepository
        self.document_id = intelligence.save_document(
            '绑定测试资料-' + uuid.uuid4().hex, 'local-lexical-v1', [('有效知识正文', [1.0])])
        self.employee_id = DigitalEmployeeRepository.create(
            '绑定测试助理-' + uuid.uuid4().hex, instructions='按知识资料回答。',
            rag_kb_ids=[str(self.document_id)])

    def _payload(self, ids):
        return {'name': '新绑定助理-' + uuid.uuid4().hex,
                'instructions': '按知识资料回答。', 'workspace_path': 'workspace',
                'rag_kb_ids': ids}

    def _post_both(self, ids):
        return (
            self.post_json('/api/admin/employees', self._payload(ids)),
            self.post_json('/api/admin/employees/%d' % self.employee_id, {'rag_kb_ids': ids}),
        )

    def _bindings(self, employee_id=None):
        from app.models.digital_employee import DigitalEmployeeRepository
        row = DigitalEmployeeRepository.get_by_id(employee_id or self.employee_id)
        return json.loads(row['rag_kb_ids'])

    def test_invalid_id_forms_return_400_without_changing_bindings(self):
        for ids in ('1,2', None, {}, [True], [1.5], ['-1'], ['0'], [''], ['1 OR 1=1'], ['９']):
            with self.subTest(ids=ids):
                for resp in self._post_both(ids):
                    assert resp.code == 400
                    assert isinstance(json.loads(resp.body)['error'], str)
                assert self._bindings() == [str(self.document_id)]

    def test_deleted_document_is_rejected(self):
        from app.models import intelligence
        intelligence.remove_document(self.document_id)
        for resp in self._post_both([str(self.document_id)]):
            assert resp.code == 400
        assert self._bindings() == [str(self.document_id)]

    def test_nonexistent_document_is_rejected(self):
        for resp in self._post_both(['999999999999999999']):
            assert resp.code == 400
        assert self._bindings() == [str(self.document_id)]

    def test_empty_document_is_rejected(self):
        from app.models import intelligence
        empty_id = intelligence.save_document('无正文测试-' + uuid.uuid4().hex, 'local-lexical-v1', [])
        for resp in self._post_both([str(empty_id)]):
            assert resp.code == 400
        assert self._bindings() == [str(self.document_id)]

    def test_more_than_30_distinct_documents_is_rejected(self):
        from app.models import intelligence
        ids = [str(intelligence.save_document(
            '数量测试-%s-%d' % (uuid.uuid4().hex, i), 'local-lexical-v1', [('有效正文', [1.0])]))
               for i in range(31)]
        for resp in self._post_both(ids):
            assert resp.code == 400
        assert self._bindings() == [str(self.document_id)]

    def test_empty_array_clears_bindings(self):
        create, update = self._post_both([])
        assert create.code == update.code == 200
        created_id = json.loads(create.body)['id']
        assert self._bindings(created_id) == []
        assert self._bindings() == []

    def test_duplicate_ids_are_canonicalized(self):
        create, update = self._post_both([self.document_id, str(self.document_id), self.document_id])
        assert create.code == update.code == 200
        assert self._bindings(json.loads(create.body)['id']) == [str(self.document_id)]
        assert self._bindings() == [str(self.document_id)]

    def test_omitted_bindings_are_preserved_on_update(self):
        resp = self.post_json('/api/admin/employees/%d' % self.employee_id, {'description': '更新简介'})
        assert resp.code == 200
        assert self._bindings() == [str(self.document_id)]

    def test_document_options_do_not_truncate_old_bindings(self):
        from app.models import intelligence
        for i in range(102):
            intelligence.save_document('列表测试-%s-%d' % (uuid.uuid4().hex, i),
                                       'local-lexical-v1', [('有效正文', [1.0])])
        options = intelligence.document_options()
        assert self.document_id in {r['id'] for r in options}
        assert len(options) > 100
