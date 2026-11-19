/* ============================================================
 * 采集中心（任务6）交互逻辑 —— 独立主页，不使用 layui
 * 三区联动：关键词输入 → 信源选择（可视化参数配置） → 橱窗列表（3列/12条每页）
 * 数据接口：/api/collect/sources | /api/collect/run | /api/collect/items
 * 所有 POST 携带 X-Xsrftoken（取自页面隐藏表单）
 * ============================================================ */
(function () {
    "use strict";

    var PAGE_SIZE = 12;

    var state = {
        sources: [],          // 启用信源 + 占位符元数据
        selected: {},         // sourceId -> true
        page: 1,
        total: 0,
        running: false,
        filterTimer: null
    };

    /* ---------- 基础设施 ---------- */

    function $(id) { return document.getElementById(id); }

    function xsrfToken() {
        var input = document.querySelector('#logoutForm input[name="_xsrf"]');
        return input ? input.value : "";
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function api(path, options) {
        options = options || {};
        options.headers = Object.assign({ "X-Xsrftoken": xsrfToken() }, options.headers || {});
        if (options.body && typeof options.body !== "string") {
            options.body = JSON.stringify(options.body);
            options.headers["Content-Type"] = "application/json";
        }
        return fetch(path, options).then(function (resp) {
            return resp.json().catch(function () { return { ok: false, error: "响应不是合法 JSON" }; })
                .then(function (data) {
                    if (!resp.ok || data.ok === false) {
                        throw new Error(data.error || ("请求失败（" + resp.status + "）"));
                    }
                    return data;
                });
        });
    }

    function toast(msg, type) {
        var box = $("toastBox");
        var el = document.createElement("div");
        el.className = "toast " + (type || "");
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(function () {
            el.classList.add("out");
            setTimeout(function () { el.remove(); }, 320);
        }, 4200);
    }

    function setStatus(text, cls) {
        var el = $("collectStatus");
        el.textContent = text;
        el.className = "collect-status" + (cls ? " " + cls : "");
    }

    function setLoading(on, text) {
        $("loadingOverlay").classList.toggle("hidden", !on);
        if (text) { $("loadingText").textContent = text; }
        $("runBtn").disabled = on;
    }

    /* ---------- ② 信源选择区 ---------- */

    function loadSources() {
        return api("/api/collect/sources").then(function (data) {
            state.sources = data.list || [];
            renderSources();
            renderFilterOptions();
        }).catch(function (e) { toast("信源加载失败：" + e.message, "err"); });
    }

    function renderSources() {
        var grid = $("sourceGrid");
        grid.innerHTML = "";
        if (!state.sources.length) {
            grid.innerHTML = '<div class="source-empty">暂无启用的信源，请先到 <a href="/admin/sources">后台 · 信源管理</a> 新增并启用信源。</div>';
            updateSourceCount();
            return;
        }
        state.sources.forEach(function (s) {
            var card = document.createElement("div");
            card.className = "source-card" + (state.selected[s.id] ? " selected" : "");
            card.dataset.id = s.id;

            var tags = (s.placeholders || []).map(function (p) {
                if (p.kind === "param") { return '<span class="ph-tag param"><i class="fas fa-sliders-h"></i> 参数 · ' + escapeHtml(p.name) + "</span>"; }
                if (p.kind === "keyword") { return '<span class="ph-tag"><i class="fas fa-key"></i> 关键词 · 自动</span>'; }
                return '<span class="ph-tag"><i class="fas fa-layer-group"></i> 分页 · 自动</span>';
            }).join("");

            var params = (s.placeholders || []).filter(function (p) { return p.kind === "param"; });
            var paramRows = params.map(function (p) {
                return '<div class="param-row"><label title="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + '</label>' +
                    '<input type="text" data-param="' + escapeHtml(p.name) + '" placeholder="请输入 ' + escapeHtml(p.name) + '" autocomplete="off"></div>';
            }).join("");

            card.innerHTML =
                '<span class="check-mark"><i class="fas fa-check"></i></span>' +
                '<div class="source-name">' + escapeHtml(s.name) + "</div>" +
                '<div class="source-host"><i class="fas fa-globe"></i> ' + escapeHtml(s.host || "—") + "</div>" +
                (s.description ? '<div class="source-desc">' + escapeHtml(s.description) + "</div>" : "") +
                (tags ? '<div class="source-tags">' + tags + "</div>" : "") +
                '<div class="param-panel' + (params.length ? " has-params" : "") + '">' +
                    '<div class="param-panel-title"><i class="fas fa-sliders-h"></i> 参数配置</div>' + paramRows +
                "</div>";

            card.addEventListener("click", function (ev) {
                // 参数输入框内的点击不触发选中切换
                if (ev.target.closest(".param-panel")) { return; }
                state.selected[s.id] = !state.selected[s.id];
                card.classList.toggle("selected", !!state.selected[s.id]);
                updateSourceCount();
            });
            grid.appendChild(card);
        });
        updateSourceCount();
    }

    function updateSourceCount() {
        var n = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).length;
        $("sourceCount").textContent = "已选 " + n + " 个";
    }

    function selectedSources() {
        return state.sources.filter(function (s) { return state.selected[s.id]; });
    }

    function collectParams(sourceId) {
        var card = document.querySelector('.source-card[data-id="' + sourceId + '"]');
        var params = {};
        if (!card) { return params; }
        card.querySelectorAll(".param-panel input[data-param]").forEach(function (input) {
            params[input.dataset.param] = input.value.trim();
        });
        return params;
    }

    function renderFilterOptions() {
        var sel = $("filterSource");
        var current = sel.value;
        sel.innerHTML = '<option value="">全部信源</option>';
        state.sources.forEach(function (s) {
            var opt = document.createElement("option");
            opt.value = s.id;
            opt.textContent = s.name;
            sel.appendChild(opt);
        });
        sel.value = current;
    }

    /* ---------- 启动采集 ---------- */

    function runCollect() {
        if (state.running) { return; }
        var keyword = $("keywordInput").value.trim();
        if (!keyword) { toast("请先输入采集关键词", "warn"); $("keywordInput").focus(); return; }
        var chosen = selectedSources();
        if (!chosen.length) { toast("请至少勾选一个信源", "warn"); return; }

        // 可视化参数配置校验：选中信源的自定义参数必填
        var params = {};
        for (var i = 0; i < chosen.length; i++) {
            var s = chosen[i];
            var sp = collectParams(s.id);
            var need = (s.placeholders || []).filter(function (p) { return p.kind === "param"; });
            for (var j = 0; j < need.length; j++) {
                if (!sp[need[j].name]) {
                    toast("信源「" + s.name + "」缺少参数：" + need[j].name, "warn");
                    var input = document.querySelector('.source-card[data-id="' + s.id + '"] input[data-param="' + need[j].name + '"]');
                    if (input) { input.focus(); }
                    return;
                }
            }
            params[s.id] = sp;
        }

        state.running = true;
        var useLlm = $("useLlm").checked;
        var started = Date.now();
        var updateElapsed = function () {
            var elapsed = Math.floor((Date.now() - started) / 1000);
            $("loadingDetail").textContent = "正在抓取和解析，已用时 " + elapsed + " 秒";
        };
        updateElapsed();
        var elapsedTimer = setInterval(updateElapsed, 1000);
        setLoading(true, "正在采集 · " + chosen.length + " 个信源");
        setStatus("采集中 · 关键词「" + keyword + "」 · " + chosen.map(function (s) { return s.name; }).join(" / "));

        api("/api/collect/run", {
            method: "POST",
            body: {
                keyword: keyword,
                source_ids: chosen.map(function (s) { return s.id; }),
                params: params,
                page_index: 1,
                use_llm: useLlm
            }
        }).then(function (data) {
            var newTotal = data.new_total || 0;
            var failures = [];
            var fetchedTotal = 0;
            (data.results || []).forEach(function (r) {
                if (r.ok) {
                    fetchedTotal += r.fetched;
                    var engine = ({ llm: "AI 智能体解析", rss: "RSS 解析", heuristic: "规则解析" })[r.engine] || "解析";
                    toast("「" + r.source_name + "」采集完成：解析 " + r.fetched + " 条，新增 " + r.new + " 条（" + engine + "）", "ok");
                    if (r.llm_error) { toast("「" + r.source_name + "」大模型不可用已回退规则解析", "warn"); }
                } else {
                    failures.push(r.source_name + "：" + r.error);
                    toast("「" + r.source_name + "」采集失败：" + r.error, "err");
                }
            });
            var summary = "采集完成 · 解析 " + fetchedTotal + " 条 · 新增 " + newTotal + " 条";
            if (failures.length) {
                summary += " · 失败 " + failures.length + " 个信源 · " + failures.join("；");
            }
            setStatus(summary, failures.length ? "err" : (newTotal > 0 ? "ok" : ""));
            state.page = 1;
            return loadItems(1);
        }).catch(function (e) {
            setStatus("采集失败：" + e.message, "err");
            toast("采集失败：" + e.message, "err");
        }).finally(function () {
            clearInterval(elapsedTimer);
            state.running = false;
            setLoading(false);
        });
    }

    /* ---------- ③ 采集数据橱窗列表 ---------- */

    function loadItems(page) {
        state.page = Math.max(1, page || 1);
        var qs = "?page=" + state.page;
        var kw = $("filterKeyword").value.trim();
        var sid = $("filterSource").value;
        if (kw) { qs += "&keyword=" + encodeURIComponent(kw); }
        if (sid) { qs += "&source_id=" + encodeURIComponent(sid); }
        return api("/api/collect/items" + qs).then(function (data) {
            state.total = data.total || 0;
            renderShowcase(data.list || []);
            renderPager();
            $("dataTotal").textContent = "共 " + state.total + " 条 · " + PAGE_SIZE + " 条/页";
        }).catch(function (e) { toast("列表加载失败：" + e.message, "err"); });
    }

    function renderShowcase(list) {
        var box = $("showcase");
        box.innerHTML = "";
        $("emptyTip").classList.toggle("show", !list.length);
        list.forEach(function (it) {
            var card = document.createElement("article");
            card.className = "show-card";

            var coverHtml = it.cover
                ? '<img src="' + escapeHtml(it.cover) + '" alt="" loading="lazy">'
                : '<div class="cover-fallback"><i class="fas fa-newspaper"></i></div>';
            var titleHtml = it.url
                ? '<a href="' + escapeHtml(it.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(it.title) + "</a>"
                : escapeHtml(it.title);
            var time = it.published_at || it.collected_at || "";

            card.innerHTML =
                '<div class="show-cover">' + coverHtml +
                    '<span class="show-source-badge">' + escapeHtml(it.source_name || "未知信源") + "</span>" +
                "</div>" +
                '<div class="show-body">' +
                    '<div class="show-title" title="' + escapeHtml(it.title) + '">' + titleHtml + "</div>" +
                    '<div class="show-meta">' +
                        '<i class="far fa-clock"></i><span class="show-time">' + escapeHtml(time) + "</span>" +
                        (it.keyword ? '<span class="show-keyword" title="' + escapeHtml(it.keyword) + '">' + escapeHtml(it.keyword) + "</span>" : "") +
                    "</div>" +
                "</div>";

            // 封面加载失败兜底：外链图可能失效，替换为科技感占位封面
            var img = card.querySelector(".show-cover img");
            if (img) {
                img.addEventListener("error", function () {
                    img.outerHTML = '<div class="cover-fallback"><i class="fas fa-newspaper"></i></div>';
                });
            }
            box.appendChild(card);
        });
    }

    function renderPager() {
        var pager = $("pager");
        pager.innerHTML = "";
        var pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
        if (state.total === 0) { return; }

        function btn(label, page, opts) {
            opts = opts || {};
            var b = document.createElement("button");
            b.type = "button";
            b.className = "pager-btn" + (opts.active ? " active" : "");
            b.textContent = label;
            b.disabled = !!opts.disabled;
            if (!opts.disabled && !opts.active) {
                b.addEventListener("click", function () { loadItems(page); });
            }
            pager.appendChild(b);
        }

        btn("‹", state.page - 1, { disabled: state.page <= 1 });
        // 页码窗口：首尾 + 当前页前后各 1 页，其余折叠为省略号
        var nums = [];
        for (var p = 1; p <= pages; p++) {
            if (p === 1 || p === pages || Math.abs(p - state.page) <= 1) { nums.push(p); }
        }
        var last = 0;
        nums.forEach(function (p) {
            if (p - last > 1) {
                var dots = document.createElement("span");
                dots.className = "pager-ellipsis";
                dots.textContent = "…";
                pager.appendChild(dots);
            }
            btn(String(p), p, { active: p === state.page });
            last = p;
        });
        btn("›", state.page + 1, { disabled: state.page >= pages });
    }

    /* ---------- 事件绑定与初始化 ---------- */

    $("runBtn").addEventListener("click", runCollect);
    $("keywordInput").addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { runCollect(); }
    });
    $("refreshBtn").addEventListener("click", function () { loadItems(state.page); });
    $("filterSource").addEventListener("change", function () { loadItems(1); });
    $("filterKeyword").addEventListener("input", function () {
        clearTimeout(state.filterTimer);
        state.filterTimer = setTimeout(function () { loadItems(1); }, 400);
    });
    $("logoutLink").addEventListener("click", function () { $("logoutForm").submit(); });

    loadSources();
    loadItems(1);
})();
