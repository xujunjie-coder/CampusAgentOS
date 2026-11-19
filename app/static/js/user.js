/*
 * user.js —— 个人中心页前端逻辑（成员 D，任务2）
 * 1. GET  /api/user/profile   资料 + 统计渲染
 * 2. POST /api/user/profile   保存昵称 / 头像（头像白名单 fas fa-xxx，与后端一致）
 * 3. POST /api/user/password  改密（前端先校验两次输入一致）
 * 4. GET  /api/user/sessions  本人活跃会话列表
 * XSRF：模板隐藏 _xsrf 输入（与 chat.js 同口径），fetch 带 X-Xsrftoken 头。
 */
(function () {
    "use strict";

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function xsrfToken() {
        var hidden = document.querySelector('#xsrfBox input[name="_xsrf"]');
        if (hidden) return hidden.value;
        var m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : "";
    }

    function toast(text, isError) {
        var el = document.createElement("div");
        el.className = "user-toast" + (isError ? " is-error" : "");
        el.textContent = text;
        document.body.appendChild(el);
        setTimeout(function () { el.style.opacity = "0"; }, 1800);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2150);
    }

    async function api(path, opts) {
        var resp = await fetch(path, opts);
        if (resp.status === 401) { location.href = "/auth/login"; return null; }
        var data = await resp.json().catch(function () { return {}; });
        if (!resp.ok || data.ok === false) {
            toast(data.error || ("请求失败 " + resp.status), true);
            return null;
        }
        return data;
    }

    // 头像候选：全部为 FontAwesome 5 free 实图标，后端按 fas fa-xxx 白名单校验
    var AVATARS = ["", "fas fa-user", "fas fa-robot", "fas fa-user-astronaut", "fas fa-feather",
                   "fas fa-moon", "fas fa-sun", "fas fa-star", "fas fa-heart", "fas fa-cat", "fas fa-dog"];
    var pickedAvatar = "";

    function iconClass(raw) {
        var v = String(raw || "").trim();
        return /^fas fa-[a-z0-9-]+$/i.test(v) ? v : "fas fa-user";
    }

    function renderAvatarPicker() {
        $("avatarPicker").innerHTML = AVATARS.map(function (a) {
            var label = a ? '<i class="' + esc(a) + '"></i>' : '<i class="fas fa-ban"></i>';
            return '<button type="button" class="user-avatar-opt' +
                (a === pickedAvatar ? " is-active" : "") + '" data-avatar="' + esc(a) + '">' + label + "</button>";
        }).join("");
    }

    function paintProfile(p) {
        var display = p.nickname || p.username;
        $("profileName").textContent = display;
        $("avatarBig").className = p.avatar ? iconClass(p.avatar) : "fas fa-user-circle";
        $("nicknameInput").value = p.nickname || "";
        pickedAvatar = p.avatar || "";
        renderAvatarPicker();
        $("profileCreated").textContent = p.created_at || "—";
        $("profileLogin").textContent = p.last_login_at || "—";
        var st = p.stats || {};
        $("statMessages").textContent = st.messages || 0;
        $("statSessions").textContent = st.sessions || 0;
        $("statFaces").textContent = st.faces || 0;
    }

    async function loadProfile() {
        var d = await api("/api/user/profile");
        if (d) paintProfile(d.profile);
    }

    async function saveProfile() {
        var d = await api("/api/user/profile", {
            method: "POST",
            headers: { "X-Xsrftoken": xsrfToken(), "Content-Type": "application/json" },
            body: JSON.stringify({ nickname: $("nicknameInput").value.trim(), avatar: pickedAvatar }),
        });
        if (d) { paintProfile(d.profile); toast("资料已保存"); }
    }

    async function savePwd() {
        var oldV = $("oldPwd").value, newV = $("newPwd").value, newV2 = $("newPwd2").value;
        if (!oldV) { toast("请输入原密码", true); return; }
        if (newV.length < 6) { toast("新密码长度不能少于6位", true); return; }
        if (newV !== newV2) { toast("两次输入的新密码不一致", true); return; }
        var d = await api("/api/user/password", {
            method: "POST",
            headers: { "X-Xsrftoken": xsrfToken(), "Content-Type": "application/json" },
            body: JSON.stringify({ old_password: oldV, new_password: newV }),
        });
        if (d) {
            toast(d.message || "密码已修改");
            $("oldPwd").value = $("newPwd").value = $("newPwd2").value = "";
            loadSessions();
        }
    }

    async function loadSessions() {
        var d = await api("/api/user/sessions");
        if (!d) return;
        var rows = d.list || [];
        $("sessionBody").innerHTML = rows.length
            ? rows.map(function (s) {
                return "<tr><td>" + esc(s.client_ip) + "</td><td>" + esc(s.user_agent || "—") +
                    "</td><td>" + esc(s.created_at) + "</td><td>" + esc(s.last_seen_at) +
                    "</td><td>" + esc(s.expires_at) + "</td></tr>";
            }).join("")
            : '<tr><td colspan="5">暂无活跃会话</td></tr>';
    }

    function init() {
        $("avatarPicker").addEventListener("click", function (e) {
            var btn = e.target.closest("[data-avatar]");
            if (!btn) return;
            pickedAvatar = btn.getAttribute("data-avatar");
            renderAvatarPicker();
        });
        $("saveProfile").addEventListener("click", saveProfile);
        $("savePwd").addEventListener("click", savePwd);
        loadProfile();
        loadSessions();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
