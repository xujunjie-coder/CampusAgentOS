/* ================= 任务18：登录后自助人脸录入（前台「人脸设置」弹层） =================
 * 入口：侧栏底部「人脸」按钮 → #faceMask 弹层
 * 接口：GET /api/face/status、POST /api/face/enroll、POST /api/face/toggle、DELETE /api/face/<id>
 * 约定：图片只在浏览器内存里转 dataURL 上传，服务端只提取特征不落原图；本文件不接触特征向量。
 */
(function () {
    "use strict";

    var MAX_BYTES = 5 * 1024 * 1024;
    var ALLOWED_TYPES = { "image/jpeg": 1, "image/png": 1, "image/webp": 1 };

    var el = {};
    var state = { stream: null, shot: "", frames: null, busy: false, lastFocus: null,
        serviceReady: false, hasFace: false, cameraRequest: 0, session: 0 };

    function byId(id) { return document.getElementById(id); }

    function xsrfToken() {
        var input = document.querySelector('input[name="_xsrf"]');
        return input ? input.value : "";
    }

    function esc(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    /* ---------------- 请求封装：统一错误文案 + 会话过期跳转 ---------------- */
    function api(method, url, data) {
        var headers = { "X-Xsrftoken": xsrfToken() };
        var options = { method: method, headers: headers, credentials: "same-origin" };
        if (data !== undefined) {
            headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(data);
        }
        return fetch(url, options).then(function (resp) {
            return resp.text().then(function (text) {
                var payload = {};
                if (text) {
                    try { payload = JSON.parse(text); } catch (e) { payload = {}; }
                }
                if (resp.status === 401) {
                    setHint("登录已过期，正在跳转登录页…", "info");
                    window.location.href = "/auth/login?next=" +
                        encodeURIComponent(window.location.pathname + window.location.search);
                    throw new Error("登录已过期");
                }
                if (!resp.ok || payload.ok === false) {
                    throw new Error(payload.error || payload.detail ||
                        ("请求失败（" + resp.status + "）"));
                }
                return payload;
            });
        });
    }

    /* ---------------- 提示与忙碌态 ---------------- */
    function setHint(text, kind) {
        if (!el.hint) { return; }
        el.hint.textContent = text || "";
        el.hint.className = "face-hint" + (kind === "ok" ? " is-ok" : kind === "info" ? " is-info" : "");
    }

    function setBusy(busy) {
        state.busy = !!busy;
        if (el.dialog) { el.dialog.classList.toggle("face-busy", state.busy); }
        if (el.dialog) { el.dialog.setAttribute("aria-busy", String(state.busy)); }
        renderCapture();
        if (el.enabled) { el.enabled.disabled = state.busy || !state.serviceReady || !state.hasFace; }
    }

    function renderCapture() {
        var shot = !!state.shot;
        var live = !shot && isLive();
        el.stage.classList.toggle("is-shot", shot);
        el.stage.classList.toggle("is-live", live);
        el.actions.classList.toggle("is-live", live);
        el.captureBtn.hidden = !live;
        el.captureBtn.disabled = state.busy || !live || !state.serviceReady;
        el.retakeBtn.hidden = !shot;
        el.retakeBtn.disabled = state.busy;
        el.retakeBtn.innerHTML = '<i class="fas fa-redo" aria-hidden="true"></i> ' + (state.frames ? '重拍' : '重新选择');
        el.submit.hidden = !shot;
        el.enrollBtn.disabled = state.busy || !shot || !state.serviceReady;
        el.startBtn.disabled = state.busy || !state.serviceReady;
        el.uploadLabel.hidden = shot;
        el.uploadLabel.disabled = state.busy || !state.serviceReady;
    }

    function isLive() {
        return !!(state.stream && el.video && el.video.srcObject);
    }

    /* ---------------- 当前引擎声明（降级必须显式提示） ---------------- */
    function renderEngine(data) {
        if (!el.engine) { return; }
        state.serviceReady = !data.degraded;
        el.engine.hidden = state.serviceReady;
        if (data.degraded) {
            el.engine.className = "face-engine is-degraded";
            el.engine.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 人脸录入与登录暂不可用：' +
                esc(data.reason || "未启用真实人脸引擎") + "。请使用密码登录。";
        } else {
            el.engine.className = "face-engine is-real";
            el.engine.textContent = "";
        }
        renderCapture();
    }

    /* ---------------- 已录入列表 ---------------- */
    function renderList(data) {
        if (!el.list) { return; }
        var faces = data.faces || [];
        el.count.textContent = String(faces.length);
        if (!faces.length) {
            el.list.innerHTML = '<div class="face-empty"><i class="far fa-id-card" aria-hidden="true"></i>暂无人脸<span>录入后会显示在这里</span></div>';
            return;
        }
        el.list.innerHTML = faces.map(function (f, index) {
            var label = f.face_label && f.face_label !== "default" ? f.face_label : "人脸 " + (index + 1);
            return '<div class="face-row">' +
                '<span class="face-row-icon"><i class="fas fa-user" aria-hidden="true"></i></span>' +
                '<div class="face-row-main">' +
                '<div class="face-row-label">' + esc(label) + "</div>" +
                '<div class="face-row-meta"><span class="face-status-badge' + (f.enabled && !f.needs_reenrollment ? ' is-enabled' : '') + '">' +
                (f.needs_reenrollment ? '需重新录入' : (f.enabled ? '已启用' : '已停用')) + '</span>' +
                '</div><details class="face-row-details"><summary aria-label="' + esc(label) + '的详情与管理">详情与管理</summary>' +
                '<p>质量评分 ' + Number(f.quality || 0).toFixed(2) + '<br>录入于 ' + esc(f.created_at || '') + '</p>' +
                '<button type="button" class="layui-btn layui-btn-xs layui-btn-danger" ' +
                'data-face-del="' + esc(f.id) + '">删除这条记录</button></details>' +
                "</div></div>";
        }).join("");
        Array.prototype.forEach.call(el.list.querySelectorAll("[data-face-del]"), function (btn) {
            btn.addEventListener("click", async function () {
                if (state.busy) { return; }
                var confirmed = window.cwnuConfirm
                    ? await window.cwnuConfirm({
                        title: "删除人脸特征",
                        message: "确认删除这张已录入的人脸特征吗？删除后如需使用需重新采集。",
                        confirmText: "确认删除",
                        cancelText: "取消",
                        danger: true,
                    })
                    : window.confirm("确认删除这张人脸？删除后需要重新录入。");
                if (!confirmed) { return; }
                setBusy(true);
                api("DELETE", "/api/face/" + btn.getAttribute("data-face-del"))
                    .then(function (res) {
                        setHint("已删除，剩余 " + (res.count || 0) + " 张。", "ok");
                        return loadStatus();
                    })
                    .catch(function (err) { setHint(err.message, ""); })
                    .then(function () { setBusy(false); });
            });
        });
    }

    function renderSwitch(data) {
        if (!el.enabled) { return; }
        el.enabled.checked = !!data.enabled;
        var hasFace = (data.faces || []).some(function (face) { return face.enabled && !face.needs_reenrollment; });
        state.hasFace = hasFace;
        el.enabled.disabled = !hasFace || !state.serviceReady || state.busy;
        if (el.switchWrap) { el.switchWrap.classList.toggle("is-disabled", !hasFace); }
        el.enabled.title = hasFace ? "开启后可用刷脸登录" : "请先录入一张可用的人脸";
        el.switchWrap.title = el.enabled.title;
    }

    function loadStatus() {
        return api("GET", "/api/face/status").then(function (data) {
            renderEngine(data);
            renderList(data);
            renderSwitch(data);
            return data;
        });
    }

    /* ---------------- 摄像头 ---------------- */
    function secureContextOk() {
        if (window.isSecureContext) { return true; }
        var host = window.location.hostname;
        return host === "localhost" || host === "127.0.0.1" || host === "::1";
    }

    function fallbackToUpload(message) {
        setHint(message + " 请改用上传照片。", "info");
        if (el.uploadLabel) { el.uploadLabel.focus(); }
    }

    function stopCamera() {
        state.cameraRequest++;
        if (state.stream) {
            state.stream.getTracks().forEach(function (track) { track.stop(); });
            state.stream = null;
        }
        if (el.video) { el.video.srcObject = null; }
        if (el.stage) { renderCapture(); }
    }

    function startCamera() {
        if (state.busy || !state.serviceReady || el.mask.hidden) { return; }
        setHint("");
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            fallbackToUpload("当前浏览器不支持摄像头调用。");
            return;
        }
        if (!secureContextOk()) {
            fallbackToUpload("当前是 http 且非 localhost 地址，浏览器禁止调用摄像头。");
            return;
        }
        setBusy(true);
        var request = ++state.cameraRequest;
        navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 540 } },
            audio: false
        }).then(function (stream) {
            if (request !== state.cameraRequest || el.mask.hidden) {
                stream.getTracks().forEach(function (track) { track.stop(); });
                return;
            }
            state.stream = stream;
            el.video.srcObject = stream;
            el.stage.classList.remove("is-shot");
            el.stage.classList.add("is-live");
            el.captureBtn.disabled = false;
            el.startBtn.disabled = true;
            el.retakeBtn.hidden = true;
            setHint("");
        }).catch(function (err) {
            if (request !== state.cameraRequest || el.mask.hidden) { return; }
            var name = err && err.name;
            if (name === "NotAllowedError" || name === "SecurityError") {
                fallbackToUpload("摄像头权限被拒绝或页面不安全。");
            } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
                fallbackToUpload("没有检测到可用摄像头。");
            } else {
                fallbackToUpload("摄像头打开失败（" + (name || "未知原因") + "）。");
            }
        }).then(function () { if (request === state.cameraRequest) { setBusy(false); } });
    }

    async function capture() {
        if (!isLive() || state.busy) { return; }
        var video = el.video;
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
            setHint("摄像头画面正在加载，请稍后重试。", "info");
            return;
        }
        setBusy(true);
        setHint("正在采集，请保持正对镜头…", "info");
        var session = state.session;
        try {
            var frames = await window.captureFaceFrames(video);
            if (session !== state.session || el.mask.hidden) { return; }
            state.frames = frames;
        } catch (err) {
            if (session !== state.session || el.mask.hidden) { return; }
            setBusy(false);
            setHint(err.message, "");
            return;
        }
        state.shot = state.frames[1];
        el.shotImg.src = state.shot;
        el.stage.classList.remove("is-live");
        el.stage.classList.add("is-shot");
        setBusy(false);
        el.captureBtn.disabled = true;
        el.retakeBtn.hidden = false;
        el.enrollBtn.disabled = false;
        renderCapture();
        setHint("");
        el.enrollBtn.focus();
    }

    function retake() {
        if (state.busy) { return; }
        if (state.shot && !state.frames && !el.mask.hidden) {
            el.file.value = "";
            el.file.click();
            return;
        }
        state.shot = "";
        state.frames = null;
        if (el.shotImg) { el.shotImg.removeAttribute("src"); }
        if (el.enrollBtn) { el.enrollBtn.disabled = true; }
        if (el.stage) { el.stage.classList.remove("is-shot"); }
        if (state.stream) {
            el.stage.classList.add("is-live");
            el.captureBtn.disabled = false;
        }
        if (el.retakeBtn) { el.retakeBtn.hidden = true; }
        if (el.file) { el.file.value = ""; }
        renderCapture();
        setHint("");
        if (!el.mask.hidden) { (isLive() ? el.captureBtn : el.startBtn).focus(); }
    }

    /* ---------------- 上传照片 ---------------- */
    function pickFile() {
        if (state.busy) return;
        var file = el.file && el.file.files && el.file.files[0];
        if (!file) { return; }
        if (!ALLOWED_TYPES[file.type]) {
            setHint("仅支持 jpg / png / webp 图片。", "");
            el.file.value = "";
            return;
        }
        if (file.size > MAX_BYTES) {
            setHint("图片超过 5MB，请压缩后再上传。", "");
            el.file.value = "";
            return;
        }
        var reader = new FileReader();
        var session = state.session;
        reader.onload = function () {
            if (session !== state.session || el.mask.hidden) { return; }
            state.frames = null;
            state.shot = String(reader.result || "");
            el.shotImg.src = state.shot;
            stopCamera();
            el.stage.classList.add("is-shot");
            el.enrollBtn.disabled = false;
            renderCapture();
            setHint("");
            el.enrollBtn.focus();
        };
        reader.onerror = function () { setHint("读取图片失败，请换一张试试。", ""); };
        reader.readAsDataURL(file);
    }

    /* ---------------- 录入 / 开关 ---------------- */
    function enroll() {
        if (state.busy || !state.shot || !state.serviceReady) { return; }
        var label = (el.label && el.label.value ? el.label.value : "").trim() || "default";
        setBusy(true);
        setHint("正在检查活体并提取特征…", "info");
        var payload = state.frames ? { frames: state.frames, label: label } : { image: state.shot, label: label };
        api("POST", "/api/face/enroll", payload)
            .then(function (res) {
                state.shot = "";
                state.frames = null;
                el.shotImg.removeAttribute("src");
                el.stage.classList.remove("is-shot");
                stopCamera();
                el.enrollBtn.disabled = true;
                if (el.file) { el.file.value = ""; }
                if (el.label) { el.label.value = ""; }
                setHint("录入成功，已开启人脸登录。", "ok");
                return loadStatus();
            })
            .catch(function (err) { setHint(err.message, ""); })
            .then(function () { setBusy(false); });
    }

    function toggleEnabled() {
        if (state.busy || !state.serviceReady || !state.hasFace) { return; }
        var wanted = !!el.enabled.checked;
        setBusy(true);
        api("POST", "/api/face/toggle", { enabled: wanted })
            .then(function (res) {
                el.enabled.checked = !!res.enabled;
                setHint(res.enabled ? "已开启人脸登录，下次可直接刷脸进入。"
                    : "已关闭人脸登录，已录数据保留。", "ok");
            })
            .catch(function (err) {
                el.enabled.checked = !wanted;
                setHint(err.message, "");
            })
            .then(function () { setBusy(false); });
    }

    /* ---------------- 弹层开关 ---------------- */
    function open() {
        if (!el.mask) { return; }
        state.lastFocus = document.activeElement;
        state.session++;
        el.mask.hidden = false;
        state.serviceReady = false;
        el.engine.hidden = false;
        el.engine.className = "face-engine";
        el.engine.textContent = "正在检查人脸服务…";
        el.enabled.disabled = true;
        setHint("");
        renderCapture();
        loadStatus().catch(function (err) {
            el.engine.textContent = "无法加载人脸设置，请关闭后重试。";
            setHint(err.message, "");
        });
        if (el.closeBtn) { el.closeBtn.focus(); }
    }

    function close() {
        if (!el.mask) { return; }
        state.session++;
        setBusy(false);
        el.mask.hidden = true;
        stopCamera();
        state.shot = "";
        retake();
        el.label.value = "";
        el.mask.hidden = true;
        if (state.lastFocus && state.lastFocus.focus) { state.lastFocus.focus(); }
    }

    function bind() {
        el.mask = byId("faceMask");
        if (!el.mask) { return; }        /* 非前台页面（如后台）不加载 */
        el.dialog = el.mask.querySelector(".face-dialog");
        el.closeBtn = byId("faceClose");
        el.engine = byId("faceEngine");
        el.stage = byId("faceStage");
        el.video = byId("faceVideo");
        el.shotImg = byId("faceShot");
        el.startBtn = byId("faceStart");
        el.captureBtn = byId("faceCapture");
        el.retakeBtn = byId("faceRetake");
        el.file = byId("faceFile");
        el.uploadLabel = byId("faceUpload");
        el.actions = el.mask.querySelector(".face-actions");
        el.submit = byId("faceSubmit");
        el.count = byId("faceCount");
        el.hint = byId("faceHint");
        el.label = byId("faceLabel");
        el.enrollBtn = byId("faceEnroll");
        el.enabled = byId("faceEnabled");
        el.switchWrap = el.mask.querySelector(".face-switch");
        el.list = byId("faceList");

        var entry = byId("faceEntry");
        if (entry) { entry.addEventListener("click", open); }
        if (el.closeBtn) { el.closeBtn.addEventListener("click", close); }
        el.mask.addEventListener("click", function (event) {
            if (event.target === el.mask) { close(); }
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !el.mask.hidden) { close(); }
            if (event.key === "Tab" && !el.mask.hidden) {
                var focusable = Array.prototype.filter.call(el.dialog.querySelectorAll(
                    'button:not(:disabled), input:not(:disabled):not([type="file"]), summary'
                ), function (node) { return node.getClientRects().length > 0; });
                var first = focusable[0], last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault(); last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault(); first.focus();
                }
            }
        });
        if (el.startBtn) { el.startBtn.addEventListener("click", startCamera); }
        if (el.captureBtn) { el.captureBtn.addEventListener("click", capture); }
        if (el.retakeBtn) { el.retakeBtn.addEventListener("click", retake); }
        if (el.file) { el.file.addEventListener("change", pickFile); }
        if (el.uploadLabel) { el.uploadLabel.addEventListener("click", function () { if (!state.busy) { el.file.click(); } }); }
        if (el.enrollBtn) { el.enrollBtn.addEventListener("click", enroll); }
        if (el.enabled) { el.enabled.addEventListener("change", toggleEnabled); }
        window.addEventListener("pagehide", stopCamera);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bind);
    } else {
        bind();
    }
})();
