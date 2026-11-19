/*
 * qa.js —— 智能问数页前端逻辑（成员 D，任务1核心）
 * 1. GET  /api/assistants        数字员工下拉（与对话页同源，选中项随问数请求提交）
 * 2. POST /api/qa/ask            提问 → 报告契约 {title,summary,metrics,chart,insights,advice,source,...}
 * 3. GET  /api/qa/history        问数历史（点击回放）
 * 4. GET  /api/qa/report/<id>    单条完整报告
 * 图表为零依赖 canvas 手绘（bar/line），字段非法时自动隐藏图表区，不抛错。
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
        el.className = "qa-toast" + (isError ? " is-error" : "");
        el.textContent = text;
        document.body.appendChild(el);
        setTimeout(function () { el.style.opacity = "0"; }, 1800);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2150);
    }

    var assistants = [];
    var busy = false;

    async function loadAssistants() {
        try {
            var resp = await fetch("/api/assistants");
            if (!resp.ok) return;
            var d = await resp.json();
            assistants = d.list || [];
            var sel = $("qaAssistant");
            sel.innerHTML = assistants.map(function (a) {
                return '<option value="' + esc(a.id) + '"' +
                    (d.selected && d.selected.id === a.id ? " selected" : "") + ">" + esc(a.name) +
                    (a.is_default ? "（默认）" : "") + "</option>";
            }).join("");
            if (!assistants.length) sel.innerHTML = '<option value="">跟随系统默认</option>';
        } catch (e) { /* 拉取失败保持空下拉，问数仍可不指定员工 */ }
    }

    // ---------- canvas 手绘图表（bar / line） ----------
    function drawChart(canvas, chart) {
        var labels = (chart && chart.labels) || [];
        var values = (chart && chart.values) || [];
        if (!labels.length || labels.length !== values.length) { canvas.style.display = "none"; return; }
        canvas.style.display = "";
        var dpr = window.devicePixelRatio || 1;
        var W = canvas.clientWidth || 640, H = 260;
        canvas.width = W * dpr; canvas.height = H * dpr;
        var ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, W, H);
        var padL = 44, padR = 16, padT = 18, padB = 42;
        var maxV = Math.max.apply(null, values.concat([1]));
        var innerW = W - padL - padR, innerH = H - padT - padB;

        // 轴与网格
        ctx.strokeStyle = "#dfe5ee"; ctx.fillStyle = "#8a94a6";
        ctx.font = "11px sans-serif"; ctx.lineWidth = 1;
        for (var g = 0; g <= 4; g++) {
            var gy = padT + innerH - innerH * g / 4;
            ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
            ctx.textAlign = "right";
            ctx.fillText(String(Math.round(maxV * g / 4)), padL - 6, gy + 4);
        }
        // 数据
        var step = innerW / labels.length;
        if (chart.type === "line") {
            ctx.strokeStyle = "#1e9fff"; ctx.lineWidth = 2; ctx.beginPath();
            values.forEach(function (v, i) {
                var x = padL + step * (i + 0.5), y = padT + innerH - innerH * (v / maxV);
                i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
            ctx.stroke();
            ctx.fillStyle = "#1e5eff";
            values.forEach(function (v, i) {
                var x = padL + step * (i + 0.5), y = padT + innerH - innerH * (v / maxV);
                ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
            });
        } else {
            ctx.fillStyle = "#4e9cef";
            values.forEach(function (v, i) {
                var bw = Math.min(step * 0.55, 46);
                var x = padL + step * i + (step - bw) / 2;
                var bh = innerH * (v / maxV);
                ctx.fillRect(x, padT + innerH - bh, bw, bh);
            });
        }
        // x 轴标签（超 8 个截断省略号）
        ctx.fillStyle = "#5a6b81"; ctx.textAlign = "center";
        labels.forEach(function (l, i) {
            var text = String(l);
            if (text.length > 8) text = text.slice(0, 7) + "…";
            ctx.fillText(text, padL + step * (i + 0.5), H - padB + 18);
        });
        // 指标名
        if (chart.name) {
            ctx.fillStyle = "#8a94a6"; ctx.textAlign = "left";
            ctx.fillText(chart.name, padL, 12);
        }
    }

    // ---------- 报告渲染 ----------
    function renderReport(meta, r) {
        var box = $("qaReport");
        var sourceBadge = r.source === "model"
            ? '<span class="qa-badge qa-badge-model"><i class="fas fa-brain"></i> 模型分析' +
              (r.model ? "・" + esc(r.model) : "") + "</span>"
            : '<span class="qa-badge qa-badge-rule"><i class="fas fa-calculator"></i> 统计直出（模型暂不可用）</span>';
        var metrics = (r.metrics || []).map(function (m) {
            return '<div class="qa-metric"><b>' + esc(m.value) + '</b><span>' + esc(m.unit || "") + "</span>" +
                '<i>' + esc(m.name) + "</i></div>";
        }).join("");
        var insights = (r.insights || []).map(function (t) {
            return "<li>" + esc(t) + "</li>";
        }).join("");
        box.innerHTML =
            '<div class="qa-report-head">' +
            "  <h2>" + esc(r.title || "问数报告") + "</h2>" + sourceBadge +
            '  <div class="qa-report-meta">问题：' + esc(meta && meta.question || "—") +
                "　数字员工：" + esc(meta && meta.employee_name || "默认") +
                "　生成时间：" + esc(r.generated_at || meta && meta.created_at || "") + "</div>" +
            "</div>" +
            '<p class="qa-summary">' + esc(r.summary || "") + "</p>" +
            (metrics ? '<div class="qa-metrics">' + metrics + "</div>" : "") +
            '<div class="qa-chart-card"><canvas id="qaChart" width="640" height="260"></canvas></div>' +
            (insights ? '<div class="qa-insights"><div class="qa-block-title"><i class="fas fa-lightbulb"></i> 关键洞察</div><ul>' + insights + "</ul></div>" : "") +
            (r.advice ? '<div class="qa-advice"><i class="fas fa-comment-dots"></i> ' + esc(r.advice) + "</div>" : "");
        drawChart($("qaChart"), r.chart || {});
        box.scrollTop = 0;
    }

    function setBusy(b) {
        busy = b;
        var btn = $("qaAskBtn");
        btn.disabled = b;
        btn.innerHTML = b ? '<i class="fas fa-spinner fa-spin"></i> 分析中…'
                          : '<i class="fas fa-magic"></i> 开始问数';
    }

    async function ask() {
        if (busy) return;
        var question = $("qaInput").value.trim();
        if (!question) { toast("请先输入问题", true); return; }
        setBusy(true);
        try {
            var resp = await fetch("/api/qa/ask", {
                method: "POST",
                headers: { "X-Xsrftoken": xsrfToken(), "Content-Type": "application/json" },
                body: JSON.stringify({
                    question: question,
                    employee_id: $("qaAssistant").value ? parseInt($("qaAssistant").value, 10) : null,
                }),
            });
            if (resp.status === 401) { location.href = "/auth/login"; return; }
            var d = await resp.json().catch(function () { return {}; });
            if (!resp.ok || !d.ok) { toast(d.error || ("问数失败 " + resp.status), true); return; }
            renderReport({ question: question, employee_name: "" }, d.report);
            loadHistory();
        } catch (e) {
            toast("问数出错：" + e.message, true);
        } finally {
            setBusy(false);
        }
    }

    async function loadHistory() {
        try {
            var resp = await fetch("/api/qa/history");
            if (!resp.ok) return;
            var d = await resp.json();
            var list = d.list || [];
            $("qaHistory").innerHTML = list.length
                ? list.map(function (h) {
                    return '<button type="button" class="qa-history-item" data-id="' + esc(h.id) + '">' +
                        '<span class="qa-history-q">' + esc(h.title || h.question) + "</span>" +
                        '<span class="qa-history-time">' + esc((h.created_at || "").slice(5, 16)) + "</span></button>";
                }).join("")
                : '<div class="qa-muted">暂无问数记录</div>';
        } catch (e) { /* 历史失败不影响主链路 */ }
    }

    async function openReport(id) {
        try {
            var resp = await fetch("/api/qa/report/" + encodeURIComponent(id));
            if (!resp.ok) { toast("报告不存在或已删除", true); return; }
            var d = await resp.json();
            var row = d.report || {};
            renderReport({ question: row.question, employee_name: row.employee_name }, row.report || {});
        } catch (e) { toast("读取报告失败", true); }
    }

    function init() {
        $("qaAskBtn").addEventListener("click", ask);
        $("qaInput").addEventListener("keydown", function (e) {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ask();
        });
        Array.prototype.forEach.call(document.querySelectorAll(".qa-quick-item"), function (btn) {
            btn.addEventListener("click", function () {
                $("qaInput").value = btn.getAttribute("data-q");
                ask();
            });
        });
        $("qaHistory").addEventListener("click", function (e) {
            var item = e.target.closest("[data-id]");
            if (item) openReport(item.getAttribute("data-id"));
        });
        window.addEventListener("resize", function () {
            var canvas = $("qaChart");
            if (canvas && canvas.style.display !== "none" && lastReport) drawChart(canvas, lastReport.chart || {});
        });
        loadAssistants();
        loadHistory();
    }

    // 记录最近一次报告供 resize 重绘
    var lastReport = null;
    var _renderReport = renderReport;
    renderReport = function (meta, r) { lastReport = r; _renderReport(meta, r); };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
