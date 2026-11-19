/*
 * admin.js —— 后台管理前端逻辑（表现层，任务4）
 * 由 templates/admin/base.html 统一引入，负责：
 *   1. 框架壳交互：宽屏侧栏折叠 / 窄屏侧栏抽屉、顶栏下拉、退出登录（携带 xsrf 提交隐藏表单）
 *   2. 各模块（用户/角色/菜单/信源）的「功能区 | 列表区 | 分页区」真实数据驱动：
 *      列表/搜索/分页走 GET /api/admin/<模块>，增删改走 POST/DELETE 同名接口
 *   3. 所有请求带 X-Xsrftoken 头（值取自 base.html 的退出登录隐藏表单），与后端 xsrf_cookies=True 对齐
 * 约定：接口成功返回 {ok:true,...}，失败 {ok:false,error:"..."}；401 跳登录。
 * 表体由本文件按行渲染（模板只保留静态表头），符合「沿用静态表 + admin.js」的实现方式。
 */
(function () {
    "use strict";

    var PAGE_SIZE = 20;

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }

    // ---------- 全局壳（layui.use 里初始化） ----------
    // 与 admin.css 的 @media (max-width: 900px) 保持一致：窄屏侧栏移出可视区，靠抽屉唤出
    function isNarrow() {
        return window.matchMedia("(max-width: 900px)").matches;
    }

    function initShell(layer) {
        var layout = $("adminLayout");
        var SIDE_KEY = "cwnu_admin_side_collapsed";
        if (layout && !isNarrow()) {
            try {
                if (localStorage.getItem(SIDE_KEY) === "1") {
                    layout.classList.add("is-collapsed");
                }
            } catch (err) { /* ignore */ }
        }
        // 侧栏折叠：宽屏收掉常驻侧栏，窄屏展开抽屉（两套 class 互斥，避免 display:none 压住抽屉）
        var toggle = $("navToggle");
        if (layout && toggle) {
            toggle.addEventListener("click", function () {
                if (isNarrow()) {
                    layout.classList.remove("is-collapsed");
                    layout.classList.toggle("is-drawer");
                } else {
                    layout.classList.remove("is-drawer");
                    var collapsed = layout.classList.toggle("is-collapsed");
                    try { localStorage.setItem(SIDE_KEY, collapsed ? "1" : "0"); } catch (err) {}
                }
            });
            // 抽屉态下点内容区（遮罩落在 .layui-body 上）即收起，避免一直挡住操作
            layout.addEventListener("click", function (e) {
                if (!layout.classList.contains("is-drawer")) return;
                if (e.target.closest(".layui-side") || e.target.closest("#navToggle")) return;
                layout.classList.remove("is-drawer");
            });
        }
        // 拉宽窗口时清掉抽屉态，回到常驻侧栏
        window.addEventListener("resize", function () {
            if (layout && !isNarrow()) layout.classList.remove("is-drawer");
        });
        // 退出登录
        var logout = $("logoutLink");
        if (logout) {
            logout.addEventListener("click", function () { $("adminLogoutForm").submit(); });
        }
    }

    var layuiReady = false;
    var L = {}; // 缓存 layer/form/laypage

    // ---------- 请求封装 ----------
    function xsrf() {
        var f = $("adminLogoutForm");
        if (!f) return "";
        var i = f.querySelector('input[name="_xsrf"]');
        return i ? i.value : "";
    }

    function api(method, url, body) {
        var opt = {
            method: method,
            headers: { "Content-Type": "application/json", "X-Xsrftoken": xsrf() },
        };
        if (body !== undefined) opt.body = JSON.stringify(body);
        return fetch(url, opt).then(function (resp) {
            if (resp.status === 401) { location.href = "/auth/login"; return Promise.reject("unauth"); }
            return resp.json();
        }).then(function (data) {
            if (data && data.ok === false) {
                L.layer.msg(data.error || "操作失败", { icon: 2 });
                return Promise.reject(data);
            }
            return data;
        }).catch(function (e) {
            if (e && e !== "unauth" && !e.error) L.layer.msg("网络异常：" + e, { icon: 2 });
            return Promise.reject(e);
        });
    }

    // ---------- 分页渲染 ----------
    function renderPager(elemId, total, current, onJump) {
        L.laypage.render({
            elem: elemId,
            count: total,
            limit: PAGE_SIZE,
            curr: current,
            layout: ["count", "prev", "page", "next", "skip"],
            jump: function (obj, first) {
                if (!first) onJump(obj.curr);
            },
        });
    }

    // ---------- 通用：列表加载骨架 ----------
    function emptyRow(colspan, text) {
        return '<tr><td colspan="' + colspan + '" class="admin-empty">' + esc(text) + "</td></tr>";
    }

    // 下拉重渲染：layui 皮肤是静态副本，原生 select 的选项/值变化后必须重渲染才能同步；
    // 但重渲染不会回填标题栏文字与选中高亮，故按原生选中项补一次
    function renderSelect(ids) {
        if (L.form) L.form.render("select");
        (typeof ids === "string" ? [ids] : ids).forEach(function (id) {
            var el = $(id);
            if (!el) return;
            var skin = el.nextElementSibling;
            if (!skin || !skin.classList.contains("layui-form-select")) return;
            var opt = el.options[el.selectedIndex];
            var input = skin.querySelector(".layui-select-title input");
            if (input && opt) input.value = opt.textContent;
            Array.prototype.forEach.call(skin.querySelectorAll("dd"), function (dd) {
                dd.classList.toggle("layui-this", dd.getAttribute("lay-value") === el.value);
            });
        });
    }

    // 表单弹层：title + 内容 html + 保存回调（返回 false 阻止关闭）；width 可选，默认 460px
    function openForm(title, formHtml, onSave, width) {
        L.layer.open({
            type: 1,
            title: title,
            area: [width || "460px", "auto"],
            shadeClose: false,
            content: '<div class="layui-form" style="padding:18px 20px 4px;">' + formHtml + "</div>",
            btn: ["保存", "取消"],
            success: function () { L.form.render(); },
            yes: function (index, layero) {
                // layer 回调传入的 layero 是 jQuery 对象，没有原生 querySelector；
                // 归一为真实 DOM 节点再交给 onSave，否则读字段会抛 layero.querySelector is not a function
                var ok = onSave(toDom(layero), index);
                if (ok !== false) L.layer.close(index);
            },
        });
    }

    // 读取弹层内某 name 的值
    function field(layero, name) {
        var el = toDom(layero).querySelector('[name="' + name + '"]');
        return el ? el.value.trim() : "";
    }

    // layer 回调的 layero 可能是 jQuery 对象（无原生 querySelector），取其底层 DOM 节点；已是 DOM 则原样返回
    function toDom(layero) {
        if (!layero) return layero;
        if (layero.nodeType === 1) return layero;
        return layero.length != null ? layero[0] : layero;
    }

    // 删除确认
    function confirmDelete(text, onOk) {
        L.layer.confirm(text, { icon: 3, title: "操作确认" }, function (index) {
            L.layer.close(index);
            onOk();
        });
    }

    /* ============================================================
     * 用户管理
     * ============================================================ */
    var UserModule = {
        page: 1, keyword: "", roles: null,
        init: function () {
            var self = this;
            this.loadRoles().then(function () { self.load(1); });
            $("userSearch").addEventListener("click", function () { self.keyword = $("userKeyword").value.trim(); self.load(1); });
            $("userReset").addEventListener("click", function () { $("userKeyword").value = ""; self.keyword = ""; self.load(1); });
            $("userAdd").addEventListener("click", function () { self.openForm(null); });
            $("userBatchDelete").addEventListener("click", function () { self.batchDelete(); });
            $("userCheckAll").addEventListener("click", function () {
                var checked = this.checked;
                Array.prototype.forEach.call(document.querySelectorAll(".user-row-check"), function (c) { c.checked = checked; });
            });
            $("userBody").addEventListener("click", function (e) {
                var btn = e.target.closest("[data-act]");
                if (!btn) return;
                var id = btn.getAttribute("data-id");
                var act = btn.getAttribute("data-act");
                if (act === "edit") self.openForm(self.rowCache[id]);
                if (act === "del") self.del(id, btn.getAttribute("data-name"));
                if (act === "face") self.face(id);
            });
        },
        rowCache: {},
        loadRoles: function () {
            var self = this;
            return api("GET", "/api/admin/roles?all=1").then(function (d) { self.roles = d.list || []; });
        },
        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/users?page=" + this.page + "&keyword=" + encodeURIComponent(this.keyword);
            return api("GET", url).then(function (d) {
                $("userCount").textContent = d.total;
                self.rowCache = {};
                var rows = (d.list || []).map(function (u) {
                    self.rowCache[u.id] = u;
                    var tag = u.role === "admin" ? "layui-bg-orange" : "layui-bg-blue";
                    var faceTag = (u.face_count || 0) > 0
                        ? '<span class="admin-tag ' + (u.face_enabled ? "layui-bg-green" : "layui-bg-gray") + '">' +
                          (u.face_enabled ? "已开启 " : "已录入 ") + (u.face_count || 0) + "</span>"
                        : '<span class="admin-tag layui-bg-gray">未录入</span>';
                    return "<tr>" +
                        '<td><input type="checkbox" class="user-row-check" data-id="' + u.id + '"></td>' +
                        "<td>" + u.id + "</td>" +
                        "<td>" + esc(u.username) + "</td>" +
                        '<td><span class="admin-tag ' + tag + '">' + esc(u.role) + "</span></td>" +
                        "<td>" + faceTag + "</td>" +
                        "<td>" + esc(u.created_at) + "</td>" +
                        '<td class="admin-actions">' +
                        '<button class="layui-btn layui-btn-sm" data-act="edit" data-id="' + u.id + '"><i class="fas fa-edit"></i> 编辑</button>' +
                        '<button class="layui-btn layui-btn-primary layui-btn-sm" data-act="face" data-id="' + u.id + '"><i class="fas fa-camera"></i> 人脸</button>' +
                        '<button class="layui-btn layui-btn-danger layui-btn-sm" data-act="del" data-id="' + u.id + '" data-name="' + esc(u.username) + '"><i class="fas fa-trash-alt"></i> 删除</button>' +
                        "</td></tr>";
                });
                $("userBody").innerHTML = rows.length ? rows.join("") : emptyRow(7, "暂无用户数据");
                $("userCheckAll").checked = false;
                renderPager("userPager", d.total, self.page, function (p) { self.load(p); });
            });
        },
        roleOptions: function (selected) {
            var self = this;
            return (self.roles || []).map(function (r) {
                return '<option value="' + esc(r.code) + '"' + (r.code === selected ? " selected" : "") + ">" + esc(r.name) + "（" + esc(r.code) + "）</option>";
            }).join("");
        },
        openForm: function (row) {
            var self = this;
            var isEdit = !!row;
            var html =
                '<div class="layui-form-item"><label class="layui-form-label">用户名</label>' +
                '<div class="layui-input-block"><input type="text" name="username" class="layui-input" value="' + esc(row && row.username) + '"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">角色</label>' +
                '<div class="layui-input-block"><select name="role">' + self.roleOptions(row && row.role) + "</select></div></div>" +
                '<div class="layui-form-item"><label class="layui-form-label">密码</label>' +
                '<div class="layui-input-block"><input type="password" name="password" class="layui-input" placeholder="' +
                (isEdit ? "留空则不修改" : "不少于6位") + '">' +
                (isEdit ? "" : "") + "</div></div>";
            openForm(isEdit ? "编辑用户" : "新增用户", html, function (layero) {
                var payload = {
                    username: field(layero, "username"),
                    role: field(layero, "role"),
                    password: field(layero, "password"),
                };
                if (!payload.username) { L.layer.msg("用户名不能为空", { icon: 2 }); return false; }
                if (!isEdit && payload.password.length < 6) { L.layer.msg("密码不少于6位", { icon: 2 }); return false; }
                if (isEdit && payload.password === "") delete payload.password;
                var url = isEdit ? "/api/admin/users/" + row.id : "/api/admin/users";
                api("POST", url, payload).then(function () {
                    L.layer.msg("已保存", { icon: 1 });
                    self.load(self.page);
                });
            });
        },
        del: function (id, name) {
            var self = this;
            confirmDelete("确认删除用户「" + name + "」？", function () {
                api("DELETE", "/api/admin/users/" + id).then(function () { self.load(self.page); });
            });
        },
        batchDelete: function () {
            var self = this;
            var ids = Array.prototype.slice.call(document.querySelectorAll(".user-row-check:checked")).map(function (c) { return +c.getAttribute("data-id"); });
            if (!ids.length) { L.layer.msg("请先勾选要删除的用户", { icon: 0 }); return; }
            confirmDelete("确认批量删除选中的 " + ids.length + " 个用户？", function () {
                api("POST", "/api/admin/users/batch", { ids: ids }).then(function () { self.load(1); });
            });
        },
        // 任务12：人脸管理弹层（查看/代录/启停/删除该用户人脸）
        face: function (id) {
            var self = this;
            api("GET", "/api/admin/users/" + id + "/faces").then(function (d) {
                var tip = d.real
                    ? '<span class="admin-tag layui-bg-green">真实精度引擎 ' + esc(d.engine) + "（阈值 " + d.threshold + "）</span>"
                    : '<span class="admin-tag layui-bg-orange">人脸登录暂不可用：' + esc(d.reason || "未启用真实引擎") + "</span>";
                var lines = (d.faces || []).map(function (f) {
                    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed #eee">' +
                        '<span style="flex:1">#' + f.id + " · " + esc(f.face_label) + " · 质量 " +
                        Number(f.quality || 0).toFixed(2) + " · " +
                        (f.needs_reenrollment ? "需要重新录入" : (f.enabled ? "启用" : "停用")) + "</span>" +
                        '<button class="layui-btn layui-btn-xs layui-btn-primary" data-face-toggle="' + f.id +
                        '" data-enabled="' + (f.enabled ? 1 : 0) + '">' + (f.enabled ? "停用" : "启用") + "</button>" +
                        '<button class="layui-btn layui-btn-xs layui-btn-danger" data-face-del="' + f.id + '">删除</button>' +
                        "</div>";
                }).join("") || '<div class="admin-empty">该用户尚未录入人脸</div>';
                var html = '<div style="padding:16px 18px">' +
                    '<p style="margin-bottom:8px">' + tip + "</p>" +
                    '<p style="margin-bottom:10px">已录入 <b>' + (d.count || 0) + "</b> 张，人脸登录：<b>" +
                    (d.enabled ? "已开启" : "未开启") + "</b></p>" +
                    '<p style="color:#8a8a8a;font-size:12px;margin-bottom:8px">代录的图片只在服务端内存中提取特征，不保存原图。</p>' +
                    '<input type="file" id="faceFile" accept="image/*" style="margin-bottom:8px">' +
                    '<button class="layui-btn layui-btn-sm" id="faceUpload"><i class="fas fa-upload"></i> 录入这张人脸</button>' +
                    '<div style="margin-top:12px">' +
                    '<button type="button" class="layui-btn layui-btn-sm layui-btn-primary" id="faceCamera"><i class="fas fa-camera"></i> 打开摄像头</button>' +
                    '<button type="button" class="layui-btn layui-btn-sm layui-hide" id="faceCapture" disabled>拍照</button>' +
                    '<button type="button" class="layui-btn layui-btn-sm layui-hide" id="faceConfirm">确认录入</button>' +
                    '<p id="faceCameraHint" role="status" style="margin-top:8px"></p>' +
                    '<video id="faceVideo" autoplay muted playsinline hidden style="width:100%;max-height:240px"></video>' +
                    '<img id="facePhoto" alt="拍摄预览" hidden style="width:100%;max-height:240px;object-fit:contain">' +
                    '</div>' +
                    "<hr>" + lines + "</div>";
                var cameraStream = null;
                var closed = false;
                function stopCamera() {
                    if (!cameraStream) return;
                    cameraStream.getTracks().forEach(function (track) { track.stop(); });
                    cameraStream = null;
                }
                L.layer.open({
                    type: 1,
                    title: "人脸管理 · " + esc(d.username),
                    area: ["600px", "auto"],
                    shadeClose: true,
                    content: html,
                    end: function () {
                        closed = true;
                        stopCamera();
                    },
                    success: function (layero, index) {
                        var root = toDom(layero);
                        function refresh() {
                            if (closed || !root.isConnected) return;
                            L.layer.close(index);
                            self.face(id);
                        }
                        var fileInput = root.querySelector("#faceFile");
                        var upload = root.querySelector("#faceUpload");
                        var camera = root.querySelector("#faceCamera");
                        var capture = root.querySelector("#faceCapture");
                        var confirm = root.querySelector("#faceConfirm");
                        var hint = root.querySelector("#faceCameraHint");
                        var video = root.querySelector("#faceVideo");
                        var photo = root.querySelector("#facePhoto");
                        var shot = "";
                        var frames = null;
                        var submitting = false;

                        function enroll(payload) {
                            if (submitting || closed || !root.isConnected) return;
                            submitting = true;
                            upload.disabled = true;
                            confirm.disabled = true;
                            api("POST", "/api/admin/users/" + id + "/faces", Object.assign({ label: "admin" }, payload))
                                .then(function () {
                                    L.layer.msg("已录入", { icon: 1 });
                                    refresh();
                                }, function () {
                                    submitting = false;
                                    upload.disabled = false;
                                    confirm.disabled = false;
                                });
                        }

                        upload.addEventListener("click", function () {
                            var file = fileInput.files && fileInput.files[0];
                            if (!file) { L.layer.msg("请先选择一张图片", { icon: 0 }); return; }
                            var reader = new FileReader();
                            reader.onload = function () { enroll({ image: reader.result }); };
                            reader.onerror = function () { L.layer.msg("读取图片失败，请重新选择", { icon: 2 }); };
                            reader.readAsDataURL(file);
                        });

                        camera.addEventListener("click", async function () {
                            if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                                hint.textContent = "请通过 HTTPS 或本机地址打开页面，或选择图片录入。";
                                return;
                            }
                            camera.disabled = true;
                            confirm.classList.add("layui-hide");
                            hint.textContent = "请允许浏览器使用摄像头。";
                            try {
                                var stream = await navigator.mediaDevices.getUserMedia({
                                    video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 540 } },
                                    audio: false,
                                });
                                if (closed || !root.isConnected) {
                                    stream.getTracks().forEach(function (track) { track.stop(); });
                                    return;
                                }
                                cameraStream = stream;
                                video.srcObject = stream;
                                video.hidden = false;
                                await video.play();
                                if (closed || !root.isConnected) return;
                                shot = "";
                                frames = null;
                                photo.hidden = true;
                                photo.removeAttribute("src");
                                capture.classList.remove("layui-hide");
                                capture.disabled = false;
                                hint.textContent = "请让被录入的用户正对镜头，并确保画面中只有本人。";
                            } catch (err) {
                                stopCamera();
                                video.srcObject = null;
                                video.hidden = true;
                                capture.classList.add("layui-hide");
                                if (shot) confirm.classList.remove("layui-hide");
                                camera.disabled = false;
                                hint.textContent = err.name === "NotAllowedError"
                                    ? "摄像头权限未开启。请在浏览器中允许访问，或选择图片录入。"
                                    : "无法打开摄像头。请检查设备是否可用，或选择图片录入。";
                            }
                        });

                        capture.addEventListener("click", async function () {
                            if (!cameraStream || video.readyState < 2 || !video.videoWidth) {
                                hint.textContent = "摄像头画面正在加载，请稍后拍照。";
                                return;
                            }
                            capture.disabled = true;
                            hint.textContent = "正在采集，请保持正对镜头…";
                            try {
                                frames = await window.captureFaceFrames(video);
                            } catch (err) {
                                if (!closed) {
                                    hint.textContent = err.message;
                                    capture.disabled = false;
                                }
                                return;
                            }
                            if (closed || !root.isConnected) return;
                            shot = frames[1];
                            photo.src = shot;
                            photo.hidden = false;
                            confirm.classList.remove("layui-hide");
                            stopCamera();
                            video.srcObject = null;
                            video.hidden = true;
                            capture.classList.add("layui-hide");
                            capture.disabled = true;
                            camera.textContent = "重拍";
                            camera.disabled = false;
                            hint.textContent = "请检查照片，再确认录入。";
                        });
                        confirm.addEventListener("click", function () {
                            if (frames) enroll({ frames: frames });
                        });
                        Array.prototype.forEach.call(root.querySelectorAll("[data-face-del]"), function (btn) {
                            btn.addEventListener("click", function () {
                                var fid = btn.getAttribute("data-face-del");
                                api("DELETE", "/api/admin/users/" + id + "/faces/" + fid)
                                    .then(function () { refresh(); });
                            });
                        });
                        Array.prototype.forEach.call(root.querySelectorAll("[data-face-toggle]"), function (btn) {
                            btn.addEventListener("click", function () {
                                var fid = btn.getAttribute("data-face-toggle");
                                var enabled = btn.getAttribute("data-enabled") === "1" ? 0 : 1;
                                api("POST", "/api/admin/users/" + id + "/faces/" + fid, { enabled: enabled })
                                    .then(function () { refresh(); });
                            });
                        });
                    },
                });
            });
        },
    };

    /* ============================================================
     * 角色管理
     * ============================================================ */
    var RoleModule = {
        page: 1, keyword: "", rowCache: {},
        init: function () {
            var self = this;
            this.load(1);
            $("roleSearch").addEventListener("click", function () { self.keyword = $("roleKeyword").value.trim(); self.load(1); });
            $("roleReset").addEventListener("click", function () { $("roleKeyword").value = ""; self.keyword = ""; self.load(1); });
            $("roleAdd").addEventListener("click", function () { self.openForm(null); });
            $("roleBody").addEventListener("click", function (e) {
                var btn = e.target.closest("[data-act]");
                if (!btn) return;
                var id = btn.getAttribute("data-id");
                var act = btn.getAttribute("data-act");
                if (act === "edit") self.openForm(self.rowCache[id]);
                if (act === "del") self.del(id, btn.getAttribute("data-name"));
                if (act === "perm") self.openPerm(self.rowCache[id]);
            });
        },
        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/roles?page=" + this.page + "&keyword=" + encodeURIComponent(this.keyword);
            return api("GET", url).then(function (d) {
                $("roleCount").textContent = d.total;
                self.rowCache = {};
                var rows = (d.list || []).map(function (r) {
                    self.rowCache[r.id] = r;
                    var isAdmin = r.code === "admin";
                    var tag = isAdmin ? "layui-bg-orange" : "layui-bg-blue";
                    // 默认管理员角色：不可修改、不可删除、拥有全部权限（无需分配）
                    var editBtn = isAdmin
                        ? '<button class="layui-btn layui-btn-sm layui-btn-disabled" disabled><i class="fas fa-lock"></i> 不可修改</button>'
                        : '<button class="layui-btn layui-btn-sm" data-act="edit" data-id="' + r.id + '"><i class="fas fa-edit"></i> 编辑</button>';
                    var permBtn = isAdmin
                        ? '<button class="layui-btn layui-btn-primary layui-btn-sm layui-btn-disabled" disabled>全部权限</button>'
                        : '<button class="layui-btn layui-btn-normal layui-btn-sm" data-act="perm" data-id="' + r.id + '"><i class="fas fa-key"></i> 分配权限</button>';
                    var delBtn = isAdmin
                        ? '<button class="layui-btn layui-btn-sm layui-btn-disabled" disabled><i class="fas fa-lock"></i> 不可删除</button>'
                        : '<button class="layui-btn layui-btn-danger layui-btn-sm" data-act="del" data-id="' + r.id + '" data-name="' + esc(r.name) + '"><i class="fas fa-trash-alt"></i> 删除</button>';
                    return "<tr>" +
                        '<td><span class="admin-tag ' + tag + '">' + esc(r.code) + "</span></td>" +
                        "<td>" + esc(r.name) + "</td>" +
                        "<td>" + esc(r.description) + "</td>" +
                        '<td><a href="' + esc(r.home) + '">' + esc(r.home) + "</a></td>" +
                        "<td>" + (r.builtin ? '<span class="admin-tag layui-bg-gray">内置</span>' : '<span class="admin-tag">自定义</span>') + "</td>" +
                        '<td class="admin-actions">' + editBtn + permBtn + delBtn + "</td></tr>";
                });
                $("roleBody").innerHTML = rows.length ? rows.join("") : emptyRow(6, "暂无角色数据");
                renderPager("rolePager", d.total, self.page, function (p) { self.load(p); });
            });
        },
        openForm: function (row) {
            var self = this;
            var isEdit = !!row;
            var html =
                '<div class="layui-form-item"><label class="layui-form-label">角色编码</label>' +
                '<div class="layui-input-block"><input type="text" name="code" class="layui-input" ' +
                (isEdit ? "disabled" : "") + ' value="' + esc(row && row.code) + '" placeholder="如 editor"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">角色名称</label>' +
                '<div class="layui-input-block"><input type="text" name="name" class="layui-input" value="' + esc(row && row.name) + '"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">权限说明</label>' +
                '<div class="layui-input-block"><input type="text" name="description" class="layui-input" value="' + esc(row && row.description) + '"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">默认入口</label>' +
                '<div class="layui-input-block"><input type="text" name="home" class="layui-input" value="' + esc(row && row.home) + '" placeholder="/ 或 /admin"></div></div>';
            openForm(isEdit ? "编辑角色" : "新增角色", html, function (layero) {
                var name = field(layero, "name");
                var payload = {
                    name: name,
                    description: field(layero, "description"),
                    home: field(layero, "home") || "/",
                };
                if (!name) { L.layer.msg("角色名称不能为空", { icon: 2 }); return false; }
                if (isEdit) {
                    api("POST", "/api/admin/roles/" + row.id, payload).then(function () { L.layer.msg("已保存", { icon: 1 }); self.load(self.page); });
                } else {
                    payload.code = field(layero, "code");
                    if (!payload.code) { L.layer.msg("角色编码不能为空", { icon: 2 }); return false; }
                    api("POST", "/api/admin/roles", payload).then(function () { L.layer.msg("已保存", { icon: 1 }); self.load(1); });
                }
            });
        },
        del: function (id, name) {
            var self = this;
            confirmDelete("确认删除角色「" + name + "」？", function () {
                api("DELETE", "/api/admin/roles/" + id).then(function () { self.load(self.page); });
            });
        },
        permTreeHtml: function (nodes, assignedSet) {
            var self = this;
            return (nodes || []).map(function (n) {
                var kids = n.children || [];
                var cb = '<input type="checkbox" class="perm-cb" value="' + n.id + '"' + (assignedSet[n.id] ? " checked" : "") + ">";
                var html = '<div class="perm-node ' + (kids.length ? "perm-group" : "") + '"><label>' + cb +
                    ' <i class="' + esc(n.icon) + '"></i> ' + esc(n.name) + "</label></div>";
                if (kids.length) html += '<div class="perm-children">' + self.permTreeHtml(kids, assignedSet) + "</div>";
                return html;
            }).join("");
        },
        openPerm: function (row) {
            var self = this;
            api("GET", "/api/admin/roles/" + row.id + "/menus").then(function (d) {
                var assigned = {};
                (d.assigned || []).forEach(function (mid) { assigned[mid] = true; });
                var body = '<div class="admin-perm-tree"><div class="admin-tree-tip"><i class="fas fa-info-circle"></i> 勾选该角色可访问的后台菜单；保存后该角色的侧边栏与接口权限即时生效</div>' +
                    self.permTreeHtml(d.tree, assigned) + "</div>";
                L.layer.open({
                    type: 1,
                    title: "分配权限 · " + esc(row.name),
                    area: ["440px", "560px"],
                    shadeClose: false,
                    content: body,
                    btn: ["保存", "取消"],
                    yes: function (index, layero) {
                        var ids = Array.prototype.slice.call(toDom(layero).querySelectorAll(".perm-cb:checked")).map(function (c) { return +c.value; });
                        api("POST", "/api/admin/roles/" + row.id + "/menus", { menu_ids: ids }).then(function () {
                            L.layer.msg("权限已保存", { icon: 1 });
                            L.layer.close(index);
                        });
                    },
                });
            });
        },
    };

    /* ============================================================
     * 菜单管理
     * ============================================================ */
    var MenuModule = {
        page: 1, keyword: "", rowCache: {}, roots: [], tops: [], collapsed: {},
        _dragId: null, _drop: null,
        init: function () {
            var self = this;
            this.load(1);
            $("menuSearch").addEventListener("click", function () { self.keyword = $("menuKeyword").value.trim(); self.load(1); });
            $("menuReset").addEventListener("click", function () { $("menuKeyword").value = ""; self.keyword = ""; self.load(1); });
            $("menuAdd").addEventListener("click", function () { self.loadRoots().then(function () { self.openForm(null); }); });
            $("menuExpandAll").addEventListener("click", function () { self.toggleAll(); });
            $("menuBody").addEventListener("click", function (e) {
                var caret = e.target.closest(".menu-caret[data-toggle]");
                if (caret) { self.toggle(+caret.getAttribute("data-toggle")); return; }
                var btn = e.target.closest("[data-act]");
                if (!btn) return;
                var id = btn.getAttribute("data-id");
                var act = btn.getAttribute("data-act");
                if (act === "edit") self.loadRoots().then(function () { self.openForm(self.rowCache[id]); });
                if (act === "del") self.del(id, btn.getAttribute("data-name"));
            });
            this.bindDrag();
        },
        // ---------- 列表渲染：按顶级菜单分页，两级树（顶级 + children） ----------
        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/menus?page=" + this.page + "&keyword=" + encodeURIComponent(this.keyword);
            return api("GET", url).then(function (d) {
                $("menuCount").textContent = d.total;
                self.tops = d.list || [];
                self.renderRows();
                renderPager("menuPager", d.total, self.page, function (p) { self.load(p); });
            });
        },
        renderRows: function () {
            var self = this;
            self.rowCache = {};
            var html = [];
            (self.tops || []).forEach(function (top) {
                html.push(self.rowHtml(top, 1, 0));
                (top.children || []).forEach(function (c) { html.push(self.rowHtml(c, 2, +top.id)); });
            });
            $("menuBody").innerHTML = html.length ? html.join("") : emptyRow(6, "暂无菜单数据");
        },
        rowHtml: function (m, level, parentId) {
            this.rowCache[m.id] = m;
            var kids = (level === 1 && m.children) ? m.children : [];
            var hidden = level === 2 && this.collapsed[parentId] ? " is-hidden" : "";
            var indent = level === 2 ? '<span class="menu-indent"></span>' : "";
            var caret = kids.length
                ? '<span class="menu-caret" data-toggle="' + m.id + '"><i class="fas fa-caret-' + (this.collapsed[m.id] ? "right" : "down") + '"></i></span>'
                : '<span class="menu-caret"></span>';
            var iconCell = m.icon ? '<i class="menu-img ' + esc(m.icon) + '"></i>' : '<span class="menu-row-empty">—</span>';
            var status = m.enabled ? '<span class="admin-tag layui-bg-green">启用</span>' : '<span class="admin-tag layui-bg-gray">停用</span>';
            return '<tr class="' + hidden.trim() + '" draggable="true" data-id="' + m.id + '" data-level="' + level + '" data-parent="' + parentId + '">' +
                "<td>" + iconCell + "</td>" +
                '<td><div class="menu-node">' + indent + caret + '<span class="menu-name">' + esc(m.name) + "</span></div></td>" +
                "<td>" + esc(m.url || "-") + "</td>" +
                "<td>" + esc(m.description || "-") + "</td>" +
                "<td>" + status + "</td>" +
                '<td class="admin-actions">' +
                '<button class="layui-btn layui-btn-sm" data-act="edit" data-id="' + m.id + '"><i class="fas fa-edit"></i> 编辑</button>' +
                '<button class="layui-btn layui-btn-danger layui-btn-sm" data-act="del" data-id="' + m.id + '" data-name="' + esc(m.name) + '"><i class="fas fa-trash-alt"></i> 删除</button>' +
                "</td></tr>";
        },
        toggle: function (id) {
            this.collapsed[id] = !this.collapsed[id];
            this.renderRows();
        },
        toggleAll: function () {
            var self = this;
            var anyOpen = (this.tops || []).some(function (t) { return (t.children || []).length && !self.collapsed[t.id]; });
            (this.tops || []).forEach(function (t) { if ((t.children || []).length) self.collapsed[t.id] = anyOpen; });
            this.renderRows();
        },
        // ---------- 拖拽排序：HTML5 DnD，松手批量保存层级/顺序 ----------
        bindDrag: function () {
            var self = this, body = $("menuBody");
            body.addEventListener("dragstart", function (e) {
                var row = e.target.closest("tr[data-id]");
                if (!row) { return; }
                self._dragId = row.getAttribute("data-id");
                row.classList.add("is-dragging");
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = "move";
                    try { e.dataTransfer.setData("text/plain", self._dragId); } catch (_e) {}
                }
            });
            body.addEventListener("dragover", function (e) {
                var row = e.target.closest("tr[data-id]");
                if (!row || !self._dragId) { return; }
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                self.clearMarks(body);
                var pos = self.computePos(e, row);
                row.classList.add("drop-" + pos);
                self._drop = { id: row.getAttribute("data-id"), pos: pos };
            });
            body.addEventListener("drop", function (e) {
                e.preventDefault();
                if (!self._dragId || !self._drop) { self.cleanupDrag(body); return; }
                self.move(self._dragId, self._drop.id, self._drop.pos);
                self.cleanupDrag(body);
            });
            body.addEventListener("dragend", function () { self.cleanupDrag(body); });
        },
        computePos: function (e, row) {
            var rect = row.getBoundingClientRect();
            var offset = e.clientY - rect.top;
            var level = +row.getAttribute("data-level");
            if (level === 1 && offset >= rect.height / 3 && offset <= rect.height * 2 / 3) return "inside";
            return offset < rect.height / 2 ? "before" : "after";
        },
        clearMarks: function (body) {
            Array.prototype.forEach.call(body.querySelectorAll("tr.drop-before,tr.drop-after,tr.drop-inside"), function (r) {
                r.classList.remove("drop-before", "drop-after", "drop-inside");
            });
        },
        cleanupDrag: function (body) {
            var r = body.querySelector("tr.is-dragging"); if (r) r.classList.remove("is-dragging");
            this.clearMarks(body); this._dragId = null; this._drop = null;
        },
        findNode: function (id) {
            id = +id;
            for (var i = 0; i < this.tops.length; i++) {
                if (+this.tops[i].id === id) return { node: this.tops[i], container: this.tops, index: i, parent: 0 };
                var kids = this.tops[i].children || [];
                for (var j = 0; j < kids.length; j++) {
                    if (+kids[j].id === id) return { node: kids[j], container: kids, index: j, parent: +this.tops[i].id };
                }
            }
            return null;
        },
        move: function (dragId, targetId, pos) {
            dragId = +dragId; targetId = +targetId;
            if (dragId === targetId) return;
            var d = this.findNode(dragId), t = this.findNode(targetId);
            if (!d || !t) return;
            // 仅两级：带子菜单的顶级菜单不允许被拖成子级（否则三级导航无法呈现）
            var topWithKids = d.parent === 0 && (d.node.children || []).length;
            if (topWithKids && (pos === "inside" || t.parent !== 0)) {
                L.layer.msg("含子菜单的顶级菜单不能拖入其它菜单下", { icon: 0 }); return;
            }
            d.container.splice(d.index, 1);
            if (pos === "inside") {
                var tp = this.findNode(targetId);
                var targetNode = tp ? tp.node : t.node;
                targetNode.children = targetNode.children || [];
                targetNode.children.push(d.node);
            } else {
                var re = this.findNode(targetId);
                var container = re ? re.container : this.tops;
                var idx = re ? (re.index + (pos === "after" ? 1 : 0)) : container.length;
                container.splice(idx, 0, d.node);
            }
            this.collapsed = {}; // 移动后展开，避免被拖入收起分组的节点看不见
            this.renderRows();
            this.persist(this.collectItems());
        },
        collectItems: function () {
            var items = [];
            (this.tops || []).forEach(function (top, i) {
                top.parent_id = 0; top.level = 1;
                items.push({ id: top.id, parent_id: 0, sort: i });
                (top.children || []).forEach(function (c, ci) {
                    c.parent_id = +top.id; c.level = 2;
                    items.push({ id: c.id, parent_id: +top.id, sort: ci });
                });
            });
            return items;
        },
        persist: function (items) {
            var self = this;
            api("POST", "/api/admin/menus/sort", { items: items }).then(function (d) {
                L.layer.msg("排序已保存" + (d && d.saved ? "（" + d.saved + " 项）" : ""), { icon: 1 });
                self.load(self.page);
            }, function () { self.load(self.page); });
        },
        loadRoots: function () {
            var self = this;
            return api("GET", "/api/admin/menus?roots=1").then(function (d) { self.roots = d.list || []; });
        },
        parentOptions: function (selected) {
            var html = '<option value="0"' + (!selected || +selected === 0 ? " selected" : "") + ">（顶级菜单）</option>";
            html += (this.roots || []).map(function (m) {
                return '<option value="' + m.id + '"' + (String(m.id) === String(selected) ? " selected" : "") + ">" + esc(m.name) + "</option>";
            }).join("");
            return html;
        },
        openForm: function (row) {
            var self = this;
            var isEdit = !!row;
            var html =
                '<div class="layui-form-item"><label class="layui-form-label">上级菜单</label>' +
                '<div class="layui-input-block"><select name="parent_id">' + self.parentOptions(row && row.parent_id) + "</select></div></div>" +
                '<div class="layui-form-item"><label class="layui-form-label">菜单名称</label>' +
                '<div class="layui-input-block"><input type="text" name="name" class="layui-input" value="' + esc(row && row.name) + '"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">图标</label>' +
                '<div class="layui-input-block"><input type="text" name="icon" class="layui-input" value="' + esc(row && row.icon) + '" placeholder="如 fas fa-users"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">路由地址</label>' +
                '<div class="layui-input-block"><input type="text" name="url" class="layui-input" value="' + esc(row && row.url) + '" placeholder="如 /admin/users"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">简介</label>' +
                '<div class="layui-input-block"><input type="text" name="description" class="layui-input" value="' + esc(row && row.description) + '" placeholder="菜单用途说明"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">排序</label>' +
                '<div class="layui-input-block"><input type="number" name="sort" class="layui-input" value="' + esc(row ? row.sort : 0) + '"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">状态</label>' +
                '<div class="layui-input-block"><input type="checkbox" name="enabled" lay-skin="switch" lay-text="启用|停用"' + (isEdit && !row.enabled ? "" : " checked") + "></div></div>";
            openForm(isEdit ? "编辑菜单" : "新增菜单", html, function (layero) {
                var name = field(layero, "name");
                if (!name) { L.layer.msg("菜单名称不能为空", { icon: 2 }); return false; }
                var enabledEl = layero.querySelector('[name="enabled"]');
                var payload = {
                    parent_id: field(layero, "parent_id") || "0",
                    name: name,
                    icon: field(layero, "icon"),
                    url: field(layero, "url"),
                    description: field(layero, "description"),
                    sort: field(layero, "sort") || "0",
                    enabled: enabledEl && enabledEl.checked ? 1 : 0,
                };
                var url = isEdit ? "/api/admin/menus/" + row.id : "/api/admin/menus";
                api("POST", url, payload).then(function () {
                    L.layer.msg("已保存，侧边导航将在下次进入生效", { icon: 1 });
                    self.load(isEdit ? self.page : 1);
                });
            });
        },
        del: function (id, name) {
            var self = this;
            confirmDelete("确认删除菜单「" + name + "」？（含子菜单需先删除子菜单）", function () {
                api("DELETE", "/api/admin/menus/" + id).then(function () { self.load(self.page); });
            });
        },
    };

    /* ============================================================
     * 信源管理（任务5）
     * ============================================================ */
    var SourceModule = {
        page: 1, keyword: "", rowCache: {},
        init: function () {
            var self = this;
            this.load(1);
            $("sourceSearch").addEventListener("click", function () { self.keyword = $("sourceKeyword").value.trim(); self.load(1); });
            $("sourceReset").addEventListener("click", function () { $("sourceKeyword").value = ""; self.keyword = ""; self.load(1); });
            $("sourceAdd").addEventListener("click", function () { self.openForm(null); });
            $("sourceBody").addEventListener("click", function (e) {
                var btn = e.target.closest("[data-act]");
                if (!btn) return;
                var id = btn.getAttribute("data-id");
                var act = btn.getAttribute("data-act");
                if (act === "edit") self.openForm(self.rowCache[id]);
                if (act === "del") self.del(id, btn.getAttribute("data-name"));
                if (act === "headers") self.viewHeaders(self.rowCache[id]);
            });
        },
        // headers 入库为 JSON 字符串，解析失败按空对象处理
        parseHeaders: function (row) {
            try { return JSON.parse(row && row.headers || "{}") || {}; } catch (_e) { return {}; }
        },
        // 编辑回填：把 JSON 还原成每行「Name: Value」的 RAW 文本，保存时后端重新解析
        headersToRaw: function (headers) {
            return Object.keys(headers).map(function (k) { return k + ": " + headers[k]; }).join("\n");
        },
        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/sources?page=" + this.page + "&keyword=" + encodeURIComponent(this.keyword);
            return api("GET", url).then(function (d) {
                $("sourceCount").textContent = d.total;
                self.rowCache = {};
                var rows = (d.list || []).map(function (s) {
                    self.rowCache[s.id] = s;
                    var count = Object.keys(self.parseHeaders(s)).length;
                    var headerCell = count
                        ? '<span class="admin-tag layui-bg-blue">' + count + " 项</span>"
                        : '<span class="admin-tag layui-bg-gray">未配置</span>';
                    var status = s.enabled ? '<span class="admin-tag layui-bg-green">启用</span>' : '<span class="admin-tag layui-bg-gray">停用</span>';
                    return "<tr>" +
                        "<td>" + esc(s.name) + "</td>" +
                        '<td><div class="source-url" title="' + esc(s.url) + '">' + esc(s.url) + "</div></td>" +
                        "<td>" + headerCell + "</td>" +
                        "<td>" + esc(s.description || "-") + "</td>" +
                        "<td>" + status + "</td>" +
                        '<td class="admin-actions">' +
                        '<button class="layui-btn layui-btn-primary layui-btn-sm" data-act="headers" data-id="' + s.id + '"><i class="fas fa-eye"></i> 请求头</button>' +
                        '<button class="layui-btn layui-btn-sm" data-act="edit" data-id="' + s.id + '"><i class="fas fa-edit"></i> 编辑</button>' +
                        '<button class="layui-btn layui-btn-danger layui-btn-sm" data-act="del" data-id="' + s.id + '" data-name="' + esc(s.name) + '"><i class="fas fa-trash-alt"></i> 删除</button>' +
                        "</td></tr>";
                });
                $("sourceBody").innerHTML = rows.length ? rows.join("") : emptyRow(6, "暂无信源数据");
                renderPager("sourcePager", d.total, self.page, function (p) { self.load(p); });
            });
        },
        viewHeaders: function (row) {
            var headers = this.parseHeaders(row);
            var text = this.headersToRaw(headers) || "（未配置 Request Headers）";
            L.layer.open({
                type: 1,
                title: "请求头 · " + esc(row.name),
                area: ["620px", "480px"],
                shadeClose: true,
                content: '<pre class="source-headers-view">' + esc(text) + "</pre>",
                btn: ["关闭"],
                yes: function (index) { L.layer.close(index); },
            });
        },
        openForm: function (row) {
            var self = this;
            var isEdit = !!row;
            var rawValue = isEdit ? self.headersToRaw(self.parseHeaders(row)) : "";
            var html =
                '<div class="layui-form-item"><label class="layui-form-label">信源名称</label>' +
                '<div class="layui-input-block"><input type="text" name="name" class="layui-input" value="' + esc(row && row.name) + '" placeholder="如 百度资讯搜索"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">URL 规格</label>' +
                '<div class="layui-input-block"><textarea name="url" class="layui-textarea" rows="3" placeholder="https://… 可含 {关键字} / {分页} 等占位符">' + esc(row && row.url) + '</textarea></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">请求头 RAW</label>' +
                '<div class="layui-input-block"><textarea name="headers_raw" class="layui-textarea source-raw" rows="8" placeholder="支持直接粘贴浏览器 DevTools 的 RAW（名称行/值行交替），或每行 Name: Value；留空则不配置">' + esc(rawValue) + '</textarea>' +
                '<div class="source-raw-tip"><i class="fas fa-info-circle"></i> 保存时自动解析为键值对入库，供后续采集管理模块作为采集源使用</div></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">简介</label>' +
                '<div class="layui-input-block"><input type="text" name="description" class="layui-input" value="' + esc(row && row.description) + '" placeholder="信源用途说明"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">状态</label>' +
                '<div class="layui-input-block"><input type="checkbox" name="enabled" lay-skin="switch" lay-text="启用|停用"' + (isEdit && !row.enabled ? "" : " checked") + "></div></div>";
            openForm(isEdit ? "编辑信源" : "新增信源", html, function (layero) {
                var name = field(layero, "name");
                var url = field(layero, "url");
                if (!name) { L.layer.msg("信源名称不能为空", { icon: 2 }); return false; }
                if (!/^https?:\/\//.test(url)) { L.layer.msg("URL 规格须以 http:// 或 https:// 开头", { icon: 2 }); return false; }
                var enabledEl = layero.querySelector('[name="enabled"]');
                var payload = {
                    name: name,
                    url: url,
                    headers_raw: field(layero, "headers_raw"),
                    description: field(layero, "description"),
                    enabled: enabledEl && enabledEl.checked ? 1 : 0,
                };
                var apiUrl = isEdit ? "/api/admin/sources/" + row.id : "/api/admin/sources";
                api("POST", apiUrl, payload).then(function () {
                    L.layer.msg("已保存", { icon: 1 });
                    self.load(isEdit ? self.page : 1);
                });
            }, "640px");
        },
        del: function (id, name) {
            var self = this;
            confirmDelete("确认删除信源「" + name + "」？", function () {
                api("DELETE", "/api/admin/sources/" + id).then(function () { self.load(self.page); });
            });
        },
    };

    /* ============================================================
     * 数据仓库（任务7）：深采正文仓库 CRUD(20/页) + 单一/批量深采 SSE 执行面板
     * ============================================================ */
    var WarehouseModule = {
        page: 1, keyword: "", sourceId: "", status: "", rowCache: {}, es: null,
        init: function () {
            var self = this;
            this.loadSources().then(function () { self.load(1); });
            $("whSearch").addEventListener("click", function () {
                self.keyword = $("whKeyword").value.trim();
                self.sourceId = $("whSourceFilter").value;
                self.status = $("whStatusFilter").value;
                self.load(1);
            });
            // 信源/状态下拉切换即刷新（layui 渲染后的下拉不点「搜索」也应生效）
            this.bindFilter("whSourceFilter", "sourceId", "whSource");
            this.bindFilter("whStatusFilter", "status", "whStatus");
            $("whReset").addEventListener("click", function () {
                $("whKeyword").value = ""; $("whSourceFilter").value = ""; $("whStatusFilter").value = "";
                self.keyword = ""; self.sourceId = ""; self.status = "";
                // 原生 select 已重置，需重渲染才能回显「全部」（标题栏文字一并回填）
                renderSelect(["whSourceFilter", "whStatusFilter"]);
                self.load(1);
            });
            $("whBatchDelete").addEventListener("click", function () { self.batchDelete(); });
            $("whBatchDeep").addEventListener("click", function () { self.openBatchDeep(); });
            $("whCheckAll").addEventListener("click", function () {
                var checked = this.checked;
                Array.prototype.forEach.call(document.querySelectorAll(".wh-row-check"), function (c) { c.checked = checked; });
            });
            $("whBody").addEventListener("click", function (e) {
                var btn = e.target.closest("[data-act]");
                if (!btn) return;
                var id = btn.getAttribute("data-id");
                var act = btn.getAttribute("data-act");
                if (act === "view") self.openView(id);
                if (act === "edit") self.openForm(self.rowCache[id]);
                if (act === "del") self.del(id, btn.getAttribute("data-name"));
                if (act === "deep") self.deepOne(self.rowCache[id]);
                if (act === "redo") self.deepOne(self.rowCache[id], true);
            });
        },
        loadSources: function () {
            var self = this;
            return api("GET", "/api/admin/warehouse/sources").then(function (d) {
                var sel = $("whSourceFilter");
                (d.list || []).forEach(function (s) {
                    var op = document.createElement("option");
                    op.value = s.id; op.textContent = s.name;
                    sel.appendChild(op);
                });
                // 选项是异步填的，而 layui 早已渲染过静态副本，不重渲染则下拉里看不到信源；
                // 状态下拉一并回填标题栏，避免首屏显示空白
                renderSelect(["whSourceFilter", "whStatusFilter"]);
            });
        },
        bindFilter: function (selectId, field, filter) {
            // 双保险：layui 的 select 事件（官方）为主，原生 change（未渲染时）兜底；
            // 用 field 旧值去重，避免两个通道都触发时重复请求
            var self = this;
            function apply(value) {
                if (self[field] === value) return;
                self[field] = value;
                self.load(1);
            }
            var el = $(selectId);
            el.addEventListener("change", function () { apply(this.value); });
            if (L.form) {
                L.form.on("select(" + filter + ")", function (data) { apply(data.value); });
            }
        },
        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/warehouse?page=" + this.page
                + "&keyword=" + encodeURIComponent(this.keyword)
                + "&source_id=" + encodeURIComponent(this.sourceId)
                + "&status=" + encodeURIComponent(this.status);
            return api("GET", url).then(function (d) {
                $("whCount").textContent = d.total;
                self.rowCache = {};
                var rows = (d.list || []).map(function (r) {
                    self.rowCache[r.id] = r;
                    var st = r.status === 2
                        ? '<span class="admin-tag layui-bg-green">深采成功</span>'
                        : (r.status === 1 ? '<span class="admin-tag layui-bg-red">深采失败</span>'
                            : '<span class="admin-tag layui-bg-gray">未深采</span>');
                    var deepBtn = r.status === 2
                        ? '<button class="layui-btn layui-btn-primary layui-btn-sm" data-act="redo" data-id="' + r.id + '"><i class="fas fa-redo"></i> 重采</button>'
                        : '<button class="layui-btn layui-btn-normal layui-btn-sm" data-act="deep" data-id="' + r.id + '"><i class="fas fa-rocket"></i> 深采</button>';
                    return "<tr>" +
                        '<td><input type="checkbox" class="wh-row-check" data-id="' + r.id + '"></td>' +
                        '<td><div class="wh-title" title="' + esc(r.title) + '">' + esc(r.title) + "</div></td>" +
                        "<td>" + esc(r.source_name || "-") + "</td>" +
                        "<td>" + esc(r.keyword || "-") + "</td>" +
                        "<td>" + (r.word_count || 0) + "</td>" +
                        "<td>" + st + "</td>" +
                        "<td>" + esc(r.updated_at || "") + "</td>" +
                        '<td class="admin-actions">' +
                        '<button class="layui-btn layui-btn-primary layui-btn-sm" data-act="view" data-id="' + r.id + '"><i class="fas fa-eye"></i> 查看</button>' +
                        deepBtn +
                        '<button class="layui-btn layui-btn-sm" data-act="edit" data-id="' + r.id + '"><i class="fas fa-edit"></i> 编辑</button>' +
                        '<button class="layui-btn layui-btn-danger layui-btn-sm" data-act="del" data-id="' + r.id + '" data-name="' + esc(r.title) + '"><i class="fas fa-trash-alt"></i> 删除</button>' +
                        "</td></tr>";
                });
                $("whBody").innerHTML = rows.length ? rows.join("") : emptyRow(8, "暂无数据仓库记录，可在采集管理采集数据后执行深度采集");
                $("whCheckAll").checked = false;
                renderPager("whPager", d.total, self.page, function (p) { self.load(p); });
            });
        },
        openForm: function (row) {
            var self = this;
            if (!row) return;
            var html =
                '<div class="layui-form-item"><label class="layui-form-label">标题</label>' +
                '<div class="layui-input-block"><input type="text" name="title" class="layui-input" value="' + esc(row.title) + '"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">关键词</label>' +
                '<div class="layui-input-block"><input type="text" name="keyword" class="layui-input" value="' + esc(row.keyword) + '"></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">AI 摘要</label>' +
                '<div class="layui-input-block"><textarea name="ai_summary" class="layui-textarea" rows="4" placeholder="深度采集后由 AI 模型引擎生成，可人工修订">' + esc(row.ai_summary) + '</textarea></div></div>';
            openForm("编辑数仓记录", html, function (layero) {
                var payload = {
                    title: field(layero, "title"),
                    keyword: field(layero, "keyword"),
                    ai_summary: field(layero, "ai_summary"),
                };
                if (!payload.title) { L.layer.msg("标题不能为空", { icon: 2 }); return false; }
                api("POST", "/api/admin/warehouse/" + row.id, payload).then(function () {
                    L.layer.msg("已保存", { icon: 1 });
                    self.load(self.page);
                });
            }, "560px");
        },
        openView: function (id) {
            var self = this;
            api("GET", "/api/admin/warehouse/" + id + "/detail").then(function (d) {
                var r = d.data || {};
                var kws = (r.ai_keywords || []).map(function (k) {
                    return '<span class="admin-tag layui-bg-blue">' + esc(k) + "</span>";
                }).join(" ");
                var imgs = (r.images || []).slice(0, 8).map(function (u) {
                    return '<img class="wh-view-img" src="' + esc(u) + '" alt="正文图片" onerror="this.style.display=\'none\'">';
                }).join("");
                var body =
                    '<div class="wh-view">' +
                    '<div class="wh-view-meta">' +
                    '<span><i class="fas fa-rss"></i> ' + esc(r.source_name || "-") + "</span>" +
                    '<span><i class="fas fa-key"></i> ' + esc(r.keyword || "-") + "</span>" +
                    '<span><i class="fas fa-text-length"></i> ' + (r.word_count || 0) + " 字</span>" +
                    '<span><i class="fas fa-cube"></i> 引擎 ' + esc(r.engine || "-") + (r.llm_used ? " + AI" : " + 规则") + "</span>" +
                    "</div>" +
                    (r.url ? '<div class="wh-view-url">原文链接：<a href="' + esc(r.url) + '" target="_blank">' + esc(r.url) + "</a></div>" : "") +
                    (r.ai_summary ? '<div class="wh-view-block"><b>AI 摘要</b><p>' + esc(r.ai_summary) + "</p></div>" : "") +
                    (kws ? '<div class="wh-view-block"><b>关键词</b><div>' + kws + "</div></div>" : "") +
                    (r.error ? '<div class="wh-view-block wh-view-error"><b>错误</b><p>' + esc(r.error) + "</p></div>" : "") +
                    '<div class="wh-view-block"><b>详细正文</b><pre class="wh-view-content">' + esc(r.content_text || "（暂无正文，请先深度采集）") + "</pre></div>" +
                    (imgs ? '<div class="wh-view-block"><b>正文图片</b><div class="wh-view-imgs">' + imgs + "</div></div>" : "") +
                    "</div>";
                L.layer.open({
                    type: 1, title: "查看 · " + esc(r.title || ""),
                    area: ["760px", "620px"], shadeClose: true,
                    content: body, btn: ["重新深采", "关闭"],
                    yes: function (index) { L.layer.close(index); self.deepOne(r, true); },
                    btn2: function (index) { L.layer.close(index); },
                });
            });
        },
        del: function (id, name) {
            var self = this;
            confirmDelete("确认删除该数仓记录「" + name + "」？", function () {
                api("DELETE", "/api/admin/warehouse/" + id).then(function () { self.load(self.page); });
            });
        },
        batchDelete: function () {
            var self = this;
            var ids = Array.prototype.slice.call(document.querySelectorAll(".wh-row-check:checked")).map(function (c) { return +c.getAttribute("data-id"); });
            if (!ids.length) { L.layer.msg("请先勾选要删除的记录", { icon: 0 }); return; }
            confirmDelete("确认批量删除选中的 " + ids.length + " 条记录？", function () {
                api("POST", "/api/admin/warehouse/batch", { ids: ids }).then(function () { self.load(1); });
            });
        },

        // ---------- 深度采集（单一 / 批量，SSE 执行面板） ----------
        deepOne: function (row, redo) {
            var self = this;
            // 数仓记录回查原数据 id；已成功的重采也走同一入口（UPSERT 覆盖）
            var itemId = row.collect_item_id;
            if (!itemId) { L.layer.msg("该记录缺少原数据关联，无法深采", { icon: 2 }); return; }
            this.openPanel("单一深度采集", { item_id: itemId, use_ai: true, use_crawl4ai: true }, function () {
                self.load(self.page);
            });
        },
        openBatchDeep: function () {
            var self = this;
            var checked = Array.prototype.slice.call(document.querySelectorAll(".wh-row-check:checked"))
                .map(function (c) { return +c.getAttribute("data-id"); });
            var rowIds = checked.length ? checked.map(function (i) { return self.rowCache[i]; }) : [];
            var ids = rowIds.map(function (r) { return r && r.collect_item_id; }).filter(Boolean);
            var note = checked.length
                ? "已勾选本页 " + ids.length + " 条数仓记录对应的原数据，将逐条重新深采。"
                : "未勾选记录：默认对「采集管理」中符合条件（当前搜索/信源过滤）且尚未成功深采的原数据批量深采，单次最多 50 条。";
            var html =
                '<div class="wh-deep-form">' +
                '<p class="wh-deep-note"><i class="fas fa-info-circle"></i> ' + note + "</p>" +
                '<div class="layui-form-item"><label class="layui-form-label">AI 模型引擎</label>' +
                '<div class="layui-input-block"><input type="checkbox" name="use_ai" lay-skin="switch" lay-text="开启|关闭" checked>' +
                '<div class="wh-deep-tip">关闭后仅用规则摘要（不调用模型引擎管理默认模型）</div></div></div>' +
                '<div class="layui-form-item"><label class="layui-form-label">Crawl4AI</label>' +
                '<div class="layui-input-block"><input type="checkbox" name="use_c4a" lay-skin="switch" lay-text="开启|关闭" checked>' +
                '<div class="wh-deep-tip">关闭或内核缺失时自动回退 requests + 启发式正文抽取</div></div></div>' +
                "</div>";
            openForm("批量深度采集", html, function (layero) {
                var aiEl = toDom(layero).querySelector('[name="use_ai"]');
                var c4aEl = toDom(layero).querySelector('[name="use_c4a"]');
                var params = {
                    use_ai: !(aiEl && !aiEl.checked),
                    use_crawl4ai: !(c4aEl && !c4aEl.checked),
                };
                if (ids.length) { params.ids = ids; }
                else {
                    params.all_pending = 1;
                    if (self.keyword) params.keyword = self.keyword;
                    if (self.sourceId) params.source_id = self.sourceId;
                }
                self.openPanel("批量深度采集", params, function () { self.load(1); });
                return true;
            }, "520px");
        },
        openPanel: function (title, params, onDone) {
            var self = this;
            if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; }
            var html =
                '<div class="wh-panel">' +
                '<div class="wh-panel-bar"><div class="wh-panel-progress"><div class="wh-panel-progress-inner" id="whProgBar"></div></div>' +
                '<span class="wh-panel-percent" id="whProgPct">0%</span></div>' +
                '<div class="wh-panel-status" id="whPanelStatus"><i class="fas fa-satellite-dish"></i> 正在连接采集通道…</div>' +
                '<pre class="wh-panel-log" id="whPanelLog"></pre>' +
                '<div class="wh-panel-result" id="whPanelResult"></div>' +
                "</div>";
            L.layer.open({
                type: 1, title: title + " · 执行面板",
                area: ["720px", "560px"], shadeClose: false, closeBtn: 1,
                content: html,
                end: function () { if (self.es) { try { self.es.close(); } catch (e) {} self.es = null; } },
                success: function () { self.connectPanel(params, onDone); },
            });
        },
        connectPanel: function (params, onDone) {
            var self = this;
            var log = $("whPanelLog"), status = $("whPanelStatus");
            var bar = $("whProgBar"), pct = $("whProgPct"), result = $("whPanelResult");
            var stamp = function () {
                var d = new Date();
                return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
            };
            var append = function (text, cls) {
                log.innerHTML += '<div class="wh-log-line ' + (cls || "") + '"><span class="wh-log-time">' + stamp() + "</span> " + esc(text) + "</div>";
                log.scrollTop = log.scrollHeight;
            };
            var setProg = function (p) {
                bar.style.width = Math.max(0, Math.min(100, p)) + "%";
                pct.textContent = Math.round(p) + "%";
            };
            var finish = function (ok) {
                status.innerHTML = ok
                    ? '<i class="fas fa-check-circle"></i> 采集完成'
                    : '<i class="fas fa-exclamation-circle"></i> 采集中断';
                // 必须主动 close：服务端已收尾时 EventSource 会自动重连并重新触发深采任务
                if (self.es) { try { self.es.close(); } catch (e) {} self.es = null; }
                if (ok && onDone) setTimeout(onDone, 600);
            };
            var url = params.ids || params.item_id || params.all_pending
                ? "/api/warehouse/deep/" + (params.item_id ? "one" : "batch") + "?p=" + encodeURIComponent(JSON.stringify(params))
                : "";
            var es = new EventSource(url);
            this.es = es;
            append("采集任务已提交：" + (params.item_id ? "单一深采 #" + params.item_id
                : params.ids ? "批量深采 " + params.ids.length + " 条" : "批量深采（全部未采）"), "wh-log-info");
            es.addEventListener("progress", function (m) {
                var ev;
                try { ev = JSON.parse(m.data); } catch (e) { return; }
                setProg(ev.percent || 0);
                status.innerHTML = '<i class="fas fa-sync fa-spin"></i> ' + esc(ev.message || ev.stage || "");
                append("[" + (ev.stage || "") + "] " + (ev.message || ""), ev.stage === "error" ? "wh-log-err" : (ev.stage === "saved" ? "wh-log-ok" : ""));
            });
            es.addEventListener("batch_done", function (m) {
                var ev;
                try { ev = JSON.parse(m.data); } catch (e) { ev = {}; }
                setProg(100);
                append(ev.message || "批量深采结束", "wh-log-ok");
            });
            es.addEventListener("result", function (m) {
                var ev;
                try { ev = JSON.parse(m.data); } catch (e) { return; }
                var list = Array.isArray(ev.data) ? ev.data : [ev.data];
                var ok = list.filter(function (r) { return r && r.ok; }).length;
                var html = '<div class="wh-result-head">采集结果：成功 <b>' + ok + "</b> / 失败 <b>" + (list.length - ok) + "</b></div>";
                list.slice(0, 50).forEach(function (r) {
                    html += '<div class="wh-result-row ' + (r.ok ? "wh-log-ok" : "wh-log-err") + '">' +
                        (r.ok ? "✔ " + esc(r.title || "") + "（" + (r.word_count || 0) + " 字，引擎 " + esc(r.engine || "") + (r.llm_used ? " + AI" : " + 规则") + "）"
                            : "✘ " + esc(r.title || "") + "：" + esc(r.error || "未知错误")) + "</div>";
                });
                result.innerHTML = html;
                // 单一深采末事件 saved 仅到 95%，收尾统一补满 100%（批量已由 batch_done 置 100）
                setProg(100);
                finish(list.length > 0 && list.every(function (r) { return r && r.ok; }));
            });
            es.addEventListener("error", function (m) {
                var ev = {};
                try { ev = JSON.parse(m.data || "{}"); } catch (e) {}
                if (ev.message) { append("错误：" + ev.message, "wh-log-err"); finish(false); }
            });
            es.onerror = function () { /* 自动重连由 EventSource 处理；服务端已结束会走 result 收尾 */ };
        },
    };

    // ---------- 按路径选模块 ----------
    function currentModule() {
        var p = location.pathname;
        if (/^\/admin\/users\/?$/.test(p)) return UserModule;
        if (/^\/admin\/roles\/?$/.test(p)) return RoleModule;
        if (/^\/admin\/menus\/?$/.test(p)) return MenuModule;
        if (/^\/admin\/sources\/?$/.test(p)) return SourceModule;
        if (/^\/admin\/warehouse\/?$/.test(p)) return WarehouseModule;
        return null; // 工作台等页面只走 shell
    }

    function boot() {
        layui.use(["layer", "form", "laypage", "element"], function () {
            L.layer = layui.layer;
            L.form = layui.form;
            L.laypage = layui.laypage;
            // 渲染顶栏下拉等基础 form/nav 组件
            L.form.render();
            if (layui.element) layui.element.render("nav");
            initShell(L.layer);
            var mod = currentModule();
            if (mod) mod.init();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
