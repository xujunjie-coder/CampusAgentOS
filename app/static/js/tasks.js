/*
 * tasks.js —— 定时任务管理前端逻辑（表现层，成员 E）
 * 由 templates/admin/tasks.html 引入（admin.js 只负责后台壳），负责：
 *   1. 任务列表：搜索 / 启停过滤 / 分页（每页 20 条），行内含上次/下次运行、上次结果、启停开关、快捷操作
 *   2. 新增 / 编辑弹层（layui form）：调度方式（间隔 / cron）切换显隐、按任务类型渲染参数、通知策略与渠道
 *   3. 手动触发一次 / 启停 / 删除 / 执行日志弹层 / 重载调度器 / 通知渠道测试
 *   4. 所有写请求带 X-Xsrftoken（取自退出登录隐藏表单），与后端 xsrf_cookies=True 对齐；DELETE 同样携带
 * 说明：手动触发后端走线程池 execute_task，本文件只需等 POST /run 返回结果弹窗，无需轮询。
 */
(function () {
    "use strict";

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }
    function toDom(layero) {
        if (!layero) return layero;
        if (layero.nodeType === 1) return layero;
        return layero.length != null ? layero[0] : layero;
    }
    function xsrf() {
        var f = $("adminLogoutForm");
        if (!f) return "";
        var i = f.querySelector('input[name="_xsrf"]');
        return i ? i.value : "";
    }

    var L = {}; // layer/form/laypage
    var OPTS = {}; // task_types / schedule_types / notify_on / notify_channels

    function api(method, url, body) {
        var opt = {
            method: method,
            headers: { "Content-Type": "application/json", "X-Xsrftoken": xsrf() }
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

    // 调度引擎英文标识 → 中文展示
    var ENGINE_LABEL = {
        apscheduler: "APScheduler（支持间隔 + Cron）",
        tornado: "Tornado 事件循环（降级，仅间隔自动排程）",
        disabled: "已关闭（SCHEDULER_ENABLED=0）"
    };
    var STATUS_LABEL = { success: "成功", failed: "失败", running: "运行中", "": "未运行" };
    var STATUS_CLS = { success: "task-st ok", failed: "task-st bad", running: "task-st run", "": "task-st none" };

    function schedText(row) {
        if (row.schedule_type === "cron") {
            return '<i class="fas fa-calendar-alt"></i> Cron <code>' + esc(row.cron_expr) + '</code>';
        }
        var s = parseInt(row.interval_seconds, 10) || 0;
        var human = s >= 86400 ? (s / 86400).toFixed(s % 86400 ? 1 : 0) + " 天"
            : s >= 3600 ? (s / 3600).toFixed(s % 3600 ? 1 : 0) + " 小时"
            : s >= 60 ? Math.round(s / 60) + " 分钟" : s + " 秒";
        return '<i class="fas fa-stopwatch"></i> 每 ' + esc(human);
    }

    /* ============================================================
     * 任务列表模块
     * ============================================================ */
    var TaskModule = {
        page: 1, keyword: "", status: "", rowCache: {},

        init: function () {
            var self = this;
            var box = $("taskStatus");
            if (box && box.dataset.options) OPTS = JSON.parse(box.dataset.options);
            $("taskEngineText").textContent = ENGINE_LABEL[$("taskEngineText").textContent] || $("taskEngineText").textContent;

            $("taskSearch").addEventListener("click", function () {
                self.keyword = $("taskKeyword").value.trim();
                self.load(1);
            });
            $("taskReset").addEventListener("click", function () {
                $("taskKeyword").value = "";
                self.keyword = "";
                self.status = "";
                $("taskStatusFilter").value = "";
                L.form.render("select");
                self.load(1);
            });
            $("taskKeyword").addEventListener("keydown", function (e) {
                if (e.key === "Enter") $("taskSearch").click();
            });
            $("taskAdd").addEventListener("click", function () { self.openForm(null); });
            $("taskLogs").addEventListener("click", function () { LogsModule.open(null); });
            $("schedulerReload").addEventListener("click", function () { self.reloadScheduler(); });
            $("notifyTest").addEventListener("click", function () { self.openNotifyTest(); });
            L.form.on("select(taskStatusFilter)", function (data) {
                self.status = data.value;
                self.load(1);
            });
            // 行内操作：事件委托
            $("taskBody").addEventListener("click", function (e) {
                var btn = e.target.closest("[data-act]");
                if (!btn) return;
                var id = parseInt(btn.getAttribute("data-id"), 10);
                var row = self.rowCache[id];
                if (!row) return;
                var act = btn.getAttribute("data-act");
                if (act === "edit") self.openForm(row);
                else if (act === "run") self.run(row);
                else if (act === "logs") LogsModule.open(row);
                else if (act === "del") self.del(row);
            });
            this.load(1);
        },

        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/tasks?page=" + this.page +
                "&keyword=" + encodeURIComponent(this.keyword) +
                "&status=" + encodeURIComponent(this.status);
            return api("GET", url).then(function (d) {
                $("taskCount").textContent = d.total;
                self.rowCache = {};
                var html = "";
                (d.list || []).forEach(function (t) {
                    self.rowCache[t.id] = t;
                    html += self.rowHtml(t);
                });
                $("taskBody").innerHTML = html ||
                    '<tr><td colspan="8" class="admin-empty"><i class="fas fa-inbox"></i> 暂无定时任务，点击「新增任务」创建，或重载调度器载入内置运维任务</td></tr>';
                L.laypage.render({
                    elem: "taskPager",
                    count: d.total,
                    limit: 20,
                    curr: self.page,
                    layout: ["count", "prev", "page", "next", "skip"],
                    jump: function (obj, first) { if (!first) self.load(obj.curr); }
                });
                // 行内启停开关（lay-filter=taskRow<id> 独立容器需分别渲染皮肤）
                $("taskBody").querySelectorAll("tr.task-row.layui-form").forEach(function (tr) {
                    L.form.render("checkbox", tr.getAttribute("lay-filter"));
                });
            }).catch(function () {
                $("taskBody").innerHTML = '<tr><td colspan="8" class="admin-empty"><i class="fas fa-exclamation-triangle"></i> 加载失败，请刷新重试</td></tr>';
            });
        },

        rowHtml: function (t) {
            var st = STATUS_LABEL[t.last_status] != null ? STATUS_LABEL[t.last_status] : (t.last_status || "未运行");
            var stCls = STATUS_CLS[t.last_status] || "task-st none";
            var typeLabel = (OPTS.task_types && OPTS.task_types[t.task_type]) || t.task_type;
            var swFilter = "taskRow" + t.id;
            return '' +
                '<tr class="task-row layui-form" data-id="' + t.id + '" lay-filter="' + swFilter + '">' +
                '  <td class="task-name"><div class="n" title="' + esc(t.name) + '">' + esc(t.name) + '</div>' +
                '    <div class="d">' + (esc(t.description) || "无简介") + '</div></td>' +
                '  <td><span class="task-type-tag">' + esc(typeLabel) + '</span></td>' +
                '  <td class="task-sched">' + schedText(t) + '</td>' +
                '  <td class="task-time">' + (esc(t.last_run_at) || "—") + '</td>' +
                '  <td class="task-time">' + (esc(t.next_run_at) || "—") + '</td>' +
                '  <td><span class="' + stCls + '">' + esc(st) + '</span></td>' +
                '  <td><input type="checkbox" name="taskToggle" lay-skin="switch" lay-text="启用|停用" lay-filter="taskToggle" data-id="' + t.id + '"' + (t.enabled ? " checked" : "") + '></td>' +
                '  <td class="task-ops">' +
                '    <button type="button" class="layui-btn layui-btn-xs" data-act="run" data-id="' + t.id + '" title="立即运行一次"><i class="fas fa-play"></i> 运行</button>' +
                '    <button type="button" class="layui-btn layui-btn-xs layui-btn-normal" data-act="edit" data-id="' + t.id + '"><i class="fas fa-edit"></i> 编辑</button>' +
                '    <button type="button" class="layui-btn layui-btn-xs layui-btn-primary" data-act="logs" data-id="' + t.id + '"><i class="fas fa-list-alt"></i> 日志</button>' +
                '    <button type="button" class="layui-btn layui-btn-xs layui-btn-danger" data-act="del" data-id="' + t.id + '"><i class="fas fa-trash-alt"></i> 删除</button>' +
                '  </td>' +
                "</tr>";
        },

        /* ---------- 新增 / 编辑弹层 ---------- */
        openForm: function (row) {
            var self = this;
            var isEdit = !!row;
            row = row || {};
            var params = row.params || {};
            if (typeof params === "string") { try { params = JSON.parse(params || "{}"); } catch (e) { params = {}; } }

            function optionsHtml(map, cur) {
                return Object.keys(map).map(function (k) {
                    return '<option value="' + esc(k) + '"' + (k === cur ? " selected" : "") + ">" + esc(map[k]) + "</option>";
                }).join("");
            }
            var typeOpts = optionsHtml(OPTS.task_types || {}, row.task_type || "log_cleanup");
            var schedOpts = optionsHtml(OPTS.schedule_types || {}, row.schedule_type || "interval");
            var notifyOnOpts = optionsHtml(OPTS.notify_on || {}, row.notify_on || "fail");
            var notifyChOpts = optionsHtml(OPTS.notify_channels || {}, row.notify_channel || "none");

            var html = '' +
                '<div class="layui-form task-form" lay-filter="taskForm">' +
                '  <div class="layui-form-item"><label class="layui-form-label">任务名称</label><div class="layui-input-block">' +
                '    <input type="text" name="name" class="layui-input" placeholder="如：每日日志清理" value="' + esc(row.name || "") + '"></div></div>' +
                '  <div class="layui-form-item"><label class="layui-form-label">任务类型</label><div class="layui-input-block">' +
                '    <select name="task_type" lay-filter="taskTypeSel">' + typeOpts + '</select></div></div>' +
                '  <div class="layui-form-item"><label class="layui-form-label">简介</label><div class="layui-input-block">' +
                '    <input type="text" name="description" class="layui-input" placeholder="一句话说明这个任务做什么（可选）" value="' + esc(row.description || "") + '"></div></div>' +

                '  <div class="task-section-title"><i class="fas fa-clock"></i> 调度方式</div>' +
                '  <div class="layui-form-item"><label class="layui-form-label">调度类型</label><div class="layui-input-inline" style="width:160px;">' +
                '    <select name="schedule_type" lay-filter="taskSchedSel">' + schedOpts + '</select></div>' +
                '    <div class="layui-input-inline task-sched-interval" style="width:200px;">' +
                '      <input type="number" name="interval_seconds" class="layui-input" min="10" placeholder="间隔秒数（≥10）" value="' + (row.interval_seconds || 86400) + '"></div>' +
                '    <div class="layui-input-inline task-sched-cron" style="width:260px;display:none;">' +
                '      <input type="text" name="cron_expr" class="layui-input" placeholder="如：0 3 * * * （分 时 日 月 周）" value="' + esc(row.cron_expr || "") + '"></div></div>' +

                '  <div class="task-section-title"><i class="fas fa-sliders-h"></i> 任务参数</div>' +
                '  <div id="taskParamBox"></div>' +

                '  <div class="task-section-title"><i class="fas fa-bell"></i> 结果通知</div>' +
                '  <div class="layui-form-item"><label class="layui-form-label">通知时机</label><div class="layui-input-inline" style="width:160px;">' +
                '    <select name="notify_on">' + notifyOnOpts + '</select></div>' +
                '    <label class="layui-form-label" style="width:90px;">通知渠道</label><div class="layui-input-inline" style="width:160px;">' +
                '    <select name="notify_channel">' + notifyChOpts + '</select></div></div>' +

                '  <div class="layui-form-item"><label class="layui-form-label">启用状态</label><div class="layui-input-block">' +
                '    <input type="checkbox" name="enabled" lay-skin="switch" lay-text="启用|停用"' + (row.enabled === 0 ? "" : " checked") + '></div></div>' +
                "</div>";

            L.layer.open({
                type: 1,
                title: isEdit ? "编辑定时任务 · " + esc(row.name) : "新增定时任务",
                area: ["640px", "600px"],
                shadeClose: false,
                content: html,
                btn: ["保存", "取消"],
                success: function (layero) {
                    var dom = toDom(layero);
                    L.form.render(null, "taskForm");
                    var typeSel = dom.querySelector('[name="task_type"]');
                    var schedSel = dom.querySelector('[name="schedule_type"]');
                    renderParams(dom, typeSel.value, params);
                    syncSched(dom, schedSel.value);
                    // 类型变更 → 重渲染参数（保留已填值不跨类型，直接切默认）
                    L.form.on("select(taskTypeSel)", function (data) {
                        renderParams(toDom(data.elem).closest(".task-form"), data.value, {});
                    });
                    L.form.on("select(taskSchedSel)", function (data) {
                        syncSched(toDom(data.elem).closest(".task-form"), data.value);
                    });
                },
                yes: function (index, layero) {
                    var dom = toDom(layero);
                    function val(name) {
                        var el = dom.querySelector('[name="' + name + '"]');
                        return el ? el.value.trim() : "";
                    }
                    function num(name, def) {
                        var v = val(name);
                        return v === "" ? def : parseInt(v, 10);
                    }
                    var name = val("name");
                    if (!name) { L.layer.msg("请填写任务名称", { icon: 2 }); return false; }
                    var scheduleType = val("schedule_type") || "interval";
                    if (scheduleType === "cron" && !val("cron_expr")) {
                        L.layer.msg("Cron 任务必须填写表达式", { icon: 2 }); return false;
                    }
                    var p = {};
                    dom.querySelectorAll("[data-param]").forEach(function (el) {
                        var v = el.value.trim();
                        if (v !== "") p[el.getAttribute("data-param")] = el.type === 'number' ? parseInt(v, 10) : v;
                    });
                    var payload = {
                        name: name,
                        description: val("description"),
                        task_type: val("task_type"),
                        schedule_type: scheduleType,
                        interval_seconds: num("interval_seconds", 86400),
                        cron_expr: val("cron_expr"),
                        notify_on: val("notify_on"),
                        notify_channel: val("notify_channel"),
                        params: p,
                        enabled: dom.querySelector('[name="enabled"]').checked ? 1 : 0
                    };
                    var url = isEdit ? "/api/admin/tasks/" + row.id : "/api/admin/tasks";
                    api("POST", url, payload).then(function () {
                        L.layer.msg("已保存，调度器已重载", { icon: 1 });
                        L.layer.close(index);
                        self.load(isEdit ? self.page : 1);
                    });
                    return false;
                }
            });
        },

        run: function (row) {
            var self = this;
            var loadIdx = L.layer.load(2);
            api("POST", "/api/admin/tasks/" + row.id + "/run", {}).then(function (d) {
                L.layer.close(loadIdx);
                var r = d.result || {};
                var notifyTip = "";
                if (r.notify) {
                    if (r.notify.skipped) notifyTip = "（未通知）";
                    else if (r.notify.degraded) notifyTip = "（通知渠道未配置，已降级）";
                    else notifyTip = r.notify.ok ? "（通知已发送）" : "（通知发送失败）";
                }
                L.layer.alert("任务「" + esc(row.name) + "」运行" +
                    (r.ok ? "成功" : "结束") + "<br>结果：" + esc(r.result || "（无）") +
                    (notifyTip ? "<br>通知：" + esc(notifyTip) : ""),
                    { icon: r.ok ? 1 : 2, title: "手动运行结果" });
                self.load(self.page);
            }).catch(function () { L.layer.close(loadIdx); });
        },

        del: function (row) {
            var self = this;
            L.layer.confirm("确认删除定时任务「" + esc(row.name) + "」？执行日志会保留。",
                { icon: 3, title: "操作确认" }, function (index) {
                    L.layer.close(index);
                    api("DELETE", "/api/admin/tasks/" + row.id).then(function () {
                        L.layer.msg("已删除", { icon: 1 });
                        self.load(self.page);
                    });
                });
        },

        reloadScheduler: function () {
            api("POST", "/api/admin/scheduler", { action: "reload" }).then(function (d) {
                var s = d.scheduler || {};
                L.layer.msg("调度器已重载：" + (ENGINE_LABEL[s.engine] || s.engine) +
                    "，启用任务 " + (s.enabled_tasks || 0) + " 项", { icon: 1, time: 2500 });
                this.load(this.page);
            }.bind(this));
        },

        openNotifyTest: function () {
            var self = this;
            var html = '<div class="layui-form task-notify-test" lay-filter="notifyTestForm">' +
                '  <div class="layui-form-item"><label class="layui-form-label">测试渠道</label><div class="layui-input-block">' +
                '    <select name="channel">' +
                '      <option value="email">邮件</option><option value="qq">QQ</option><option value="both">邮件 + QQ</option>' +
                '    </select></div></div>' +
                '  <div class="tip" style="padding:0 16px;color:#8a94a6;">将发送一条测试通知，用于验证 SMTP / webhook 配置是否正确。</div>' +
                "</div>";
            L.layer.open({
                type: 1, title: "通知渠道测试", area: ["460px", "240px"], content: html,
                btn: ["发送测试", "取消"],
                success: function (layero) { L.form.render(null, "notifyTestForm"); },
                yes: function (index, layero) {
                    var dom = toDom(layero);
                    var channel = dom.querySelector('[name="channel"]').value;
                    var loadIdx = L.layer.load(2);
                    api("POST", "/api/admin/notify/test", { channel: channel }).then(function (d) {
                        L.layer.close(loadIdx);
                        var r = d.result || {};
                        var lines = [];
                        (r.results || []).forEach(function (it) {
                            lines.push("· " + esc(it.channel) + "：" + (it.degraded ? "未配置降级" : (it.ok ? "发送成功" : ("失败 - " + (it.reason || "")))));
                        });
                        L.layer.alert("渠道可用性：" + (r.ok ? "全部成功" : (r.degraded ? "部分未配置" : "有失败")) +
                            "<br>" + (lines.join("<br>") || "（该渠道未产生投递结果）"), { icon: 1, title: "测试结果" });
                    }).catch(function () { L.layer.close(loadIdx); });
                    return false;
                }
            });
        }
    };

    /* 参数区：按任务类型渲染对应数字输入（data-param 标记，保存时收集为 params 对象） */
    var PARAM_DEFS = {
        log_cleanup: [
            { key: "login_logs_days", label: "登录审计保留天数", def: 90 },
            { key: "task_logs_days", label: "任务流水保留天数", def: 30 }
        ],
        auto_archive: [
            { key: "keep_days", label: "会话消息保留天数", def: 90 }
        ],
        qq_channel_daily: [
            {key:'channel',label:'频道号',def:'CWNUpindao',type:'text'},
            {key:'max_posts',label:'分析热门帖数',def:20},
            {key:'sample_posts',label:'热门候选样本数',def:50},
            {key:'max_scrolls',label:'热门翻页上限',def:15}
        ]
    };
    function renderParams(dom, taskType, params) {
        var box = dom.querySelector("#taskParamBox");
        if (!box) return;
        var defs = PARAM_DEFS[taskType] || [];
        if (!defs.length) {
            box.innerHTML = '<div class="task-param-empty" style="padding:6px 16px;color:#8a94a6;">该任务类型暂无可调参数。</div>';
            return;
        }
        box.innerHTML = defs.map(function (def) {
            var v = params[def.key] != null ? params[def.key] : def.def;
            return '<div class="layui-form-item"><label class="layui-form-label">' + esc(def.label) + '</label>' +
                '<div class="layui-input-inline" style="width:160px;">' +
                '<input type="' + (def.type || 'number') + '" ' + (def.type==='text' ? '' : 'min="1" ') + 'class="layui-input" data-param="' + esc(def.key) + '" value="' + esc(v) + '"></div></div>';
        }).join("");
    }
    function syncSched(dom, scheduleType) {
        dom.querySelector(".task-sched-interval").style.display = scheduleType === "cron" ? "none" : "";
        dom.querySelector(".task-sched-cron").style.display = scheduleType === "cron" ? "" : "none";
    }

    /* ============================================================
     * 执行流水弹层（可全部 / 按任务过滤）
     * ============================================================ */
    var LogsModule = {
        idx: null, page: 1, taskId: 0,
        open: function (row) {
            var self = this;
            this.taskId = row ? row.id : 0;
            this.page = 1;
            L.layer.open({
                type: 1,
                title: '<i class="fas fa-list-alt"></i> 任务执行日志' + (row ? " · " + esc(row.name) : ""),
                area: ["820px", "600px"],
                shadeClose: true,
                content: '<div class="task-logs"><table class="layui-table" lay-size="sm">' +
                    '<thead><tr><th width="120">任务</th><th width="90">触发</th><th width="80">状态</th>' +
                    '<th width="150">开始</th><th width="90">耗时</th><th>结果</th></tr></thead>' +
                    '<tbody id="logBody"><tr><td colspan="6" class="admin-empty">加载中…</td></tr></tbody></table>' +
                    '<div class="admin-pager"><span class="admin-pager-tip">每页 20 条</span><div id="logPager" class="admin-pager-box"></div></div></div>',
                success: function () { self.load(1); }
            });
        },
        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/task-logs?page=" + this.page + "&task_id=" + this.taskId;
            api("GET", url).then(function (d) {
                var html = "";
                (d.list || []).forEach(function (log) {
                    var stCls = STATUS_CLS[log.status] || "task-st none";
                    html += '<tr>' +
                        '<td>' + esc(log.task_name) + '</td>' +
                        '<td>' + (log.trigger === "manual" ? "手动" : "调度") + '</td>' +
                        '<td><span class="' + stCls + '">' + esc(STATUS_LABEL[log.status] || log.status) + '</span></td>' +
                        '<td>' + esc(log.started_at || "—") + '</td>' +
                        '<td>' + (log.duration_ms != null ? log.duration_ms + " ms" : "—") + '</td>' +
                        '<td class="log-result">' + esc(log.result || "—") + '</td>' +
                        "</tr>";
                });
                $("logBody").innerHTML = html || '<tr><td colspan="6" class="admin-empty"><i class="fas fa-inbox"></i> 暂无执行记录</td></tr>';
                L.laypage.render({
                    elem: "logPager", count: d.total, limit: 20, curr: self.page,
                    layout: ["count", "prev", "page", "next", "skip"],
                    jump: function (obj, first) { if (!first) self.load(obj.curr); }
                });
            });
        }
    };

    /* 启停开关事件（全局委托，一次注册） */
    function bindSwitchEvents() {
        L.form.on("switch(taskToggle)", function (data) {
            var el = data.elem;
            var id = parseInt(el.getAttribute("data-id"), 10);
            if (!id) return;
            api("POST", "/api/admin/tasks/" + id + "/toggle", { enabled: el.checked ? 1 : 0 }).then(function () {
                L.layer.msg(el.checked ? "已启用" : "已停用", { icon: 1 });
                TaskModule.load(TaskModule.page);
            }).catch(function () { TaskModule.load(TaskModule.page); });
        });
    }

    function boot() {
        if (!/^\/admin\/tasks\/?$/.test(location.pathname)) return;
        layui.use(["layer", "form", "laypage"], function () {
            L.layer = layui.layer;
            L.form = layui.form;
            L.laypage = layui.laypage;
            bindSwitchEvents();
            TaskModule.init();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
