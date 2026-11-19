/**
 * notify.js —— 通知配置页面前端逻辑（成员 E）
 * 加载 / 保存 / 测试 通知配置，走 /api/admin/notify/config 接口
 */
(function () {
    "use strict";

    function $(id) { return document.getElementById(id); }

    // 获取 xsrf token（复用 admin.js 的全局逻辑）
    function getXsrf() {
        var f = document.getElementById("adminLogoutForm");
        if (f) {
            var input = f.querySelector('input[name="_xsrf"]');
            if (input) return input.value;
        }
        return "";
    }

    function api(method, url, body) {
        var opts = { method: method, headers: { "Content-Type": "application/json", "X-Xsrftoken": getXsrf() } };
        if (body) opts.body = JSON.stringify(body);
        return fetch(url, opts).then(function (r) {
            if (r.status === 401) { location.href = "/auth/login"; return Promise.reject("unauth"); }
            return r.json();
        });
    }

    // 渲染渠道状态
    function renderStatus(status) {
        var e = $("statusEmail");
        var q = $("statusQQ");
        if (status && status.email) {
            e.textContent = status.email.available ? "可用" : "未配置";
            e.className = "v " + (status.email.available ? "ok" : "off");
        }
        if (status && status.qq) {
            q.textContent = status.qq.available ? "可用 (" + (status.qq.mode || "") + ")" : "未配置";
            q.className = "v " + (status.qq.available ? "ok" : "off");
        }
    }

    // 填充表单
    function fillForm(config) {
        var forms = [$("formEmail"), $("formQQ")];
        forms.forEach(function (form) {
            if (!form) return;
            var inputs = form.querySelectorAll("[name]");
            inputs.forEach(function (el) {
                var key = el.getAttribute("name");
                if (config[key] !== undefined) {
                    el.value = config[key];
                }
            });
        });
        // layui 重新渲染 select
        if (window.layui) {
            layui.form.render("select", "formEmail");
        }
    }

    // 收集表单数据
    function collectForm() {
        var data = {};
        var forms = [$("formEmail"), $("formQQ")];
        forms.forEach(function (form) {
            if (!form) return;
            var inputs = form.querySelectorAll("[name]");
            inputs.forEach(function (el) {
                var key = el.getAttribute("name");
                var val = el.value.trim();
                // 跳过脱敏占位（密码未修改则不提交）
                if (val !== "****") {
                    data[key] = val;
                }
            });
        });
        return data;
    }

    // 加载配置
    function loadConfig() {
        api("GET", "/api/admin/notify/config").then(function (d) {
            if (d.ok) {
                fillForm(d.config || {});
                renderStatus(d.status);
            }
        }).catch(function () {});
    }

    // 保存配置
    function saveConfig() {
        var config = collectForm();
        api("POST", "/api/admin/notify/config/save", { config: config }).then(function (d) {
            if (d.ok) {
                if (window.layui) layui.layer.msg("配置已保存", { icon: 1 });
                renderStatus(d.status);
            } else {
                if (window.layui) layui.layer.msg(d.error || "保存失败", { icon: 2 });
            }
        }).catch(function (e) {
            if (window.layui) layui.layer.msg("请求异常：" + e, { icon: 2 });
        });
    }

    // 测试发送
    function testNotify() {
        if (window.layui) layui.layer.confirm("将向已配置的收件人发送一条测试消息，确认？", { icon: 3 }, function (idx) {
            layui.layer.close(idx);
            api("POST", "/api/admin/notify/test", { channel: "both" }).then(function (d) {
                if (d.ok && d.result && d.result.ok) {
                    layui.layer.msg("测试消息已发送", { icon: 1 });
                } else {
                    var reason = (d.result && d.result.results && d.result.results[0] && d.result.results[0].reason) || "发送失败";
                    layui.layer.msg(reason, { icon: 2, time: 5000 });
                }
                if (d.status) renderStatus(d.status);
            }).catch(function (e) {
                layui.layer.msg("请求异常：" + e, { icon: 2 });
            });
        });
    }

    // 初始化
    function init() {
        loadConfig();
        var btnSave = $("btnSaveNotify");
        var btnTest = $("btnTestNotify");
        if (btnSave) btnSave.addEventListener("click", saveConfig);
        if (btnTest) btnTest.addEventListener("click", testNotify);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
