/*
 * sessions.js —— 临时会话（登录会话）查询前端逻辑（成员 E）
 * 由 templates/admin/sessions.html 引入，走 /api/admin/sessions 接口。
 * 功能：按 username/ip/state 筛选、分页、撤销单条、按用户批量下线、清理已撤销/过期。
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
        filters: { username: "", client_ip: "", state: "active" },
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
        var parts = ["page=" + state.page, "state=" + encodeURIComponent(f.state)];
        if (f.username) parts.push("username=" + encodeURIComponent(f.username));
        if (f.client_ip) parts.push("client_ip=" + encodeURIComponent(f.client_ip));
        return parts.join("&");
    }

    function statusOf(row) {
        if (row.revoked) return { label: "已撤销", cls: "revoked" };
        var now = new Date();
        var exp = new Date((row.expires_at || "").replace(" ", "T"));
        if (exp <= now) return { label: "已过期", cls: "expired" };
        return { label: "活跃", cls: "active" };
    }

    function rowHtml(s) {
        var st = statusOf(s);
        var canRevoke = !s.revoked && st.cls !== "expired";
        var ops = canRevoke
            ? '<button type="button" class="layui-btn layui-btn-xs layui-btn-danger" data-act="revoke" data-id="' + s.id + '" data-username="' + esc(s.username) + '"><i class="fas fa-ban"></i> 撤销</button>'
            : '<span class="sess-offline">—</span>';
        return '' +
            '<tr>' +
            '  <td>' + esc(s.id) + '</td>' +
            '  <td>' + esc(s.username) + '</td>' +
            '  <td><span class="sess-role">' + esc(s.role) + '</span></td>' +
            '  <td class="sess-ip">' + esc(s.client_ip || "—") + '</td>' +
            '  <td class="sess-ua" title="' + esc(s.user_agent) + '">' + esc(truncate(s.user_agent, 40)) + '</td>' +
            '  <td>' + esc(s.created_at) + '</td>' +
            '  <td>' + esc(s.last_seen_at) + '</td>' +
            '  <td>' + esc(s.expires_at) + '</td>' +
            '  <td><span class="sess-st ' + st.cls + '">' + st.label + '</span></td>' +
            '  <td class="sess-ops">' + ops + '</td>' +
            '</tr>';
    }

    function load(page) {
        state.page = page || 1;
        return api("GET", "/api/admin/sessions?" + buildQuery()).then(function (d) {
            $("sessCount").textContent = d.total;
            var stats = d.stats || {};
            $("statActive").textContent = stats.active || 0;
            $("statRevoked").textContent = stats.revoked || 0;
            $("statExpired").textContent = stats.expired || 0;
            var list = d.list || [];
            var html = list.map(rowHtml).join("");
            $("sessBody").innerHTML = html ||
                '<tr><td colspan="10" class="admin-empty"><i class="fas fa-inbox"></i> 暂无符合条件的会话</td></tr>';
            L.laypage.render({
                elem: "sessPager",
                count: d.total,
                limit: d.page_size || 20,
                curr: state.page,
                layout: ["count", "prev", "page", "next", "skip"],
                jump: function (obj, first) { if (!first) load(obj.curr); }
            });
        }).catch(function () {
            $("sessBody").innerHTML = '<tr><td colspan="10" class="admin-empty"><i class="fas fa-exclamation-triangle"></i> 加载失败</td></tr>';
        });
    }

    function collectFilters() {
        state.filters.username = $("sessUsername").value.trim();
        state.filters.client_ip = $("sessIp").value.trim();
        state.filters.state = $("sessState").value || "active";
    }

    function resetFilters() {
        $("sessUsername").value = "";
        $("sessIp").value = "";
        $("sessState").value = "active";
        if (L.form) L.form.render("select");
        state.filters = { username: "", client_ip: "", state: "active" };
    }

    function revoke(id, username) {
        L.layer.confirm("确定撤销该会话？该设备（用户 " + username + "）将立即掉线。", { icon: 3 }, function (idx) {
            L.layer.close(idx);
            api("POST", "/api/admin/sessions", { action: "revoke", id: id }).then(function (d) {
                L.layer.msg("已撤销 " + d.revoked + " 条会话", { icon: 1 });
                load(state.page);
            });
        });
    }

    function revokeUsername() {
        // 默认带入筛选框里的用户名，避免重复输入
        L.layer.prompt({
            title: "输入要强制下线的用户名（该用户全部设备立即掉线）",
            value: state.filters.username || "",
            formType: 0,
        }, function (value, idx) {
            var username = String(value || "").trim();
            if (!username) { L.layer.msg("用户名不能为空", { icon: 0 }); return; }
            L.layer.close(idx);
            L.layer.confirm("确定撤销用户 " + username + " 的全部会话？", { icon: 3 }, function (cidx) {
                L.layer.close(cidx);
                api("POST", "/api/admin/sessions", { action: "revoke_username", username: username })
                    .then(function (d) {
                        L.layer.msg("已撤销 " + d.revoked + " 条会话", { icon: 1 });
                        load(state.page);
                    });
            });
        });
    }

    function purgeExpired() {
        L.layer.confirm("清理所有已撤销与已过期的会话记录（从数据库删除），确定？", { icon: 3 }, function (idx) {
            L.layer.close(idx);
            api("POST", "/api/admin/sessions", { action: "purge_expired" }).then(function (d) {
                L.layer.msg("已清理 " + d.removed + " 条", { icon: 1 });
                load(state.page);
            });
        });
    }

    function bindEvents() {
        $("sessSearch").addEventListener("click", function () { collectFilters(); load(1); });
        $("sessReset").addEventListener("click", function () { resetFilters(); load(1); });
        ["sessUsername", "sessIp"].forEach(function (id) {
            $(id).addEventListener("keydown", function (e) { if (e.key === "Enter") $("sessSearch").click(); });
        });
        L.form.on("select(sessState)", function () { collectFilters(); load(1); });

        $("sessBody").addEventListener("click", function (e) {
            var btn = e.target.closest("[data-act]");
            if (!btn) return;
            var id = parseInt(btn.getAttribute("data-id"), 10);
            var username = btn.getAttribute("data-username") || "";
            var act = btn.getAttribute("data-act");
            if (act === "revoke") revoke(id, username);
        });

        $("sessRevokeUser").addEventListener("click", revokeUsername);
        $("sessPurge").addEventListener("click", purgeExpired);
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
