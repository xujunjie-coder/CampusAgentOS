/**
 * tools.js —— 工具链路（成员 C）
 * 数据：GET /api/admin/tools → {tools:[{id,name,kind,provider,desc,bound_count,bound}], employees, total_tools, bound_total}
 * 只读渲染 + 本地搜索（不改后端任何状态）。
 */
(function () {
    'use strict';

    var C = window.Console;
    var state = { tools: [], keyword: '' };

    function id(name) { return document.getElementById(name); }

    function toolRow(t) {
        var chips = t.bound && t.bound.length
            ? t.bound.map(function (e) {
                return '<span class="ck-chip"><i class="fas fa-user-astronaut"></i>' + C.esc(e.name) + '</span>';
            }).join('')
            : '<span style="color:#a3adbd;font-size:12px;">未绑定任何员工</span>';
        return '<tr>' +
            '<td><div class="ck-tool-name">' + C.esc(t.name) + '</div>' +
            '<div class="ck-tool-id">' + C.esc(t.id) + '</div></td>' +
            '<td><span class="ck-tool-kind" data-k="' + C.esc(t.kind) + '">' + C.esc(t.kind) + '</span></td>' +
            '<td style="font-size:12px;color:#6b7789;">' + C.esc(t.provider) + '</td>' +
            '<td style="font-size:12px;color:#5c677a;line-height:1.7;">' + C.esc(t.desc) + '</td>' +
            '<td><div class="ck-bound-chips">' + chips + '</div></td>' +
            '</tr>';
    }

    function render() {
        var keyword = state.keyword.toLowerCase();
        var rows = state.tools.filter(function (t) {
            if (!keyword) { return true; }
            return (t.name + ' ' + t.id + ' ' + t.desc + ' ' + t.provider).toLowerCase().indexOf(keyword) >= 0;
        });
        id('toolBody').innerHTML = rows.length
            ? rows.map(toolRow).join('')
            : '<tr><td colspan="5" style="color:#9aa4b2;padding:22px;text-align:center;">没有匹配的工具</td></tr>';
    }

    function apply(data) {
        state.tools = data.tools || [];
        var employees = data.employees || [];
        var enabled = employees.filter(function (e) { return e.enabled; }).length;
        var kinds = {};
        state.tools.forEach(function (t) { kinds[t.kind] = true; });

        id('toolCount').textContent = data.total_tools || state.tools.length;
        id('bindCount').textContent = data.bound_total || 0;
        id('kpiTools').innerHTML = C.fmtNum(data.total_tools || state.tools.length) + '<small>个</small>';
        id('kpiBinds').innerHTML = C.fmtNum(data.bound_total || 0) + '<small>条</small>';
        id('kpiEmployees').innerHTML = C.fmtNum(employees.length) + '<small>个</small>';
        id('kpiEmployeesSub').textContent = '启用 ' + enabled;
        id('kpiKinds').innerHTML = C.fmtNum(Object.keys(kinds).length) + '<small>类</small>';

        render();
    }

    function load() {
        C.api('GET', '/api/admin/tools').then(apply).catch(function (err) {
            id('toolBody').innerHTML = '<tr><td colspan="5" style="color:#c0342b;padding:18px;">加载失败：' +
                C.esc(err.message) + '</td></tr>';
        });
    }

    function bind() {
        id('toolKeyword').addEventListener('input', C.debounce(function () {
            state.keyword = this.value.trim();
            render();
        }, 200));
        id('btnReload').addEventListener('click', function () {
            load();
            C.toast('已刷新', 'ok');
        });
    }

    function boot() { bind(); load(); }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else { boot(); }
})();
