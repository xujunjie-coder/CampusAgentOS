/*
 * models.js —— 模型引擎管理前端逻辑（表现层，任务8）
 * 由 templates/admin/models.html 引入（admin.js 只负责后台壳），负责：
 *   1. 橱窗列表：一行 2 列、4 条/页，卡片含类型徽标/默认标记/配置信息/快捷操作
 *   2. 新增/编辑弹层（layui form）、删除确认、设为默认
 *   3. 模型测试弹层：
 *      - text/multimodal/vl：ChatGPT 式多轮流式对话（SSE），思维开关（enable_thinking），
 *        vl/multimodal 支持附加图片 URL（OpenAI 视觉范式 content 数组）
 *      - embedding：向量测试（维度 + 预览）；image：文生图测试
 *   4. 所有请求带 X-Xsrftoken（取自 base.html 退出登录隐藏表单），与后端 xsrf_cookies=True 对齐
 * SSE 约定与 /api/chat 一致：delta 的 data 为纯文本串，reasoning/usage/result/image/error 为对象。
 * 任务8.1：模型 token 统计——卡片直观反馈累计 token（含迷你比例条，宽度按全库最大值 token_max 折算），
 *   「Token 统计」弹层走 /api/admin/models/stats，纯手写 DOM/CSS 图表（汇总卡/堆叠柱趋势/排行条/明细表）。
 */
