/*
 * messages.js —— 对话记录管理前端逻辑（成员 E）
 * 由 templates/admin/messages.html 引入，走 /api/admin/messages 接口。
 * 功能：多条件筛选、分页、全选、批量删除、查看详情、删除单条。
 */
(function () {
    "use strict";

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }
    function truncate(s, n) {
        s = String(s == null ? "" : s);
        return s.length > n ? s.slice(0, n) + "…" : s;
    }
    function xsrf() {
        var f = $("adminLogoutForm");
        if (!f) return "";
        var i = f.querySelector('input[name="_xsrf"]');
        return i ? i.value : "";
    }

    var L = {};
    var state = {
        page: 1,
        filters: { username: "", session_id: "", role: "", keyword: "", start_at: "", end_at: "" },
        rowCache: {},
        selected: {},
    };

    function api(method, url, body) {
        var opt = { method: method, headers: { "Content-Type": "application/json", "X-Xsrftoken": xsrf() } };
        if (body !== undefined) opt.body = JSON.stringify(body);
        return fetch(url, opt).then(function (resp) {
            if (resp.status === 401) { location.href = "/auth/login"; return Promise.reject("unauth"); }
            return resp.json();
        }).then(function (d) {
            if (d && d.ok === false) {
                L.layer.msg(d.error || "操作失败", { icon: 2 });
                return Promise.reject(d);
            }
            return d;
        });
    }

    function buildQuery() {
        var f = state.filters;
        var parts = ["page=" + state.page];
        ["username", "session_id", "role", "keyword", "start_at", "end_at"].forEach(function (k) {
            if (f[k]) parts.push(k + "=" + encodeURIComponent(f[k]));
        });
        return parts.join("&");
    }

    function rowHtml(m) {
        var checked = state.selected[m.id] ? " checked" : "";
        var partial = m.is_partial ? '<span class="msg-badge warn">中断</span>' : "";
        var emp = m.employee_name ? esc(m.employee_name) : "—";
        return '' +
            '<tr data-id="' + m.id + '">' +
            '  <td><input type="checkbox" class="msg-row-check" data-id="' + m.id + '"' + checked + '></td>' +
            '  <td>' + esc(m.id) + '</td>' +
            '  <td>' + esc(m.username) + '</td>' +
            '  <td class="msg-sid" title="' + esc(m.session_id) + '">' + esc(truncate(m.session_id, 16)) + '</td>' +
            '  <td><span class="msg-role ' + esc(m.role) + '">' + esc(m.role) + '</span> ' + partial + '</td>' +
            '  <td class="msg-content" title="' + esc(m.content) + '">' + esc(truncate(m.content, 50)) + '</td>' +
            '  <td>' + emp + '</td>' +
            '  <td>' + esc(m.created_at) + '</td>' +
            '  <td class="msg-ops">' +
            '    <button type="button" class="layui-btn layui-btn-xs layui-btn-primary" data-act="view" data-id="' + m.id + '"><i class="fas fa-eye"></i> 详情</button>' +
            '    <button type="button" class="layui-btn layui-btn-xs layui-btn-danger" data-act="del" data-id="' + m.id + '"><i class="fas fa-trash-alt"></i> 删除</button>' +
            '  </td>' +
            '</tr>';
    }

    function load(page) {
        state.page = page || 1;
        return api("GET", "/api/admin/messages?" + buildQuery()).then(function (d) {
            $("msgCount").textContent = d.total;
            $("msgFiltered").textContent = "共 " + d.total + " 条";
            $("msgTotalAll").textContent = d.total_all;
            state.rowCache = {};
            state.selected = {};
            $("msgCheckAll").checked = false;
            var list = d.list || [];
            list.forEach(function (m) { state.rowCache[m.id] = m; });
            var html = list.map(rowHtml).join("");
            $("msgBody").innerHTML = html ||
                '<tr><td colspan="9" class="admin-empty"><i class="fas fa-inbox"></i> 暂无匹配的对话记录</td></tr>';
            L.laypage.render({
                elem: "msgPager",
                count: d.total,
                limit: d.page_size || 20,
                curr: state.page,
                layout: ["count", "prev", "page", "next", "skip"],
                jump: function (obj, first) { if (!first) load(obj.curr); }
            });
        }).catch(function () {
            $("msgBody").innerHTML = '<tr><td colspan="9" class="admin-empty"><i class="fas fa-exclamation-triangle"></i> 加载失败</td></tr>';
        });
    }

    function collectFilters() {
        state.filters.username = $("msgUsername").value.trim();
        state.filters.session_id = $("msgSessionId").value.trim();
        state.filters.role = $("msgRole").value;
        var s = $("msgStart").value.trim();
        var e = $("msgEnd").value.trim();
        state.filters.start_at = s ? (s.length === 10 ? s + " 00:00:00" : s) : "";
        state.filters.end_at = e ? (e.length === 10 ? e + " 23:59:59" : e) : "";
        state.filters.keyword = $("msgKeyword").value.trim();
    }

    function resetFilters() {
        ["msgUsername", "msgSessionId", "msgStart", "msgEnd", "msgKeyword"].forEach(function (id) {
            $(id).value = "";
        });
        $("msgRole").value = "";
        if (L.form) L.form.render("select");
        state.filters = { username: "", session_id: "", role: "", keyword: "", start_at: "", end_at: "" };
    }

    function viewDetail(id) {
        api("GET", "/api/admin/messages/" + id).then(function (d) {
            var m = d.data;
            // 无应答助理时只出「—」，不拼接冗余的 (id=0)
            var emp = m.employee_name
                ? esc(m.employee_name) + (m.employee_id ? " (id=" + esc(m.employee_id) + ")" : "")
                : "—";
            var html = '<div class="msg-detail">' +
                '<div class="kv"><b>ID：</b>' + esc(m.id) + '</div>' +
                '<div class="kv"><b>用户名：</b>' + esc(m.username) + '</div>' +
                '<div class="kv"><b>会话 ID：</b><code>' + esc(m.session_id) + '</code></div>' +
                '<div class="kv"><b>角色：</b>' + esc(m.role) + '</div>' +
                '<div class="kv"><b>应答助理：</b>' + emp + '</div>' +
                '<div class="kv"><b>时间：</b>' + esc(m.created_at) + '</div>' +
                '<div class="kv"><b>是否中断：</b>' + (m.is_partial ? "是" : "否") + '</div>' +
                '<div class="kv"><b>内容：</b></div>' +
                '<pre class="msg-detail-content">' + esc(m.content) + '</pre>' +
                '</div>';
            L.layer.open({
                type: 1,
                title: "对话记录详情",
                area: ["720px", "620px"],
                content: html,
                shadeClose: true,
            });
        });
    }

    function delOne(id) {
        L.layer.confirm("确定删除这条对话记录？删除后不可恢复。", { icon: 3 }, function (idx) {
            L.layer.close(idx);
            api("DELETE", "/api/admin/messages/" + id).then(function (d) {
                L.layer.msg("已删除 " + d.deleted + " 条", { icon: 1 });
                load(state.page);
            });
        });
    }

    function batchDelete() {
        var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).map(Number);
        if (!ids.length) { L.layer.msg("请先勾选要删除的记录", { icon: 0 }); return; }
        L.layer.confirm("确定批量删除 " + ids.length + " 条对话记录？删除后不可恢复。", { icon: 3 }, function (idx) {
            L.layer.close(idx);
            api("POST", "/api/admin/messages", { action: "delete_batch", ids: ids }).then(function (d) {
                L.layer.msg("已删除 " + d.deleted + " 条", { icon: 1 });
                load(state.page);
            });
        });
    }

    function bindEvents() {
        $("msgSearch").addEventListener("click", function () { collectFilters(); load(1); });
        $("msgReset").addEventListener("click", function () { resetFilters(); load(1); });
        ["msgUsername", "msgSessionId", "msgStart", "msgEnd", "msgKeyword"].forEach(function (id) {
            $(id).addEventListener("keydown", function (e) { if (e.key === "Enter") $("msgSearch").click(); });
        });
        L.form.on("select(msgRole)", function () { collectFilters(); load(1); });

        $("msgCheckAll").addEventListener("change", function (e) {
            var on = e.target.checked;
            document.querySelectorAll(".msg-row-check").forEach(function (cb) {
                cb.checked = on;
                state.selected[cb.getAttribute("data-id")] = on;
            });
        });

        $("msgBody").addEventListener("click", function (e) {
            var cb = e.target.closest(".msg-row-check");
            if (cb) {
                state.selected[cb.getAttribute("data-id")] = cb.checked;
                return;
            }
            var btn = e.target.closest("[data-act]");
            if (!btn) return;
            var id = parseInt(btn.getAttribute("data-id"), 10);
            var act = btn.getAttribute("data-act");
            if (act === "view") viewDetail(id);
            else if (act === "del") delOne(id);
        });

        $("msgBatchDelete").addEventListener("click", batchDelete);
    }

    function init() {
        layui.use(["layer", "form", "laypage"], function () {
            L.layer = layui.layer;
            L.form = layui.form;
            L.laypage = layui.laypage;
            bindEvents();
            load(1);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
