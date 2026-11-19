/*
 * archives.js —— 会话归档页面前端逻辑（成员 E）
 * 由 templates/admin/archives.html 引入，走 /api/admin/archives 拉取归档列表。
 * 支持：username / session_id / role / start_at / end_at / keyword 组合筛选，分页 20/页。
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
        filters: { username: "", session_id: "", role: "", start_at: "", end_at: "", keyword: "" },
    };

    function apiGet(url) {
        return fetch(url, { headers: { "X-Xsrftoken": xsrf() } }).then(function (resp) {
            if (resp.status === 401) { location.href = "/auth/login"; return Promise.reject("unauth"); }
            return resp.json();
        }).then(function (d) {
            if (d && d.ok === false) {
                if (L.layer) L.layer.msg(d.error || "加载失败", { icon: 2 });
                return Promise.reject(d);
            }
            return d;
        });
    }

    function buildQuery() {
        var f = state.filters;
        var parts = ["page=" + state.page];
        ["username", "session_id", "role", "start_at", "end_at", "keyword"].forEach(function (k) {
            if (f[k]) parts.push(k + "=" + encodeURIComponent(f[k]));
        });
        return parts.join("&");
    }

    function rowHtml(r) {
        var partial = r.is_partial ? '<span class="archive-badge warn">中断</span>' : "";
        return '' +
            '<tr>' +
            '  <td>' + esc(r.id) + '</td>' +
            '  <td title="原 messages 表主键">' + esc(r.origin_id) + '</td>' +
            '  <td>' + esc(r.username) + '</td>' +
            '  <td class="arc-sid" title="' + esc(r.session_id) + '">' + esc(truncate(r.session_id, 18)) + '</td>' +
            '  <td><span class="archive-role ' + esc(r.role) + '">' + esc(r.role) + '</span> ' + partial + '</td>' +
            '  <td class="arc-content" title="' + esc(r.content) + '">' + esc(truncate(r.content, 60)) + '</td>' +
            '  <td>' + esc(r.origin_created_at) + '</td>' +
            '  <td>' + esc(r.archived_at) + '</td>' +
            '</tr>';
    }

    function load(page) {
        state.page = page || 1;
        return apiGet("/api/admin/archives?" + buildQuery()).then(function (d) {
            $("arcCount").textContent = d.total;
            $("archiveFiltered").textContent = "共 " + d.total + " 条";
            $("archiveTotalAll").textContent = d.total_all;
            var list = d.list || [];
            var html = list.map(rowHtml).join("");
            $("arcBody").innerHTML = html ||
                '<tr><td colspan="8" class="admin-empty"><i class="fas fa-inbox"></i> 暂无归档记录，可等待「每日会话归档」任务运行或手动触发</td></tr>';
            L.laypage.render({
                elem: "arcPager",
                count: d.total,
                limit: d.page_size || 20,
                curr: state.page,
                layout: ["count", "prev", "page", "next", "skip"],
                jump: function (obj, first) { if (!first) load(obj.curr); }
            });
        }).catch(function () {
            $("arcBody").innerHTML = '<tr><td colspan="8" class="admin-empty"><i class="fas fa-exclamation-triangle"></i> 加载失败，请刷新重试</td></tr>';
        });
    }

    function collectFilters() {
        state.filters.username = $("arcUsername").value.trim();
        state.filters.session_id = $("arcSessionId").value.trim();
        state.filters.role = $("arcRole").value;
        var s = $("arcStart").value.trim();
        var e = $("arcEnd").value.trim();
        state.filters.start_at = s ? (s.length === 10 ? s + " 00:00:00" : s) : "";
        state.filters.end_at = e ? (e.length === 10 ? e + " 23:59:59" : e) : "";
        state.filters.keyword = $("arcKeyword").value.trim();
    }

    function resetFilters() {
        ["arcUsername", "arcSessionId", "arcStart", "arcEnd", "arcKeyword"].forEach(function (id) {
            $(id).value = "";
        });
        $("arcRole").value = "";
        if (L.form) L.form.render("select");
        state.filters = { username: "", session_id: "", role: "", start_at: "", end_at: "", keyword: "" };
    }

    function bindEnter(el, fn) {
        el.addEventListener("keydown", function (e) { if (e.key === "Enter") fn(); });
    }

    function init() {
        layui.use(["layer", "form", "laypage"], function () {
            L.layer = layui.layer;
            L.form = layui.form;
            L.laypage = layui.laypage;

            $("arcSearch").addEventListener("click", function () {
                collectFilters();
                load(1);
            });
            $("arcReset").addEventListener("click", function () {
                resetFilters();
                load(1);
            });
            ["arcUsername", "arcSessionId", "arcStart", "arcEnd", "arcKeyword"].forEach(function (id) {
                bindEnter($(id), function () { $("arcSearch").click(); });
            });
            L.form.on("select(arcRole)", function () {
                collectFilters();
                load(1);
            });

            load(1);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