(function () {
    "use strict";

    var PAGE_SIZE = 4;

    // 类型元数据：图标（FA5 有效类名）与测试入口文案
    var TYPE_META = {
        text:       { icon: "fas fa-font",          test: "对话测试" },
        multimodal: { icon: "fas fa-layer-group",   test: "对话测试" },
        image:      { icon: "fas fa-image",         test: "图片测试" },
        vl:         { icon: "fas fa-eye",           test: "对话测试" },
        embedding:  { icon: "fas fa-vector-square", test: "向量测试" }
    };

    function $(id) { return document.getElementById(id); }
    // token 数友好展示：1234 -> 1.2k，1234567 -> 1.23M
    function fmtTokens(n) {
        n = Number(n) || 0;
        if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
        if (n >= 1000) return (n / 1000).toFixed(1) + "k";
        return String(n);
    }
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }
    // layer 回调的 layero 可能是 jQuery 对象，归一为真实 DOM
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

    /* ============================================================
     * 橱窗列表
     * ============================================================ */
    var ModelModule = {
        page: 1, keyword: "", type: "", rowCache: {}, tokenMax: 1,

        init: function () {
            var self = this;
            $("modelSearch").addEventListener("click", function () {
                self.keyword = $("modelKeyword").value.trim();
                self.load(1);
            });
            $("modelReset").addEventListener("click", function () {
                $("modelKeyword").value = "";
                self.keyword = "";
                self.type = "";
                var sel = $("modelType");
                sel.value = "";
                L.form.render("select");
                self.load(1);
            });
            $("modelKeyword").addEventListener("keydown", function (e) {
                if (e.key === "Enter") $("modelSearch").click();
            });
            $("modelAdd").addEventListener("click", function () { self.openForm(null); });
            $("modelStats").addEventListener("click", function () { self.openStats(); });
            L.form.on("select(modelType)", function (data) {
                self.type = data.value;
                self.load(1);
            });
            // 卡片快捷操作：事件委托
            $("modelGrid").addEventListener("click", function (e) {
                var btn = e.target.closest("[data-act]");
                if (!btn) return;
                var id = parseInt(btn.getAttribute("data-id"), 10);
                var row = self.rowCache[id];
                if (!row) return;
                var act = btn.getAttribute("data-act");
                if (act === "test") self.openTest(row);
                else if (act === "edit") self.openForm(row);
                else if (act === "default") self.setDefault(row);
                else if (act === "del") self.del(row);
            });
            this.load(1);
        },

        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/models?page=" + this.page +
                "&keyword=" + encodeURIComponent(this.keyword) +
                "&type=" + encodeURIComponent(this.type);
            return api("GET", url).then(function (d) {
                $("modelCount").textContent = d.total;
                self.tokenMax = d.token_max || 1;  // 任务8.1：卡片迷你条的全库最大值基准
                self.rowCache = {};
                var html = "";
                (d.list || []).forEach(function (m) {
                    self.rowCache[m.id] = m;
                    html += self.cardHtml(m);
                });
                $("modelGrid").innerHTML = html ||
                    '<div class="model-grid-empty"><i class="fas fa-box-open"></i> 暂无模型，点击「新增模型」接入第一个大模型服务</div>';
                L.laypage.render({
                    elem: "modelPager",
                    count: d.total,
                    limit: PAGE_SIZE,
                    curr: self.page,
                    layout: ["count", "prev", "page", "next", "skip"],
                    jump: function (obj, first) { if (!first) self.load(obj.curr); }
                });
            }).catch(function () {
                $("modelGrid").innerHTML = '<div class="model-grid-empty"><i class="fas fa-exclamation-triangle"></i> 加载失败，请刷新重试</div>';
            });
        },

        cardHtml: function (m) {
            var meta = TYPE_META[m.type] || TYPE_META.text;
            var badges = '<span class="model-badge type"><i class="' + meta.icon + '"></i> ' + esc(m.type_label) + "</span>";
            if (m.is_default) badges += '<span class="model-badge default"><i class="fas fa-star"></i> 默认模型</span>';
            if (m.thinking) badges += '<span class="model-badge thinking"><i class="fas fa-brain"></i> 思维链</span>';
            var state = m.enabled
                ? '<span class="model-state"><span class="dot"></span>启用中</span>'
                : '<span class="model-state off"><span class="dot"></span>已停用</span>';
            var actions =
                '<button type="button" class="layui-btn layui-btn-sm layui-btn-normal" data-act="test" data-id="' + m.id + '"><i class="fas fa-comments"></i> ' + meta.test + "</button>" +
                '<span class="spacer"></span>';
            if (!m.is_default) {
                actions += '<button type="button" class="model-act-icon star" data-act="default" data-id="' + m.id + '" title="设为默认模型"><i class="far fa-star"></i></button>';
            }
            actions +=
                '<button type="button" class="model-act-icon" data-act="edit" data-id="' + m.id + '" title="编辑"><i class="fas fa-pen"></i></button>' +
                '<button type="button" class="model-act-icon danger" data-act="del" data-id="' + m.id + '" title="删除"><i class="fas fa-trash-alt"></i></button>';
            return '' +
                '<div class="model-card' + (m.enabled ? "" : " is-disabled") + '" data-type="' + esc(m.type) + '">' +
                '  <div class="model-card-head">' +
                '    <div class="model-avatar"><i class="' + meta.icon + '"></i></div>' +
                '    <div class="model-title-wrap">' +
                '      <div class="model-name" title="' + esc(m.name) + '">' + esc(m.name) + "</div>" +
                '      <div class="model-badges">' + badges + "</div>" +
                "    </div>" + state +
                "  </div>" +
                '  <div class="model-meta">' +
                '    <div class="model-meta-row"><span class="k">模型标识</span><span class="v" title="' + esc(m.model_id) + '">' + esc(m.model_id) + "</span></div>" +
                '    <div class="model-meta-row"><span class="k">API 地址</span><span class="v" title="' + esc(m.api_url) + '">' + esc(m.api_url) + "</span></div>" +
                '    <div class="model-meta-row"><span class="k">API Key</span><span class="v">' + (esc(m.api_key) || "（未配置）") + "</span></div>" +
                "  </div>" +
                // 任务8.1：token 直观反馈——累计用量大字 + 调用次数 + 迷你比例条（按全库最大值折算）
                '  <div class="model-token">' +
                '    <span class="model-token-label"><i class="fas fa-coins"></i>Token 累计</span>' +
                '    <span class="model-token-num">' + fmtTokens(m.token_total) + "</span>" +
                '    <span class="model-token-calls">' + (m.call_count || 0) + " 次调用</span>" +
                "  </div>" +
                '  <div class="model-token-bar"><i style="width:' +
                Math.max(2, Math.round((m.token_total || 0) / (ModelModule.tokenMax || 1) * 100)) + '%"></i></div>' +
                '  <div class="model-desc">' + (esc(m.description) || "暂无简介") + "</div>" +
                '  <div class="model-actions">' + actions + "</div>" +
                "</div>";
        },

        /* ---------- 新增 / 编辑弹层 ---------- */
        openForm: function (row) {
            var self = this;
            var isEdit = !!row;
            row = row || {};
            var typeOptions = "";
            Object.keys(TYPE_META).forEach(function (code) {
                var label = { text: "文本类", multimodal: "多模态类", image: "图片类", vl: "VL类", embedding: "嵌入模型类" }[code];
                typeOptions += '<option value="' + code + '"' + (row.type === code ? " selected" : "") + ">" + label + "</option>";
            });
            var html = '' +
                '<div class="layui-form model-form" lay-filter="modelForm">' +
                '  <div class="layui-form-item"><label class="layui-form-label">模型名称</label><div class="layui-input-block">' +
                '    <input type="text" name="name" class="layui-input" placeholder="如：Smart 文本模型" value="' + esc(row.name || "") + '"></div></div>' +
                '  <div class="model-form-row2">' +
                '    <div class="layui-form-item"><label class="layui-form-label">模型类型</label><div class="layui-input-block">' +
                '      <select name="type">' + typeOptions + "</select></div></div>" +
                '    <div class="layui-form-item"><label class="layui-form-label">模型标识</label><div class="layui-input-block">' +
                '      <input type="text" name="model_id" class="layui-input" placeholder="服务端 model_id" value="' + esc(row.model_id || "") + '"></div></div>' +
                "  </div>" +
                '  <div class="layui-form-item"><label class="layui-form-label">API 地址</label><div class="layui-input-block">' +
                '    <input type="text" name="api_url" class="layui-input" placeholder="OpenAI 范式 base_url，如 http://127.0.0.1:11435/v1" value="' + esc(row.api_url || "") + '"></div></div>' +
                '  <div class="layui-form-item"><label class="layui-form-label">API Key</label><div class="layui-input-block">' +
                '    <input type="text" name="api_key" class="layui-input" autocomplete="off" placeholder="' + (isEdit ? "留空保持不变（当前：" + esc(row.api_key || "未配置") + "）" : "Bearer 鉴权密钥，可留空") + '"></div></div>' +
                '  <div class="model-form-row2">' +
                '    <div class="layui-form-item"><label class="layui-form-label">思维链</label><div class="layui-input-block">' +
                '      <input type="checkbox" name="thinking" lay-skin="switch" lay-text="支持|不支持"' + (row.thinking ? " checked" : "") + "></div></div>" +
                '    <div class="layui-form-item"><label class="layui-form-label">启用状态</label><div class="layui-input-block">' +
                '      <input type="checkbox" name="enabled" lay-skin="switch" lay-text="启用|停用"' + (row.enabled === 0 ? "" : " checked") + "></div></div>" +
                "  </div>" +
                '  <div class="layui-form-item"><label class="layui-form-label">简介</label><div class="layui-input-block">' +
                '    <textarea name="description" class="layui-textarea" placeholder="模型用途 / 来源说明（可选）">' + esc(row.description || "") + "</textarea></div></div>" +
                "</div>";
            L.layer.open({
                type: 1,
                title: isEdit ? "编辑模型 · " + esc(row.name) : "新增模型",
                area: ["640px", "auto"],
                shadeClose: false,
                content: html,
                btn: ["保存", "取消"],
                success: function (layero) {
                    L.form.render(null, "modelForm");
                },
                yes: function (index, layero) {
                    var dom = toDom(layero);
                    function val(name) {
                        var el = dom.querySelector('[name="' + name + '"]');
                        return el ? el.value.trim() : "";
                    }
                    function checked(name) {
                        var el = dom.querySelector('[name="' + name + '"]');
                        return el && el.checked ? 1 : 0;
                    }
                    var payload = {
                        name: val("name"),
                        type: val("type"),
                        model_id: val("model_id"),
                        api_url: val("api_url"),
                        api_key: val("api_key"),
                        thinking: checked("thinking"),
                        enabled: checked("enabled"),
                        description: val("description")
                    };
                    if (!payload.name) { L.layer.msg("请填写模型名称", { icon: 2 }); return false; }
                    if (!/^https?:\/\//.test(payload.api_url)) { L.layer.msg("API 地址须以 http:// 或 https:// 开头", { icon: 2 }); return false; }
                    if (!payload.model_id) { L.layer.msg("请填写模型标识 model_id", { icon: 2 }); return false; }
                    var url = isEdit ? "/api/admin/models/" + row.id : "/api/admin/models";
                    api("POST", url, payload).then(function () {
                        L.layer.msg("已保存", { icon: 1 });
                        L.layer.close(index);
                        self.load(isEdit ? self.page : 1);
                    });
                    return false; // 请求成功后手动关闭，失败保留弹层
                }
            });
        },

        setDefault: function (row) {
            var self = this;
            L.layer.confirm("把「" + esc(row.name) + "」设为系统默认模型？智能体对话等 AI 链路将优先使用它。", { icon: 3, title: "设为默认" }, function (index) {
                L.layer.close(index);
                api("POST", "/api/admin/models/" + row.id + "/default").then(function () {
                    L.layer.msg("已设为默认模型", { icon: 1 });
                    self.load(self.page);
                });
            });
        },

        del: function (row) {
            var self = this;
            var tip = "确认删除模型「" + esc(row.name) + "」？" + (row.is_default ? "它是当前默认模型，删除后默认位将自动让给下一个启用模型。" : "");
            L.layer.confirm(tip, { icon: 3, title: "操作确认" }, function (index) {
                L.layer.close(index);
                api("DELETE", "/api/admin/models/" + row.id).then(function () {
                    L.layer.msg("已删除", { icon: 1 });
                    self.load(self.page);
                });
            });
        },

        /* ============================================================
         * 任务8.1：Token 统计弹层（ECharts 图形化：趋势双折线 + 模型排行横条）
         * 图表资源按需加载：本页无 echarts.min.js 时动态注入，避免全站每页多拉 1MB
         * ============================================================ */
        openStats: function () {
            var self = this;
            var days = 14;

            function ensureCharts(done) {
                if (window.echarts && window.ChartKit) { done(); return; }
                var files = ["/static/vendor/echarts/echarts.min.js", "/static/js/chart-kit.js"];
                (function next(i) {
                    if (i >= files.length) { done(); return; }
                    var script = document.createElement("script");
                    script.src = files[i];
                    script.onload = function () { next(i + 1); };
                    script.onerror = function () {
                        L.layer.msg("图表资源加载失败，请检查 /static/vendor/echarts", { icon: 2 });
                    };
                    document.head.appendChild(script);
                })(0);
            }

            L.layer.open({
                type: 1,
                title: '<i class="fas fa-chart-column"></i> 模型 Token 统计',
                area: ["960px", "700px"],
                shadeClose: true,
                content: '<div class="mstats" id="mstatsWrap" style="height:658px;">' +
                    '<div class="mstats-empty"><i class="fas fa-spinner fa-spin"></i> 统计加载中…</div></div>',
                success: function (layero) {
                    var dom = toDom(layero);
                    function render() {
                        api("GET", "/api/admin/models/stats?days=" + days).then(function (d) {
                            var wrap = dom.querySelector("#mstatsWrap");
                            wrap.innerHTML = self.statsHtml(d);
                            // 近 N 日切换：重新拉趋势数据局部刷新
                            wrap.querySelectorAll("[data-days]").forEach(function (btn) {
                                btn.addEventListener("click", function () {
                                    days = parseInt(btn.getAttribute("data-days"), 10);
                                    render();
                                });
                            });
                            ensureCharts(function () { self.renderStatsCharts(d); });
                        });
                    }
                    render();
                },
                end: function () {
                    // 弹层关闭必须回收实例，否则重复打开会残留 canvas 与 ResizeObserver
                    if (window.ChartKit) {
                        window.ChartKit.dispose("#msTrend");
                        window.ChartKit.dispose("#msRank");
                    }
                }
            });
        },

        renderStatsCharts: function (d) {
            var CK = window.ChartKit;
            if (!CK) { return; }
            var trend = d.trend || [];
            CK.renderLine("#msTrend", {
                categories: trend.map(function (t) { return (t.date || "").slice(5); }),
                series: [
                    { name: "输入 Token", data: trend.map(function (t) { return t.prompt || 0; }), area: true, color: "#3f9d42" },
                    { name: "输出 Token", data: trend.map(function (t) { return t.completion || 0; }), area: true, color: "#3b6fe0" }
                ],
                legend: true,
                grid: { left: 56, right: 16, top: 30, bottom: 22 },
                empty: "近 " + (d.days || 14) + " 日暂无调用"
            });
            var rank = (d.ranking || []).map(function (r) {
                return { name: r.name, value: r.token_total || 0 };
            });
            CK.renderRankBar("#msRank", {
                data: rank, suffix: " Token", barMaxWidth: 16, empty: "暂无调用记录，先去测试或对话一轮吧"
            });
        },

        statsHtml: function (d) {
            var s = d.summary || {}, html = "";
            // ① 汇总卡：合计 / 输入 / 输出 / 调用次数
            html += '<div class="mstats-chips">' +
                '<div class="mstats-chip"><div class="k">Token 合计</div><div class="v">' + fmtTokens(s.token_total) + "</div></div>" +
                '<div class="mstats-chip"><div class="k">输入 Token</div><div class="v">' + fmtTokens(s.prompt_total) + "</div></div>" +
                '<div class="mstats-chip"><div class="k">输出 Token</div><div class="v">' + fmtTokens(s.completion_total) + "</div></div>" +
                '<div class="mstats-chip"><div class="k">调用次数</div><div class="v">' + (s.call_count || 0) + "<small> 次</small></div></div>" +
                "</div>";

            // ② 每日用量趋势（ECharts 双折线，数据在 renderStatsCharts 里绘制）
            html += '<div class="mstats-section">' +
                '<div class="mstats-title"><i class="fas fa-chart-area"></i> 每日用量趋势' +
                '<span class="layui-btn-group">' +
                [7, 14, 30].map(function (n) {
                    return '<button type="button" class="layui-btn layui-btn-primary layui-btn-sm mstats-day-btn' +
                        (n === d.days ? " active" : "") + '" data-days="' + n + '">近' + n + "日</button>";
                }).join("") +
                "</span></div>" +
                '<div class="mstats-chart" id="msTrend" style="display:block;position:relative;height:210px;"></div></div>';

            // ③ 模型排行（ECharts 横向条，高度随条目数自适应）
            var rank = d.ranking || [];
            html += '<div class="mstats-section"><div class="mstats-title"><i class="fas fa-ranking-star"></i> 模型用量排行</div>' +
                '<div class="mstats-chart" id="msRank" style="display:block;position:relative;height:' +
                Math.max(130, rank.length * 36 + 26) + 'px;"></div></div>';

            // ④ 最近明细表
            var logs = d.logs || [];
            html += '<div class="mstats-section"><div class="mstats-title"><i class="fas fa-list-ul"></i> 最近调用明细</div>';
            if (logs.length) {
                html += '<div class="mstats-rank" style="padding:4px 16px 10px;"><table class="mstats-table"><thead><tr>' +
                    "<th>模型</th><th>来源</th><th>输入</th><th>输出</th><th>合计</th><th>用户</th><th>时间</th></tr></thead><tbody>" +
                    logs.map(function (l) {
                        return "<tr><td>" + esc(l.name) + "</td>" +
                            '<td><span class="mstats-kind' + (l.kind === "chat" ? " chat" : "") + '">' +
                            (l.kind === "chat" ? "智能体对话" : "模型测试") + "</span></td>" +
                            "<td>" + (l.prompt_tokens || 0) + "</td><td>" + (l.completion_tokens || 0) + "</td>" +
                            "<td><b>" + (l.total_tokens || 0) + "</b></td><td>" + esc(l.username || "-") + "</td>" +
                            "<td>" + esc((l.created_at || "").slice(0, 16)) + "</td></tr>";
                    }).join("") + "</tbody></table></div>";
            } else {
                html += '<div class="mstats-rank"><div class="mstats-empty">暂无明细</div></div>';
            }
            html += "</div>";
            return html;
        },

        /* ============================================================
         * 模型测试弹层
         * ============================================================ */
        openTest: function (m) {
            var self = this;
            var isChat = ["text", "multimodal", "vl"].indexOf(m.type) >= 0;
            var bar =
                '<div class="mtest-bar">' +
                '  <span class="mtest-model">' + esc(m.name) + "<code>" + esc(m.model_id) + "</code></span>" +
                '  <span class="model-badge type">' + esc(m.type_label) + "</span>" +
                '  <span class="spacer"></span>' +
                (isChat && m.thinking
                    ? '<span class="mtest-thinking"><span>思维开关</span><input type="checkbox" id="mtestThinking" lay-skin="switch" lay-text="开|关"></span>'
                    : "") +
                (isChat ? '<button type="button" class="layui-btn layui-btn-sm layui-btn-primary" id="mtestClear"><i class="fas fa-eraser"></i> 清空对话</button>' : "") +
                "</div>";
            var bodyHtml, inputHtml;
            if (isChat) {
                bodyHtml = '<div class="mtest-body" id="mtestBody"><div class="mtest-hint">输入消息开始测试，支持多轮上下文' +
                    (m.thinking ? "；打开「思维开关」可对比模型思考过程" : "") + "</div></div>";
                inputHtml =
                    '<div class="mtest-input">' +
                    ((m.type === "vl" || m.type === "multimodal")
                        ? '<div class="mtest-imgurl"><input type="text" id="mtestImgUrl" placeholder="图片 URL（可选，视觉理解测试）"></div>'
                        : "") +
                    '  <div class="mtest-input-row">' +
                    '    <textarea id="mtestText" placeholder="输入测试消息，Enter 发送 / Shift+Enter 换行"></textarea>' +
                    '    <button type="button" class="layui-btn" id="mtestSend"><i class="fas fa-paper-plane"></i> 发送</button>' +
                    "  </div>" +
                    "</div>";
            } else if (m.type === "embedding") {
                bodyHtml = '<div class="mtest-body" id="mtestBody"><div class="mtest-hint">输入文本，测试嵌入向量的维度与数值预览</div></div>';
                inputHtml =
                    '<div class="mtest-input"><div class="mtest-input-row">' +
                    '  <textarea id="mtestText" placeholder="输入待嵌入的文本"></textarea>' +
                    '  <button type="button" class="layui-btn" id="mtestSend"><i class="fas fa-vector-square"></i> 测试</button>' +
                    "</div></div>";
            } else {
                bodyHtml = '<div class="mtest-body" id="mtestBody"><div class="mtest-hint">输入提示词，测试文生图能力</div></div>';
                inputHtml =
                    '<div class="mtest-input"><div class="mtest-input-row">' +
                    '  <textarea id="mtestText" placeholder="输入图片描述提示词（prompt）"></textarea>' +
                    '  <button type="button" class="layui-btn" id="mtestSend"><i class="fas fa-magic"></i> 生成</button>' +
                    "</div></div>";
            }
            var abortCtrl = null;
            L.layer.open({
                type: 1,
                title: '<i class="fas fa-flask"></i> 模型测试 · ' + esc(m.name),
                area: ["900px", "640px"],
                shadeClose: false,
                content: '<div class="mtest layui-form" lay-filter="mtestForm" style="height:598px;">' + bar + bodyHtml + inputHtml + "</div>",
                success: function (layero) {
                    var dom = toDom(layero);
                    // 思维开关须落在 .layui-form 容器内并按 filter 渲染，否则 layui 不出开关皮肤、降级成原生小复选框
                    L.form.render(null, "mtestForm");
                    var body = dom.querySelector("#mtestBody");
                    var textEl = dom.querySelector("#mtestText");
                    var sendBtn = dom.querySelector("#mtestSend");
                    var messages = []; // 多轮上下文（仅对话类）
                    var busy = false;
                    var usageSeen = false; // 任务8.1：本轮收到 usage 则关闭流后刷新卡片 token

                    function scrollBottom() { body.scrollTop = body.scrollHeight; }
                    function clearHint() {
                        var hint = body.querySelector(".mtest-hint");
                        if (hint) hint.remove();
                    }
                    function setBusy(v) {
                        busy = v;
                        sendBtn.disabled = v;
                        sendBtn.classList.toggle("layui-btn-disabled", v);
                    }

                    if (isChat) {
                        dom.querySelector("#mtestClear").addEventListener("click", function () {
                            if (busy) return;
                            messages = [];
                            body.innerHTML = '<div class="mtest-hint">对话已清空，输入消息开始新的测试</div>';
                        });
                    }

                    function addUserBubble(content) {
                        clearHint();
                        var wrap = document.createElement("div");
                        wrap.className = "mtest-msg user";
                        var shown = typeof content === "string" ? content
                            : (content.filter(function (p) { return p.type === "text"; })[0] || {}).text || "";
                        var imgPart = typeof content === "string" ? null
                            : content.filter(function (p) { return p.type === "image_url"; })[0];
                        wrap.innerHTML = '<div class="mtest-avatar"><i class="fas fa-user"></i></div>' +
                            '<div class="mtest-bubble">' + esc(shown) +
                            (imgPart ? '<br><span style="font-size:11.5px;opacity:.8;">[图片] ' + esc(imgPart.image_url.url) + "</span>" : "") +
                            "</div>";
                        body.appendChild(wrap);
                        scrollBottom();
                    }

                    function newAssistantTurn() {
                        var wrap = document.createElement("div");
                        wrap.className = "mtest-msg assistant";
                        wrap.innerHTML = '<div class="mtest-avatar"><i class="fas fa-robot"></i></div>' +
                            '<div style="max-width:76%;min-width:0;">' +
                            '  <details class="mtest-reasoning" style="display:none;max-width:100%;">' +
                            '    <summary><i class="fas fa-brain"></i> 思考过程</summary>' +
                            '    <div class="reasoning-text"></div>' +
                            "  </details>" +
                            '  <div class="mtest-bubble" style="max-width:100%;"><span class="cursor"></span></div>' +
                            "</div>";
                        body.appendChild(wrap);
                        scrollBottom();
                        return {
                            reasoning: wrap.querySelector(".mtest-reasoning"),
                            reasoningText: wrap.querySelector(".reasoning-text"),
                            bubble: wrap.querySelector(".mtest-bubble"),
                            answer: "", reasoningBuf: "",
                            appendDelta: function (t) {
                                this.answer += t;
                                this.bubble.textContent = this.answer;
                                var c = document.createElement("span");
                                c.className = "cursor";
                                this.bubble.appendChild(c);
                                scrollBottom();
                            },
                            appendReasoning: function (t) {
                                this.reasoning.style.display = "";
                                this.reasoningBuf += t;
                                this.reasoningText.textContent = this.reasoningBuf;
                                scrollBottom();
                            },
                            finish: function () {
                                var c = this.bubble.querySelector(".cursor");
                                if (c) c.remove();
                                if (!this.answer) this.bubble.textContent = "（模型未返回正文）";
                            },
                            showError: function (msg) {
                                var c = this.bubble.querySelector(".cursor");
                                if (c) c.remove();
                                this.bubble.classList.add("error");
                                this.bubble.textContent = msg;
                                scrollBottom();
                            },
                            showUsage: function (u) {
                                var div = document.createElement("div");
                                div.className = "mtest-usage";
                                div.textContent = "tokens：输入 " + (u.prompt_tokens || 0) + " / 输出 " + (u.completion_tokens || 0) + " / 合计 " + (u.total_tokens || 0);
                                body.appendChild(div);
                                scrollBottom();
                            },
                            showNotice: function (msg) {
                                var div = document.createElement("div");
                                div.className = "mtest-usage";
                                div.style.color = "#d99a1b";
                                div.textContent = "提示：" + msg;
                                body.appendChild(div);
                                scrollBottom();
                            }
                        };
                    }

                    // SSE 帧解析：空行切块，取 event 与 data 行
                    function parseSseBlock(block) {
                        var ev = (block.match(/^event:\s*(.+)$/m) || [])[1];
                        var dataLine = block.split("\n").find(function (l) { return l.indexOf("data:") === 0; });
                        if (!ev || dataLine == null) return null;
                        var raw = dataLine.slice(5).trim();
                        var data;
                        try { data = JSON.parse(raw); } catch (e) { data = raw; }
                        return { event: ev.trim(), data: data };
                    }

                    function sendChat() {
                        var text = textEl.value.trim();
                        if (!text || busy) return;
                        var imgUrlEl = dom.querySelector("#mtestImgUrl");
                        var imgUrl = imgUrlEl ? imgUrlEl.value.trim() : "";
                        var content = text;
                        if (imgUrl && (m.type === "vl" || m.type === "multimodal")) {
                            content = [
                                { type: "text", text: text },
                                { type: "image_url", image_url: { url: imgUrl } }
                            ];
                        }
                        messages.push({ role: "user", content: content });
                        addUserBubble(content);
                        textEl.value = "";
                        var thinkEl = dom.querySelector("#mtestThinking");
                        var thinking = thinkEl && thinkEl.checked ? 1 : 0;
                        var turn = newAssistantTurn();
                        setBusy(true);
                        abortCtrl = new AbortController();
                        fetch("/api/admin/models/" + m.id + "/test", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "X-Xsrftoken": xsrf() },
                            body: JSON.stringify({ messages: messages, thinking: thinking }),
                            signal: abortCtrl.signal
                        }).then(function (resp) {
                            if (resp.status === 401) { location.href = "/auth/login"; return; }
                            if (!resp.ok) {
                                return resp.json().then(function (d) { turn.showError((d && d.error) || ("请求失败 " + resp.status)); setBusy(false); });
                            }
                            var reader = resp.body.getReader();
                            var decoder = new TextDecoder();
                            var buf = "";
                            function pump() {
                                return reader.read().then(function (chunk) {
                                    if (chunk.done) { turn.finish(); setBusy(false); return; }
                                    buf += decoder.decode(chunk.value, { stream: true });
                                    var idx;
                                    while ((idx = buf.indexOf("\n\n")) >= 0) {
                                        var block = buf.slice(0, idx);
                                        buf = buf.slice(idx + 2);
                                        var frame = parseSseBlock(block);
                                        if (!frame) continue;
                                        var ev = frame.event, data = frame.data;
                                        if (ev === "delta") turn.appendDelta(typeof data === "string" ? data : (data && data.text) || "");
                                        else if (ev === "reasoning") turn.appendReasoning((data && data.text) || "");
                                        else if (ev === "usage") { usageSeen = true; turn.showUsage(data || {}); }
                                        else if (ev === "notice") turn.showNotice((data && data.message) || "");
                                        else if (ev === "error") turn.showError((data && data.message) || "未知错误");
                                        else if (ev === "done") {
                                            turn.finish();
                                            if (turn.answer) messages.push({ role: "assistant", content: turn.answer });
                                            setBusy(false);
                                            if (usageSeen) { usageSeen = false; self.load(self.page); } // 卡片 token 即时反馈
                                        }
                                    }
                                    return pump();
                                });
                            }
                            return pump();
                        }).catch(function (e) {
                            if (e && e.name === "AbortError") { turn.finish(); }
                            else turn.showError("网络异常：" + e);
                            setBusy(false);
                        });
                    }

                    function sendSimple() {
                        var text = textEl.value.trim();
                        if (!text || busy) return;
                        setBusy(true);
                        clearHint();
                        var payload = m.type === "embedding" ? { text: text } : { prompt: text };
                        abortCtrl = new AbortController();
                        // 测试接口统一为 SSE：一次性结果也走 result/image/error/done 事件流
                        fetch("/api/admin/models/" + m.id + "/test", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "X-Xsrftoken": xsrf() },
                            body: JSON.stringify(payload),
                            signal: abortCtrl.signal
                        }).then(function (resp) {
                            if (!resp.ok) {
                                return resp.json().then(function (d) {
                                    body.insertAdjacentHTML("beforeend", '<div class="mtest-result" style="color:#c0453a;">' + esc((d && d.error) || ("请求失败 " + resp.status)) + "</div>");
                                    setBusy(false);
                                });
                            }
                            return resp.text().then(function (txt) {
                                var blocks = txt.split("\n\n");
                                var shown = false;
                                blocks.forEach(function (block) {
                                    var frame = parseSseBlock(block);
                                    if (!frame) return;
                                    if (frame.event === "result") {
                                        var d = frame.data || {};
                                        body.insertAdjacentHTML("beforeend",
                                            '<div class="mtest-result"><b><i class="fas fa-check-circle" style="color:#67c23a;"></i> 嵌入测试成功</b>' +
                                            "<div>向量维度：<b>" + (d.dim || 0) + "</b>　tokens：" + ((d.usage && d.usage.total_tokens) || 0) + "</div>" +
                                            "<pre>" + esc(JSON.stringify(d.preview || [], null, 2)) + "</pre></div>");
                                        shown = true;
                                        if (d.usage && d.usage.total_tokens) self.load(self.page); // 任务8.1：卡片 token 即时反馈
                                    } else if (frame.event === "image") {
                                        var imgs = (frame.data && frame.data.images) || [];
                                        var html = '<div class="mtest-result"><b><i class="fas fa-check-circle" style="color:#67c23a;"></i> 图片生成成功</b>';
                                        imgs.forEach(function (im) {
                                            var src = im.url || (im.b64 ? "data:image/png;base64," + im.b64 : "");
                                            if (src) html += '<img src="' + esc(src) + '" alt="生成图片">';
                                        });
                                        html += "</div>";
                                        body.insertAdjacentHTML("beforeend", html);
                                        shown = true;
                                    } else if (frame.event === "error") {
                                        body.insertAdjacentHTML("beforeend",
                                            '<div class="mtest-result" style="color:#c0453a;">' + esc((frame.data && frame.data.message) || "测试失败") + "</div>");
                                        shown = true;
                                    }
                                });
                                if (!shown) body.insertAdjacentHTML("beforeend", '<div class="mtest-result" style="color:#c0453a;">未收到有效测试结果</div>');
                                scrollBottom();
                                setBusy(false);
                            });
                        }).catch(function (e) {
                            if (!(e && e.name === "AbortError")) {
                                body.insertAdjacentHTML("beforeend", '<div class="mtest-result" style="color:#c0453a;">网络异常：' + esc(e) + "</div>");
                            }
                            setBusy(false);
                        });
                    }

                    sendBtn.addEventListener("click", isChat ? sendChat : sendSimple);
                    textEl.addEventListener("keydown", function (e) {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            (isChat ? sendChat : sendSimple)();
                        }
                    });
                    textEl.focus();
                },
                end: function () {
                    // 弹层关闭即中断未完成的测试流
                    if (abortCtrl) abortCtrl.abort();
                }
            });
        }
    };

    function boot() {
        if (!/^\/admin\/models\/?$/.test(location.pathname)) return;
        layui.use(["layer", "form", "laypage"], function () {
            L.layer = layui.layer;
            L.form = layui.form;
            L.laypage = layui.laypage;
            ModelModule.init();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();