/*
 * employees.js —— 数字员工管理前端逻辑（表现层，任务9）
 * 由 templates/admin/employees.html 引入（admin.js 只负责后台壳），负责：
 *   1. 橱窗列表：一行 4 列、12 条/页（参考模型引擎橱窗实现），
 *      卡片含头像/默认标记/工具数/关联md数/提示词预览/启停开关/快捷操作
 *   2. 新增/编辑弹层（layui form）：instructions Markdown 可视化编辑器
 *      （工具栏插入 + 编辑/分栏/预览三态，纯手写渲染器零第三方库）、
 *      多 md 文件关联（workspace 文件浏览下钻选取）、工具链路动态复选、
 *      RAG 知识文档绑定、工作空间目录配置、头像图标选择
 *   3. 启停开关 / 删除确认 / 设为默认（默认员工 = 前台对话使用）
 *   4. 所有请求带 X-Xsrftoken（取自后台退出登录隐藏表单），与后端 xsrf_cookies=True 对齐，
 *      DELETE 同样必须携带 token（admin.css/base 约定）
 */
(function () {
    "use strict";

    var PAGE_SIZE = 12;
    function $(id) { return document.getElementById(id); }
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
     * Markdown 渲染器（编辑器预览用，纯手写零依赖）
     * 支持：围栏代码块/ATX标题/列表/引用/分隔线/表格/段落 + 行内
     *       粗体/斜体/删除线/行内代码/链接；全部先转义再拼装防 XSS
     * ============================================================ */
    function inlineMd(s) {
        s = s.replace(/`([^`]+)`/g, function (m, c) { return "<code>" + c + "</code>"; });
        s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
        s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
        s = s.replace(/\*([^*<]+)\*/g, "<i>$1</i>");
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener">$1</a>');
        return s;
    }
    function renderMarkdown(md) {
        var text = esc(md || "");
        var blocks = [];
        // 围栏代码块先行抽出，内部内容不再参与后续解析
        text = text.replace(/```([\s\S]*?)```/g, function (m, code) {
            blocks.push("<pre><code>" + code.replace(/^\n/, "").replace(/\n$/, "") + "</code></pre>");
            return "\u0001" + (blocks.length - 1) + "\u0001";
        });
        var lines = text.split("\n"), out = [], i = 0;
        function inline(line) { return inlineMd(line); }
        while (i < lines.length) {
            var line = lines[i];
            if (/^\u0001\d+\u0001$/.test(line.trim())) {
                out.push(blocks[parseInt(line.trim().slice(1, -1), 10)]);
                i++; continue;
            }
            var h = line.match(/^(#{1,4})\s+(.*)$/);
            if (h) { out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
            if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
            if (/^&gt;\s?/.test(line)) {
                var bq = [];
                while (i < lines.length && /^&gt;\s?/.test(lines[i])) { bq.push(inline(lines[i].replace(/^&gt;\s?/, ""))); i++; }
                out.push("<blockquote>" + bq.join("<br>") + "</blockquote>"); continue;
            }
            if (/^\s*[-*]\s+/.test(line)) {
                var ul = [];
                while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { ul.push("<li>" + inline(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>"); i++; }
                out.push("<ul>" + ul.join("") + "</ul>"); continue;
            }
            if (/^\s*\d+\.\s+/.test(line)) {
                var ol = [];
                while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { ol.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>"); i++; }
                out.push("<ol>" + ol.join("") + "</ol>"); continue;
            }
            if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
                var cells = function (l) {
                    return l.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
                };
                var thead = cells(line), tbl = ["<table><thead><tr>" + thead.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead><tbody>"];
                i += 2;
                while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
                    tbl.push("<tr>" + cells(lines[i]).map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>");
                    i++;
                }
                tbl.push("</tbody></table>");
                out.push(tbl.join("")); continue;
            }
            if (!line.trim()) { i++; continue; }
            var para = [];
            while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|&gt;|\||\u0001)/.test(lines[i].trim()) && !/^\s*(---+|\*\*\*+)\s*$/.test(lines[i])) {
                para.push(inline(lines[i])); i++;
            }
            out.push("<p>" + para.join("<br>") + "</p>");
        }
        return out.join("");
    }

    /* ============================================================
     * Markdown 编辑器（工具栏对 textarea 选区做包裹/行前缀插入）
     * ============================================================ */
    var MdEditor = {
        html: function (id, value) {
            var btn = function (act, icon, title) {
                return '<button type="button" data-md="' + act + '" title="' + title + '"><i class="' + icon + '"></i></button>';
            };
            return '<div class="emp-md-editor" id="' + id + '-wrap">' +
                '<div class="emp-md-bar">' +
                btn("h2", "fas fa-heading", "标题") + btn("bold", "fas fa-bold", "加粗") +
                btn("italic", "fas fa-italic", "斜体") + btn("strike", "fas fa-strikethrough", "删除线") +
                btn("code", "fas fa-code", "行内代码") + btn("link", "fas fa-link", "链接") +
                '<span class="sep"></span>' +
                btn("ul", "fas fa-list-ul", "无序列表") + btn("ol", "fas fa-list-ol", "有序列表") +
                btn("quote", "fas fa-quote-left", "引用") + btn("table", "fas fa-table", "表格") +
                btn("block", "fas fa-clone", "代码块") +
                '<span class="spacer"></span>' +
                '<button type="button" data-md="mode-edit" class="mode-on">编辑</button>' +
                '<button type="button" data-md="mode-split">分栏</button>' +
                '<button type="button" data-md="mode-preview">预览</button>' +
                "</div>" +
                '<div class="emp-md-area">' +
                '<textarea id="' + id + '-text" placeholder="输入 Markdown 格式的系统提示词（人设 / 行为规范 / 自我认知）">' + esc(value) + "</textarea>" +
                '<div class="emp-md-preview" id="' + id + '-prev"></div>' +
                "</div></div>";
        },
        bind: function (id) {
            var wrap = $(id + "-wrap"), ta = $(id + "-text"), prev = $(id + "-prev");
            function sync() { prev.innerHTML = renderMarkdown(ta.value) || '<p style="color:#a5aebb;">（预览为空）</p>'; }
            function setMode(m) {
                wrap.classList.remove("split", "preview-only");
                if (m !== "edit") wrap.classList.add(m === "split" ? "split" : "preview-only");
                wrap.querySelectorAll("[data-md^=mode]").forEach(function (b) {
                    b.classList.toggle("mode-on", b.getAttribute("data-md") === "mode-" + m);
                });
                sync();
            }
            function surround(l, r, ph) {
                var s = ta.selectionStart, e = ta.selectionEnd;
                var sel = ta.value.slice(s, e) || ph;
                ta.value = ta.value.slice(0, s) + l + sel + r + ta.value.slice(e);
                ta.focus();
                ta.setSelectionRange(s + l.length, s + l.length + sel.length);
                sync();
            }
            function linePrefix(prefix) {
                var s = ta.selectionStart;
                var ls = ta.value.lastIndexOf("\n", s - 1) + 1;
                ta.value = ta.value.slice(0, ls) + prefix + ta.value.slice(ls);
                ta.focus();
                ta.setSelectionRange(s + prefix.length, s + prefix.length);
                sync();
            }
            function insert(text) {
                var s = ta.selectionStart;
                ta.value = ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd);
                ta.focus();
                ta.setSelectionRange(s + text.length, s + text.length);
                sync();
            }
            wrap.querySelector(".emp-md-bar").addEventListener("click", function (e) {
                var b = e.target.closest("[data-md]");
                if (!b) return;
                var act = b.getAttribute("data-md");
                if (act === "mode-edit") return setMode("edit");
                if (act === "mode-split") return setMode("split");
                if (act === "mode-preview") return setMode("preview");
                if (act === "h2") return linePrefix("## ");
                if (act === "bold") return surround("**", "**", "加粗文本");
                if (act === "italic") return surround("*", "*", "斜体文本");
                if (act === "strike") return surround("~~", "~~", "删除文本");
                if (act === "code") return surround("`", "`", "code");
                if (act === "link") return surround("[", "](https://)", "链接文字");
                if (act === "ul") return linePrefix("- ");
                if (act === "ol") return linePrefix("1. ");
                if (act === "quote") return linePrefix("> ");
                if (act === "table") return insert("\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n");
                if (act === "block") return insert("\n```\n代码块\n```\n");
            });
            ta.addEventListener("input", sync);
            return { getText: function () { return ta.value; }, setMode: setMode };
        }
    };

    /* ============================================================
     * workspace 文件浏览弹层（关联 md 文件到 instructions）
     * ============================================================ */
    var Browse = {
        open: function (rootDom, onPick, startPath) {
            var path = startPath || "";
            var idx = L.layer.open({
                type: 1,
                title: '<i class="fas fa-folder-open"></i> 浏览 workspace 目录（选择要关联的 .md 文件）',
                area: ["680px", "520px"],
                shadeClose: true,
                content: '<div class="emp-browse">' +
                    '<div class="emp-browse-path"><i class="fas fa-map-marker-alt"></i> workspace / <code id="empBrowsePath">（根目录）</code>' +
                    '<button type="button" class="layui-btn layui-btn-primary layui-btn-sm" id="empBrowseUp" style="margin-left:auto;"><i class="fas fa-level-up-alt"></i> 上级</button></div>' +
                    '<div class="emp-browse-main" id="empBrowseMain"><div class="emp-browse-empty"><i class="fas fa-spinner fa-spin"></i> 加载中…</div></div></div>',
                success: function (layero) {
                    var dom = toDom(layero);
                    var main = dom.querySelector("#empBrowseMain");
                    var pathEl = dom.querySelector("#empBrowsePath");
                    function load(p) {
                        path = p || "";
                        pathEl.textContent = path ? path + "/" : "（根目录）";
                        api("GET", "/api/admin/employees/files?path=" + encodeURIComponent(path)).then(function (d) {
                            var html = "";
                            if (path) {
                                html += '<div class="emp-browse-item dir" data-dir="' + esc(path.split("/").slice(0, -1).join("/")) + '">' +
                                    '<i class="fas fa-level-up-alt"></i> ..（上级）</div>';
                            }
                            (d.dirs || []).forEach(function (dir) {
                                html += '<div class="emp-browse-item dir" data-dir="' + esc(dir) + '">' +
                                    '<i class="fas fa-folder"></i> ' + esc(dir.split("/").pop()) + "</div>";
                            });
                            (d.mds || []).forEach(function (f) {
                                html += '<div class="emp-browse-item md"><i class="fab fa-markdown"></i> ' +
                                    esc(f.path) + '<span class="size">' + (f.size > 1024 ? (f.size / 1024).toFixed(1) + " KB" : f.size + " B") + "</span>" +
                                    '<button type="button" class="layui-btn layui-btn-sm" data-link="' + esc(f.path) + '"><i class="fas fa-link"></i> 关联</button></div>';
                            });
                            main.innerHTML = html || '<div class="emp-browse-empty"><i class="fas fa-inbox"></i> 该目录暂无子目录 / md 文件</div>';
                        }).catch(function () {
                            main.innerHTML = '<div class="emp-browse-empty"><i class="fas fa-exclamation-triangle"></i> 目录读取失败</div>';
                        });
                    }
                    main.addEventListener("click", function (e) {
                        var dir = e.target.closest("[data-dir]");
                        if (dir) return load(dir.getAttribute("data-dir"));
                        var link = e.target.closest("[data-link]");
                        if (link) {
                            onPick(link.getAttribute("data-link"));
                            L.layer.msg("已加入关联清单，保存后生效", { icon: 1 });
                        }
                    });
                    dom.querySelector("#empBrowseUp").addEventListener("click", function () {
                        if (!path) return;
                        var parts = path.split("/");
                        parts.pop();
                        load(parts.join("/"));
                    });
                    load("");
                }
            });
            return idx;
        }
    };

    /* ============================================================
     * 橱窗列表模块
     * ============================================================ */
    var EmployeeModule = {
        page: 1, keyword: "", status: "", rowCache: {},

        init: function () {
            var self = this;
            $("empSearch").addEventListener("click", function () {
                self.keyword = $("empKeyword").value.trim();
                self.load(1);
            });
            $("empReset").addEventListener("click", function () {
                $("empKeyword").value = "";
                self.keyword = "";
                self.status = "";
                $("empStatus").value = "";
                L.form.render("select");
                self.load(1);
            });
            $("empKeyword").addEventListener("keydown", function (e) {
                if (e.key === "Enter") $("empSearch").click();
            });
            $("empAdd").addEventListener("click", function () { self.openForm(null); });
            L.form.on("select(empStatus)", function (data) {
                self.status = data.value;
                self.load(1);
            });
            // 卡片快捷操作：事件委托
            $("empGrid").addEventListener("click", function (e) {
                var btn = e.target.closest("[data-act]");
                if (!btn) return;
                var id = parseInt(btn.getAttribute("data-id"), 10);
                var row = self.rowCache[id];
                if (!row) return;
                var act = btn.getAttribute("data-act");
                if (act === "edit") self.openDetail(row);
                else if (act === "default") self.setDefault(row);
                else if (act === "del") self.del(row);
            });
            this.load(1);
        },

        load: function (page) {
            var self = this;
            this.page = page || 1;
            var url = "/api/admin/employees?page=" + this.page +
                "&keyword=" + encodeURIComponent(this.keyword) +
                "&status=" + encodeURIComponent(this.status);
            return api("GET", url).then(function (d) {
                $("empCount").textContent = d.total;
                self.rowCache = {};
                var html = "";
                (d.list || []).forEach(function (m) {
                    self.rowCache[m.id] = m;
                    html += self.cardHtml(m);
                });
                $("empGrid").innerHTML = html ||
                    '<div class="emp-grid-empty"><i class="fas fa-user-astronaut"></i> 暂无数字员工，点击「新增数字员工」创建第一位智能体</div>';
                L.laypage.render({
                    elem: "empPager",
                    count: d.total,
                    limit: PAGE_SIZE,
                    curr: self.page,
                    layout: ["count", "prev", "page", "next", "skip"],
                    jump: function (obj, first) { if (!first) self.load(obj.curr); }
                });
                // 卡片启停开关：每张卡片是一个独立 .layui-form 容器（lay-filter=empCard<id>），
                // 按容器 filter 分别渲染，否则 layui 不出开关皮肤（同 models.js 思维开关的坑）
                $("empGrid").querySelectorAll(".emp-card.layui-form").forEach(function (box) {
                    L.form.render("checkbox", box.getAttribute("lay-filter"));
                });
            }).catch(function () {
                $("empGrid").innerHTML = '<div class="emp-grid-empty"><i class="fas fa-exclamation-triangle"></i> 加载失败，请刷新重试</div>';
            });
        },

        cardHtml: function (m) {
            var badges = "";
            if (m.is_default) badges += '<span class="emp-badge default"><i class="fas fa-star"></i> 默认员工</span>';
            var toolCount = (m.tools || []).length;
            if (toolCount) badges += '<span class="emp-badge tools"><i class="fas fa-wrench"></i> ' + toolCount + " 工具</span>";
            var mdCount = (m.link_files || []).length;
            if (mdCount) badges += '<span class="emp-badge md"><i class="fab fa-markdown"></i> ' + mdCount + " 关联md</span>";
            if ((m.rag_kb_ids || []).length) badges += '<span class="emp-badge rag"><i class="fas fa-database"></i> RAG</span>';
            var swFilter = "empCard" + m.id;
            var actions =
                '<button type="button" class="layui-btn layui-btn-sm layui-btn-normal" data-act="edit" data-id="' + m.id + '"><i class="fas fa-sliders-h"></i> 配置</button>' +
                '<span class="spacer"></span>';
            if (!m.is_default) {
                actions += '<button type="button" class="emp-act-icon star" data-act="default" data-id="' + m.id + '" title="设为默认员工"><i class="far fa-star"></i></button>';
            }
            actions +=
                '<button type="button" class="emp-act-icon danger" data-act="del" data-id="' + m.id + '" title="删除"><i class="fas fa-trash-alt"></i></button>';
            return '' +
                '<div class="emp-card layui-form' + (m.enabled ? "" : " is-disabled") + '" data-id="' + m.id + '" lay-filter="' + swFilter + '">' +
                '  <div class="emp-card-head">' +
                '    <div class="emp-avatar"><i class="' + esc(m.avatar || "fas fa-briefcase") + '"></i></div>' +
                '    <div class="emp-title-wrap">' +
                '      <div class="emp-name" title="' + esc(m.name) + '">' + esc(m.name) + "</div>" +
                '      <div class="emp-badges">' + badges + "</div>" +
                "    </div>" +
                '    <div class="emp-switch">' +
                '      <input type="checkbox" name="empToggle" lay-skin="switch" lay-text="启用|停用" lay-filter="empToggle" data-id="' + m.id + '"' + (m.enabled ? " checked" : "") + ">" +
                "    </div>" +
                "  </div>" +
                '  <div class="emp-desc">' + (esc(m.description) || "暂无简介") + "</div>" +
                '  <div class="emp-instr-preview"><span class="t"><i class="fas fa-comment-dots"></i> 提示词预览</span>' +
                (esc(m.instructions_preview) || (mdCount ? "（仅关联 md 文件注入）" : "未配置")) + "</div>" +
                '  <div class="emp-meta">' +
                '    <div class="emp-meta-row"><span class="k">工作空间</span><span class="v" title="' + esc(m.workspace_path) + '">' + esc(m.workspace_path) + "</span></div>" +
                "  </div>" +
                '  <div class="emp-actions">' + actions + "</div>" +
                "</div>";
        },

        /* ---------- 编辑走详情接口取完整 instructions 正文 ---------- */
        openDetail: function (row) {
            var self = this;
            api("GET", "/api/admin/employees/" + row.id).then(function (d) {
                self.openForm(d.row, d.instructions);
            });
        },

        /* ---------- 新增 / 编辑弹层 ---------- */
        openForm: function (row, instructionsFull) {
            var self = this;
            var isEdit = !!row;
            row = row || {};
            var instructions = instructionsFull != null ? instructionsFull : (row.instructions || "");
            var linkFiles = (row.link_files || []).slice();
            var tools = (row.tools || []).slice();
            var avatar = row.avatar || "fas fa-briefcase";
            // 弹层内部状态须声明在 openForm 作用域：success 里赋值、yes 里读取，
            // 若 var 在 success 回调内会跨闭包引用不到（ReferenceError 导致保存中断）
            var editor = null;
            var currentIcon = avatar;
            var ICONS = ["fas fa-briefcase", "fas fa-robot", "fas fa-user-tie", "fas fa-sitemap",
                "fas fa-pen-fancy", "fas fa-chart-line", "fas fa-magic", "fas fa-compass"];

            var iconHtml = ICONS.map(function (ic) {
                return '<button type="button" class="emp-icon-opt' + (ic === avatar ? " on" : "") +
                    '" data-icon="' + ic + '"><i class="' + ic + '"></i></button>';
            }).join("");
            var toolOptions = JSON.parse($("employeeToolOptions").dataset.options);
            var toolHtml = toolOptions.map(function (t) {
                var on = tools.indexOf(t.id) >= 0;
                return '<label class="emp-tool-chip' + (on ? " on" : "") + '"><input type="checkbox" value="' + esc(t.id) + '"' +
                    (on ? " checked" : "") + '><i class="' + esc(t.icon) + '"></i> ' + esc(t.label) + "</label>";
            }).join("");

            function linkedHtml() {
                return linkFiles.map(function (f, idx) {
                    return '<span class="emp-linked-chip"><i class="fab fa-markdown"></i> ' + esc(f) +
                        '<span class="x" data-unlink="' + idx + '">×</span></span>';
                }).join("") || '<span class="tip" style="margin:0;">未关联 md 文件（可选，在下方浏览 workspace 目录加入）</span>';
            }

            var html = '' +
                '<div class="layui-form emp-form" lay-filter="empForm">' +
                '  <div class="emp-form-row2">' +
                '    <div class="layui-form-item"><label class="layui-form-label">员工名称</label><div class="layui-input-block">' +
                '      <input type="text" name="name" class="layui-input" placeholder="如：华师小助手" value="' + esc(row.name || "") + '"></div></div>' +
                '    <div class="layui-form-item"><label class="layui-form-label">启用状态</label><div class="layui-input-block">' +
                '      <input type="checkbox" name="enabled" lay-skin="switch" lay-text="启用|停用"' + (row.enabled === 0 ? "" : " checked") + "></div></div>" +
                "  </div>" +
                '  <div class="layui-form-item"><label class="layui-form-label">简介</label><div class="layui-input-block">' +
                '    <input type="text" name="description" class="layui-input" placeholder="一句话说明这位数字员工的职责（可选）" value="' + esc(row.description || "") + '"></div></div>' +
                '  <div class="layui-form-item"><label class="layui-form-label">头像图标</label><div class="layui-input-block"><div class="emp-icon-picker" id="empIconPicker">' + iconHtml + "</div></div></div>" +

                '  <div class="emp-section-title"><i class="fas fa-comment-dots"></i> instructions 提示词配置（Markdown 可视化编辑）</div>' +
                '  <div class="layui-form-item"><div class="layui-input-block" style="margin-left:0;">' +
                MdEditor.html("empInstr", instructions) +
                "  </div></div>" +

                '  <div class="emp-section-title"><i class="fas fa-paperclip"></i> 关联知识 md 文件（注入 instructions，可多个）</div>' +
                '  <div class="layui-form-item"><div class="layui-input-block" style="margin-left:0;">' +
                '    <div class="emp-ws-row">' +
                '      <input type="text" id="empBrowsePathInput" class="layui-input" placeholder="留空 = workspace 根目录，指定则只浏览该子目录" autocomplete="off">' +
                '      <button type="button" class="layui-btn layui-btn-primary" id="empBrowseBtn"><i class="fas fa-folder-open"></i> 浏览文件</button>' +
                "    </div>" +
                '    <div class="emp-linked" id="empLinkedBox">' + linkedHtml() + "</div>" +
                "  </div></div>" +

                '  <div class="emp-section-title"><i class="fas fa-wrench"></i> 工具链路配置</div>' +
                '  <div class="layui-form-item"><div class="layui-input-block" style="margin-left:0;">' +
                '    <div class="emp-tools" id="empToolChips">' + toolHtml + "</div>" +
                '    <div class="tip">当前为 agentica 内置工具预留选项，后续任务接入「工具管理模块」后改为动态获取</div>' +
                "  </div></div>" +

                '  <div class="emp-section-title"><i class="fas fa-folder-tree"></i> agentica 工作空间配置</div>' +
                '  <div class="layui-form-item"><label class="layui-form-label">目录路径</label><div class="layui-input-block">' +
                '    <input type="text" name="workspace_path" class="layui-input" placeholder="相对项目根目录，如 workspace" value="' + esc(row.workspace_path || "workspace") + '">' +
                '    <div class="tip">agentica Workspace 根路径，用户记忆/会话按 user_id 在该目录下隔离</div></div></div>' +
                '  <div class="emp-form-row2">' +
                '    <div class="layui-form-item"><label class="layui-form-label">长期记忆</label><div class="layui-input-block">' +
                '      <input type="checkbox" name="enable_long_term_memory" lay-skin="switch" lay-text="开启|关闭"' + (row.enable_long_term_memory === 0 ? "" : " checked") + "></div></div>" +
                '    <div class="layui-form-item"><label class="layui-form-label">经验记忆</label><div class="layui-input-block">' +
                '      <input type="checkbox" name="enable_experience_capture" lay-skin="switch" lay-text="开启|关闭"' + (row.enable_experience_capture === 0 ? "" : " checked") + "></div></div>" +
                "  </div>" +

                '  <div class="emp-section-title"><i class="fas fa-database"></i> RAG 知识库配置</div>' +
                '  <div class="layui-form-item"><div class="layui-input-block" style="margin-left:0;">' +
                '    <input type="text" class="layui-input" name="rag_kb_ids" placeholder="填写知识仓库文档编号，用逗号分隔" value="' + esc((row.rag_kb_ids || []).join(", ")) + '">' +
                "  </div></div>" +

                '  <div class="layui-form-item"><label class="layui-form-label">模型绑定</label><div class="layui-input-block">' +
                '    <input type="text" name="model_binding" class="layui-input" placeholder="填写模型引擎编号，留空使用默认模型" value="' + esc(row.model_binding || "") + '"></div></div>' +
                "</div>";

            L.layer.open({
                type: 1,
                title: isEdit ? "配置数字员工 · " + esc(row.name) : "新增数字员工",
                area: ["820px", "640px"],
                shadeClose: false,
                content: html,
                btn: ["保存", "取消"],
                success: function (layero) {
                    var dom = toDom(layero);
                    L.form.render(null, "empForm");
                    editor = MdEditor.bind("empInstr");

                    // 头像图标选择
                    dom.querySelector("#empIconPicker").addEventListener("click", function (e) {
                        var b = e.target.closest("[data-icon]");
                        if (!b) return;
                        currentIcon = b.getAttribute("data-icon");
                        dom.querySelectorAll(".emp-icon-opt").forEach(function (o) { o.classList.remove("on"); });
                        b.classList.add("on");
                    });
                    // 工具链路复选
                    dom.querySelector("#empToolChips").addEventListener("change", function (e) {
                        var cb = e.target.closest("input[type=checkbox]");
                        if (!cb) return;
                        cb.closest(".emp-tool-chip").classList.toggle("on", cb.checked);
                    });
                    // 关联文件：加入 / 移除
                    function renderLinked() {
                        dom.querySelector("#empLinkedBox").innerHTML = linkedHtml();
                    }
                    dom.querySelector("#empBrowseBtn").addEventListener("click", function () {
                        var startPath = (dom.querySelector("#empBrowsePathInput").value || "").trim().replace(/^\/+|\/+$/g, "");
                        Browse.open(dom, function (f) {
                            if (linkFiles.indexOf(f) < 0) linkFiles.push(f);
                            renderLinked();
                        }, startPath);
                    });
                    dom.querySelector("#empLinkedBox").addEventListener("click", function (e) {
                        var x = e.target.closest("[data-unlink]");
                        if (!x) return;
                        linkFiles.splice(parseInt(x.getAttribute("data-unlink"), 10), 1);
                        renderLinked();
                    });
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
                    var selectedTools = [];
                    dom.querySelectorAll("#empToolChips input[type=checkbox]:checked").forEach(function (cb) {
                        selectedTools.push(cb.value);
                    });
                    var payload = {
                        name: val("name"),
                        description: val("description"),
                        avatar: currentIcon,
                        instructions: editor.getText(),
                        link_files: linkFiles,
                        tools: selectedTools,
                        workspace_path: val("workspace_path") || "workspace",
                        rag_kb_ids: val("rag_kb_ids").split(/[,，]/).map(function (id) { return id.trim(); }).filter(Boolean),
                        model_binding: val("model_binding"),
                        enabled: checked("enabled"),
                        enable_long_term_memory: checked("enable_long_term_memory"),
                        enable_experience_capture: checked("enable_experience_capture")
                    };
                    if (!payload.name) { L.layer.msg("请填写数字员工名称", { icon: 2 }); return false; }
                    if (!payload.instructions.trim() && !payload.link_files.length) {
                        L.layer.msg("instructions 提示词与关联 md 文件至少配置一项", { icon: 2 }); return false;
                    }
                    var url = isEdit ? "/api/admin/employees/" + row.id : "/api/admin/employees";
                    api("POST", url, payload).then(function () {
                        L.layer.msg("已保存", { icon: 1 });
                        L.layer.close(index);
                        self.load(isEdit ? self.page : 1);
                    });
                    return false; // 请求成功后手动关闭，失败保留弹层
                }
            });
        },

        /* ---------- 启停开关 / 设默认 / 删除 ---------- */
        toggle: function (id, enabled) {
            var self = this;
            api("POST", "/api/admin/employees/" + id + "/toggle", { enabled: enabled }).then(function () {
                L.layer.msg(enabled ? "已启用" : "已停用", { icon: 1 });
                self.load(self.page);
            }).catch(function () {
                self.load(self.page); // 失败回滚开关显示
            });
        },

        setDefault: function (row) {
            var self = this;
            L.layer.confirm("把「" + esc(row.name) + "」设为默认数字员工？前台智能体对话将按它的配置运行。",
                { icon: 3, title: "设为默认" }, function (index) {
                    L.layer.close(index);
                    api("POST", "/api/admin/employees/" + row.id + "/default").then(function () {
                        L.layer.msg("已设为默认数字员工", { icon: 1 });
                        self.load(self.page);
                    });
                });
        },

        del: function (row) {
            var self = this;
            var tip = "确认删除数字员工「" + esc(row.name) + "」？" +
                (row.is_default ? "它是当前默认员工，删除后默认位将自动让给下一个启用员工。" : "");
            L.layer.confirm(tip, { icon: 3, title: "操作确认" }, function (index) {
                L.layer.close(index);
                api("DELETE", "/api/admin/employees/" + row.id).then(function () {
                    L.layer.msg("已删除", { icon: 1 });
                    self.load(self.page);
                });
            });
        }
    };

    /* 卡片开关事件：全局委托（form.on 只注册一次，按 lay-filter 命中卡片内开关）
       注意 lay-skin="switch" 的开关 layui 派发的是 switch(filter) 事件，
       checkbox(filter) 只对 lay-skin="primary" 生效，写错会「只切外观不发消息」 */
    function bindSwitchEvents() {
        L.form.on("switch(empToggle)", function (data) {
            var el = data.elem;
            var id = parseInt(el.getAttribute("data-id"), 10);
            if (!id) return;
            EmployeeModule.toggle(id, el.checked ? 1 : 0);
        });
    }

    function boot() {
        if (!/^\/admin\/employees\/?$/.test(location.pathname)) return;
        layui.use(["layer", "form", "laypage"], function () {
            L.layer = layui.layer;
            L.form = layui.form;
            L.laypage = layui.laypage;
            bindSwitchEvents();
            EmployeeModule.init();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
