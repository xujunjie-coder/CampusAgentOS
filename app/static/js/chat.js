/*
 * chat.js —— 智能对话页前端逻辑（表现层）
 * 由 index.html 引入，负责：
 *   1. 轻量 Markdown 渲染（标题/引用/加粗/斜体/列表/代码块/行内码/链接/表格），全部先转义再解析，防 XSS
 *   2. 拉取历史 GET /api/history，按 user/assistant 渲染对话气泡
 *   3. 提交 POST /api/chat 消费 SSE 事件流：delta 正文流式打字机、tool/reasoning 归入可折叠"执行过程"时间线、error 错误气泡
 *   4. 交互：Enter 发送 / Shift+Enter 换行、历史会话列表（点击切换）、清屏、输入框自适应高度、自动滚底
 *   5. 任务10：输入区数字助理选择器——GET /api/assistants 拉取可用助理，点击切换并 POST /api/assistants/select
 *      持久化「用户 ↔ 数字助理」关联；发送时带 employee_id，SSE assistant 事件回填本轮实际应答的助理身份，
 *      历史气泡按 messages.employee_name 署名
 *   6. 成员 D（任务2）：「@音乐 关键词」前缀拦截 → /api/music/search 检索内置曲库，气泡内渲染 HTML5
 *      场景曲库与统一播放器；头部「导出PDF」按钮 → /api/chat/export?session_id= 下载真 PDF；
 *      侧栏底部功能入口为手风琴式，点用户行展开/收起
 * 与后端 SSE 约定保持一致：delta 的 data 为纯文本字符串；tool/reasoning/error/assistant 的 data 为对象。
 */
(function () {
    "use strict";

    // ---------- 小工具 ----------
    function $(id) { return document.getElementById(id); }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }
    
    // 任务10：助理名称/简介等库内文本会写进 HTML 片段与属性，这里连单引号一起转义
    function escHtml(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    
    // 头像类名白名单：只接受 fas fa-xxx（vendor 为 FontAwesome 5 free），非法值回退机器人图标
    function iconClass(raw) {
        var v = String(raw || "").trim();
        return /^fas fa-[a-z0-9-]+$/i.test(v) ? v : "fas fa-robot";
    }

    // 占位符使用不可见控制字符包裹，避免与正文内容冲突
    var PH_CODE = "\u0000CODE", PH_ICODE = "\u0000ICODE", PH_TABLE = "\u0000TABLE";

    function formatInline(src) {
        return src
            .replace(/\[([^\]]+)\]\((\/campus-map)\)/g, '<a href="$2">$1</a>')
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
            .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                '<a href="$2" target="_blank" rel="noopener">$1</a>')
            .replace(/\[([^\]]+)\]\((\/api\/course-materials\/[a-z0-9-]+\/preview)\)/g,
                '<a href="$2" target="_blank" rel="noopener">$1</a>')
            .replace(/\[([^\]]+)\]\((\/api\/course-materials\/[a-z0-9-]+\/download)\)/g,
                '<a href="$2" download>$1</a>');
    }

    function splitTableRow(line, escaped) {
        var row = line.trim().replace(/\|\\$/, "|");
        if (escaped) row = row.replace(/\\\|/g, "|");
        var cells = row.split(/(?<!\\)\|/);
        if (cells.length === 1) return null;
        if (cells[0] === "") cells.shift();
        if (cells[cells.length - 1] === "") cells.pop();
        return cells.map(function (cell) { return cell.trim().replace(/\\\|/g, "|"); });
    }

    function extractTables(src, tables) {
        var lines = src.split("\n");
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var escaped = /^\s*\\\|/.test(lines[i]);
            var headers = splitTableRow(lines[i], escaped);
            var rules = i + 1 < lines.length ? splitTableRow(lines[i + 1], escaped) : null;
            if (!headers || !headers.length || !rules || headers.length !== rules.length ||
                !rules.every(function (rule) { return /^:?-{3,}:?$/.test(rule); })) {
                out.push(lines[i]);
                continue;
            }
            var align = rules.map(function (rule) {
                if (!rule.endsWith(":")) return "";
                return rule.startsWith(":") ? ' class="is-center"' : ' class="is-right"';
            });
            var head = headers.map(function (cell, column) {
                return '<th scope="col"' + align[column] + ">" + formatInline(cell) + "</th>";
            }).join("");
            var body = [];
            i += 1;
            while (i + 1 < lines.length) {
                var cells = splitTableRow(lines[i + 1], escaped);
                if (!cells || cells.length !== headers.length) break;
                body.push("<tr>" + cells.map(function (cell, column) {
                    return "<td" + align[column] + ">" + formatInline(cell) + "</td>";
                }).join("") + "</tr>");
                i += 1;
            }
            tables.push('<div class="chat-table-scroll"><table><thead><tr>' + head +
                "</tr></thead><tbody>" + body.join("") + "</tbody></table></div>");
            out.push("", PH_TABLE + (tables.length - 1) + "\u0000", "");
        }
        return out.join("\n");
    }

    // ---------- 轻量 Markdown 渲染 ----------
    function renderMarkdown(src) {
        if (src == null) return "";
        src = String(src).replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
        var codeBlocks = [], inlineCodes = [], tables = [];

        // 1. 先抽出围栏代码块 ```lang\n...\n```
        src = String(src).replace(/```(\w*)\r?\n?([\s\S]*?)```/g, function (m, lang, code) {
            codeBlocks.push(
                '<pre class="chat-code"><code>' +
                escapeHtml(code.replace(/\s+$/, "")) +
                "</code></pre>"
            );
            return PH_CODE + (codeBlocks.length - 1) + "\u0000";
        });

        // 2. 其余正文统一转义
        src = escapeHtml(src);

        // 3. 抽出行内代码 `code`
        src = src.replace(/`([^`\n]+)`/g, function (m, c) {
            inlineCodes.push('<code class="chat-icode">' + c + "</code>");
            return PH_ICODE + (inlineCodes.length - 1) + "\u0000";
        });

        src = extractTables(src, tables);

        // 4. 标题与引用各自成块，保留前后正文的段落结构。
        src = src
            .replace(/^(?:[ \t]{0,3}\\?&gt;[^\n]*(?:\n|$))+/gm, function (quote) {
                var lines = quote.replace(/\n$/, "").split("\n").map(function (line) {
                    return line.replace(/^[ \t]{0,3}\\?&gt;[ \t]?/, "");
                });
                var paragraphs = lines.join("\n").split(/\n{2,}/).map(function (part) {
                    return part ? "<p>" + part.replace(/\n/g, "<br>") + "</p>" : "";
                });
                return "\n\n<blockquote>" + paragraphs.join("") + "</blockquote>\n\n";
            })
            .replace(/^[ \t]{0,3}(#{1,6})[ \t]+(.+)$/gm, function (line, hashes, title) {
                var level = Math.min(6, hashes.length + 1);
                return "\n\n<h" + level + ">" + title + "</h" + level + ">\n\n";
            });

        // 5. 行内样式：加粗、斜体、链接
        src = formatInline(src);

        // 6. 列表
        src = processLists(src);

        // 6.5 分隔线：整行 --- / *** / ___
        src = src.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "\n\n<hr>\n\n");

        // 7. 段落：按空行分段，段内换行转 <br>
        src = src.split(/\n{2,}/).map(function (block) {
            var t = block.trim();
            if (!t) return "";
            if (t.indexOf(PH_TABLE) === 0) return t;
            if (/^<(h[2-6]|hr|ul|ol|pre|blockquote)\b/.test(t)) return t;
            if (t.indexOf(PH_CODE) !== -1) return block;
            return "<p>" + block.replace(/\n/g, "<br>") + "</p>";
        }).join("");

        // 8. 还原占位符
        src = src.replace(new RegExp(PH_TABLE + "(\\d+)\\u0000", "g"), function (m, i) { return tables[+i]; });
        src = src.replace(new RegExp(PH_ICODE + "(\\d+)\\u0000", "g"), function (m, i) { return inlineCodes[+i]; });
        src = src.replace(new RegExp(PH_CODE + "(\\d+)\\u0000", "g"), function (m, i) { return codeBlocks[+i]; });
        return src;
    }

    function processLists(src) {
        var lines = src.split("\n");
        var out = [], listType = null;
        function closeList() {
            if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>", ""); listType = null; }
        }
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            var ul = ln.match(/^\s*[-*]\s+(.*)$/);
            var ol = ln.match(/^\s*\d+\.\s+(.*)$/);
            if (ul) {
                if (listType !== "ul") { closeList(); out.push("", "<ul>"); listType = "ul"; }
                out.push("<li>" + ul[1] + "</li>");
            } else if (ol) {
                if (listType !== "ol") { closeList(); out.push("", "<ol>"); listType = "ol"; }
                out.push("<li>" + ol[1] + "</li>");
            } else {
                closeList();
                out.push(ln);
            }
        }
        closeList();
        return out.join("\n");
    }

    // ---------- DOM 引用与状态 ----------
    var app, messagesEl, scrollEl, formEl, inputEl, sendEl, xsrf;
    var streaming = false;

    // 任务10：数字助理选择器 DOM 与状态
    var asst = {};
    var assistants = [];              // 后台启用的数字助理清单
    var currentAssistant = null;      // 当前生效的助理（含 id/name/avatar/tools）

    function scrollToBottom() {
        scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function isAtBottom() {
        // Allow for fractional scroll positions at non-integer zoom levels.
        return scrollEl.scrollHeight - scrollEl.clientHeight - scrollEl.scrollTop <= 2;
    }

    function addSCSWikiAttribution(details) {
        var credit = document.createElement("div");
        credit.className = "chat-source-credit";
        credit.appendChild(document.createTextNode("SCSWiki 贡献者 · "));
        var license = document.createElement("a");
        license.href = "https://creativecommons.org/licenses/by-sa/4.0/";
        license.target = "_blank";
        license.rel = "noopener noreferrer";
        license.textContent = "CC BY-SA 4.0";
        credit.appendChild(license);
        details.appendChild(credit);
    }

    function clearMessages() {
        messagesEl.innerHTML = "";
    }

    // 空状态欢迎屏（西华师大现代校园白蓝风 + 三大场景快捷提问卡）
    function showEmptyTip() {
        var name = currentAssistant ? currentAssistant.name : "华师小助手";
        messagesEl.innerHTML =
            '<div class="chat-empty">' +
            '  <div class="chat-welcome-emblem" aria-hidden="true">' +
            '    <svg viewBox="0 0 88 88" width="76" height="76" fill="none">' +
            '      <circle cx="44" cy="44" r="41" stroke="#003087" stroke-width="2.5" fill="#F8FAFC"/>' +
            '      <circle cx="44" cy="44" r="33" stroke="#003087" stroke-width="1.2" stroke-dasharray="3 2.5" fill="#EEF3FB"/>' +
            '      <path d="M44 24L23 34.5L44 45L65 34.5L44 24Z" fill="#003087"/>' +
            '      <path d="M31 39.5V51.5C31 55.5 36.8 59 44 59C51.2 59 57 55.5 57 51.5V39.5L44 46L31 39.5Z" fill="#003087" opacity="0.88"/>' +
            '      <path d="M62 36V49" stroke="#003087" stroke-width="2.2" stroke-linecap="round"/>' +
            '      <circle cx="67" cy="65" r="6.5" fill="#C41230" stroke="#FFFFFF" stroke-width="2"/>' +
            '    </svg>' +
            '  </div>' +
            '  <h2 class="chat-welcome-title">你好，欢迎来到西华师大智慧校园</h2>' +
            '  <p class="chat-welcome-sub">勤奋 · 求实 · 敬业 · 创新 ｜ 当前由「<span class="chat-empty-agent">' + escHtml(name) + '</span>」为你解答学业、就业与校园生活问题</p>' +
            '  <div class="chat-welcome-grid">' +
            '    <div class="chat-welcome-card">' +
            '      <div class="chat-welcome-ico is-navy"><i class="fas fa-graduation-cap"></i></div>' +
            '      <div class="chat-welcome-head">学业与奖助</div>' +
            '      <div class="chat-welcome-desc">奖学金评定 / 选课学分 / 图书馆指南</div>' +
            '      <div class="chat-welcome-chips">' +
            '        <button type="button" class="chat-welcome-chip js-prompt-chip" data-prompt="西华师范大学国家奖学金和校级奖学金怎么评定？">奖学金评定细则</button>' +
            '        <button type="button" class="chat-welcome-chip js-prompt-chip" data-prompt="请介绍一下学分修读、选课与毕业要求有哪些注意事项？">选课与学分要求</button>' +
            '      </div>' +
            '    </div>' +
            '    <div class="chat-welcome-card">' +
            '      <div class="chat-welcome-ico is-crimson"><i class="fas fa-rocket"></i></div>' +
            '      <div class="chat-welcome-head">就业与升学</div>' +
            '      <div class="chat-welcome-desc">考研推免政策 / 三方协议 / 校园招聘</div>' +
            '      <div class="chat-welcome-chips">' +
            '        <button type="button" class="chat-welcome-chip js-prompt-chip" data-prompt="西华师范大学应届生推免（保研）和考研升学有哪些支持政策？">考研推免政策</button>' +
            '        <button type="button" class="chat-welcome-chip js-prompt-chip" data-prompt="毕业生签订三方协议和办理档案派遣需要注意什么？">三方协议指南</button>' +
            '      </div>' +
            '    </div>' +
            '    <div class="chat-welcome-card">' +
            '      <div class="chat-welcome-ico is-teal"><i class="fas fa-heartbeat"></i></div>' +
            '      <div class="chat-welcome-head">心理与生活</div>' +
            '      <div class="chat-welcome-desc">情绪压力疏导 / 双校区交通 / 食堂住宿</div>' +
            '      <div class="chat-welcome-chips">' +
            '        <button type="button" class="chat-welcome-chip js-prompt-chip" data-prompt="华凤校区和北湖校区之间的交通、食堂与生活服务是怎样的？">双校区生活指南</button>' +
            '        <button type="button" class="chat-welcome-chip js-prompt-chip" data-prompt="最近复习压力比较大、容易焦虑失眠，学校有哪些心理咨询资源或调节建议？">情绪疏导与心理预约</button>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '</div>';
    }

    // ---------- 消息构造 ----------
    function addUserMessage(text) {
        var row = document.createElement("div");
        row.className = "chat-msg chat-msg-user";
        row.innerHTML =
            '<div class="chat-bubble chat-bubble-user">' + escapeHtml(text) + "</div>" +
            '<div class="chat-avatar chat-avatar-user"><i class="fas fa-user"></i></div>';
        messagesEl.appendChild(row);
        scrollToBottom();
    }

    // 返回一个 assistant 会话句柄，供流式增量写入；assistant 为本轮应答的数字助理（任务10，可空）
    function addAssistantTurn(assistant) {
        var row = document.createElement("div");
        row.className = "chat-msg chat-msg-assistant is-working";
        row.setAttribute("aria-busy", "true");
        row.innerHTML =
            '<div class="chat-avatar chat-avatar-bot"><i class="fas fa-robot"></i></div>' +
            '<div class="chat-body">' +
            '  <div class="chat-turn-meta">' +
            '  <div class="chat-bot-name"><i class="fas fa-robot"></i><span class="chat-bot-name-text"></span></div>' +
            '    <div class="chat-progress" role="status" aria-live="polite" aria-atomic="true">' +
            '      <span class="chat-progress-spinner" aria-hidden="true"></span>' +
            '      <span class="chat-progress-text">正在思考</span>' +
            '      <span class="chat-progress-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
            '    </div>' +
            '  </div>' +
            '  <div class="chat-sources-slot" hidden></div>' +
            '  <div class="chat-process" hidden>' +
            '    <div class="chat-process-head">' +
            '      <i class="fas fa-layer-group"></i><span class="chat-process-label">执行过程</span>' +
            '      <span class="chat-process-count"></span>' +
            '      <i class="fas fa-chevron-down chat-process-caret"></i>' +
            "    </div>" +
            '    <div class="chat-process-list"></div>' +
            "  </div>" +
            '  <div class="chat-bubble chat-bubble-assistant"><div class="chat-content"></div></div>' +
            "</div>";
        messagesEl.appendChild(row);

        var contentEl = row.querySelector(".chat-content");
        var bubbleEl = row.querySelector(".chat-bubble-assistant");
        var sourcesSlotEl = row.querySelector(".chat-sources-slot");
        var progressEl = row.querySelector(".chat-progress");
        var progressTextEl = row.querySelector(".chat-progress-text");
        var processEl = row.querySelector(".chat-process");
        var processListEl = row.querySelector(".chat-process-list");
        var processCountEl = row.querySelector(".chat-process-count");
        var processHeadEl = row.querySelector(".chat-process-head");
        var nameEl = row.querySelector(".chat-bot-name");
        var nameIconEl = nameEl.querySelector("i");
        var nameTextEl = nameEl.querySelector(".chat-bot-name-text");
        var avatarIconEl = row.querySelector(".chat-avatar-bot i");

        var state = {
            answer: "",
            processCount: 0,
            reasoningItem: null,
            reasoningText: "",
            pendingTasks: new Map(),
            finished: false,
            errorShown: false,
        };

        processHeadEl.addEventListener("click", function () {
            processEl.classList.toggle("collapsed");
            var collapsed = processEl.classList.contains("collapsed");
            processListEl.style.display = collapsed ? "none" : "";
            processHeadEl.querySelector(".chat-process-caret").style.transform = collapsed ? "" : "rotate(180deg)";
        });
        // 默认折叠
        processEl.classList.add("collapsed");

        function ensureProcessVisible() {
            if (processEl.hidden) {
                processEl.hidden = false;
                processListEl.style.display = "none"; // 折叠状态
            }
        }

        function setProgress(text) {
            if (state.finished || progressTextEl.textContent === text) return;
            progressTextEl.textContent = text;
        }

        // 任务10：按本轮实际应答的数字助理渲染头像与署名（无身份信息则隐藏整行）
        function applyAssistant(a) {
            if (!a || !a.name) {
                nameEl.style.display = "none";
                return;
            }
            nameEl.style.display = "";
            var icon = iconClass(a.avatar);
            nameIconEl.className = icon;
            avatarIconEl.className = icon;
            nameTextEl.textContent = a.name;
        }
        applyAssistant(assistant);

        return {
            setAssistant: applyAssistant,
            appendDelta: function (text) {
                if (!text || state.finished) return;
                if (!state.pendingTasks.size) setProgress("正在生成回复");
                row.classList.add("has-answer");
                state.answer += text;
                var answer = state.answer.replace(/[（(]署名[：:]\s*SCSWiki\s*贡献者[，,；;]\s*许可[：:]\s*CC BY-SA 4\.0(?:\s+https\\?:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\/?)?\s*[）)]/gi, "");
                if (answer !== state.answer && sourcesSlotEl.hidden) {
                    var details = document.createElement("details");
                    details.className = "chat-sources";
                    var summary = document.createElement("summary");
                    summary.textContent = "参考来源";
                    details.appendChild(summary);
                    addSCSWikiAttribution(details);
                    sourcesSlotEl.replaceChildren(details);
                    sourcesSlotEl.hidden = false;
                }
                contentEl.innerHTML = renderMarkdown(answer);
            },
            addTool: function (name, args, callId) {
                if (state.finished) return;
                setProgress("正在处理工具请求 · " + name);
                ensureProcessVisible();
                state.processCount++;
                processCountEl.textContent = "(" + state.processCount + ")";
                var item = document.createElement("div");
                item.className = "chat-proc-item";
                var argText = "";
                try { argText = args == null ? "" : JSON.stringify(args); } catch (e) { argText = String(args); }
                item.innerHTML =
                    '<span class="chat-proc-tag"><i class="fas fa-wrench"></i> 工具</span>' +
                    '<span class="chat-proc-text">' + escapeHtml(name) +
                    (argText ? '<span class="chat-proc-args">' + escapeHtml(argText) + "</span>" : "") +
                    "</span>";
                processListEl.appendChild(item);
                if (name === "task" && callId) {
                    var status = document.createElement("span");
                    status.className = "chat-proc-args";
                    status.textContent = "执行中";
                    item.querySelector(".chat-proc-text").appendChild(status);
                    state.pendingTasks.set(callId, status);
                    setProgress(state.pendingTasks.size + " 个子智能体协作中");
                }
            },
            finishTool: function (callId, status) {
                var label = state.pendingTasks.get(callId);
                if (!label || state.finished) return;
                var statusLabels = { completed: "已返回结果", timeout: "已超时", partial: "已返回部分结果", failed: "执行失败" };
                label.textContent = statusLabels[status] || "已结束";
                state.pendingTasks.delete(callId);
                setProgress(state.pendingTasks.size ? state.pendingTasks.size + " 个子智能体协作中" : "正在整理协作结果");
            },
            appendReasoning: function (text) {
                if (!text || state.finished) return;
                if (!state.pendingTasks.size) setProgress("正在思考");
                ensureProcessVisible();
                // 思考过程合并进同一条时间线条目，持续累加文本
                if (!state.reasoningItem) {
                    state.processCount++;
                    processCountEl.textContent = "(" + state.processCount + ")";
                    var item = document.createElement("div");
                    item.className = "chat-proc-item chat-proc-reasoning";
                    item.innerHTML =
                        '<span class="chat-proc-tag"><i class="fas fa-lightbulb"></i> 思考</span>' +
                        '<span class="chat-proc-text"></span>';
                    processListEl.appendChild(item);
                    state.reasoningItem = item.querySelector(".chat-proc-text");
                }
                state.reasoningText += text;
                state.reasoningItem.textContent = state.reasoningText;
            },
            setSources: function (items) {
                if (!sourcesSlotEl || !Array.isArray(items) || !items.length) return;
                var details = document.createElement("details");
                details.className = "chat-sources";
                var summary = document.createElement("summary");
                var icon = document.createElement("i");
                icon.className = "fas fa-book-open";
                icon.setAttribute("aria-hidden", "true");
                summary.appendChild(icon);
                summary.appendChild(document.createTextNode(" 参考来源 · " + items.length + " 篇知识库文档"));
                var list = document.createElement("div");
                list.className = "chat-sources-list";
                var hasSCSWikiSource = false;
                items.forEach(function (src) {
                    if (!src) return;
                    var card = document.createElement("div");
                    card.className = "chat-source-item";
                    var head = document.createElement("div");
                    head.className = "chat-source-head";
                    var titleEl = document.createElement("strong");
                    titleEl.textContent = src.title || "知识库文档";
                    var sourceUrl = null;
                    try {
                        var parsedSource = new URL(src.source_url || "");
                        if (parsedSource.protocol === "https:" && parsedSource.hostname === "scswiki.com" &&
                            !parsedSource.username && !parsedSource.password && (!parsedSource.port || parsedSource.port === "443")) {
                            sourceUrl = parsedSource.href;
                        }
                    } catch (e) { /* 没有可信原文地址时保留普通标题 */ }
                    if (sourceUrl) {
                        hasSCSWikiSource = true;
                        var sourceLink = document.createElement("a");
                        sourceLink.href = sourceUrl;
                        sourceLink.target = "_blank";
                        sourceLink.rel = "noopener noreferrer";
                        sourceLink.title = "查看原文";
                        sourceLink.appendChild(titleEl);
                        head.appendChild(sourceLink);
                    } else {
                        head.appendChild(titleEl);
                    }
                    if (typeof src.score === "number" && src.score > 0) {
                        var scoreEl = document.createElement("span");
                        scoreEl.className = "chat-source-score";
                        scoreEl.textContent = "相关度 " + Math.min(99, Math.round(src.score * 100)) + "%";
                        head.appendChild(scoreEl);
                    }
                    card.appendChild(head);
                    var isCampusMap = sourceUrl && new URL(sourceUrl).pathname.replace(/\/$/, "") === "/start/xingshu-campus-map";
                    if (src.excerpt) {
                        var excerptEl = document.createElement("p");
                        excerptEl.className = "chat-source-excerpt";
                        excerptEl.textContent = isCampusMap ? "学生整理的行署校区非官方三维白模，支持旋转、缩放和点选建筑。建筑信息请以现场标识为准。" : src.excerpt;
                        card.appendChild(excerptEl);
                    }
                    if (isCampusMap) {
                        var mapLink = document.createElement("a");
                        mapLink.href = "/campus-map";
                        mapLink.className = "chat-map-link";
                        mapLink.textContent = "打开行署校区三维地图 →";
                        card.appendChild(mapLink);
                    }
                    list.appendChild(card);
                });
                details.appendChild(summary);
                details.appendChild(list);
                if (hasSCSWikiSource) addSCSWikiAttribution(details);
                sourcesSlotEl.replaceChildren(details);
                sourcesSlotEl.hidden = false;
            },
            showError: function (msg) {
                state.errorShown = true;
                var note =
                    '<span class="chat-error"><i class="fas fa-exclamation-triangle"></i> ' +
                    escapeHtml(msg || "请求出错") + "</span>";
                // 已有正文时不整段覆盖，仅在下方追加错误提示
                if (state.answer) {
                    contentEl.insertAdjacentHTML("beforeend", '<div class="chat-error-inline">' + note + "</div>");
                } else {
                    contentEl.innerHTML = note;
                }
                bubbleEl.classList.add("chat-bubble-error");
                this.finish();
            },
            finish: function () {
                if (state.finished) return;
                state.finished = true;
                state.pendingTasks.forEach(function (label) { label.textContent = "本轮已结束"; });
                state.pendingTasks.clear();
                row.classList.remove("is-working");
                row.setAttribute("aria-busy", "false");
                progressEl.hidden = true;
                // 仅当既无正文、又无错误、也无过程时，才给空兑底
                if (!state.answer && !state.errorShown) {
                    var hasProcess = !processEl.hidden;
                    if (!hasProcess) contentEl.innerHTML = '<span class="chat-muted">（无返回内容）</span>';
                }
            },
        };
    }

    // ---------- SSE 帧解析 ----------
    // 累积缓冲区按空行切块，返回 {event, data} 或 null
    function parseSseBlock(block) {
        var ev = (block.match(/^event:\s*(.+)$/m) || [])[1];
        var dataLine = block.split("\n").find(function (l) { return l.indexOf("data:") === 0; });
        if (!ev || dataLine == null) return null;
        var raw = dataLine.slice(5).trim();
        var data;
        try { data = JSON.parse(raw); } catch (e) { data = raw; }
        return { event: ev.trim(), data: data };
    }

    // ---------- 数字助理选择（任务10，输入区） ----------
    function findAssistant(id) {
        for (var i = 0; i < assistants.length; i++) {
            if (assistants[i].id === id) return assistants[i];
        }
        return null;
    }

    // 轻量 toast：对话页不依赖 layui 弹层，切换结果就地提示
    function toast(text, isError) {
        var el = document.createElement("div");
        el.className = "chat-toast" + (isError ? " is-error" : "");
        el.textContent = text;
        document.body.appendChild(el);
        setTimeout(function () { el.style.opacity = "0"; }, 1800);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2150);
    }

    // 自定义确认弹窗（替代浏览器原生 window.confirm，同时挂到 window 供 face.js 复用）
    function customConfirm(opts) {
        opts = opts || {};
        var title = opts.title || "操作确认";
        var message = opts.message || "确定执行此操作吗？";
        var confirmText = opts.confirmText || "确定";
        var cancelText = opts.cancelText || "取消";
        var danger = opts.danger !== false;
        var icon = opts.icon || (danger ? "fas fa-trash-alt" : "fas fa-question-circle");

        return new Promise(function (resolve) {
            var prevFocus = document.activeElement;
            var mask = document.createElement("div");
            mask.className = "cwnu-modal-mask";
            mask.innerHTML =
                '<div class="cwnu-modal-card" role="alertdialog" aria-modal="true" aria-labelledby="cwnuModalTitle" aria-describedby="cwnuModalDesc">' +
                '  <div class="cwnu-modal-head">' +
                '    <span class="cwnu-modal-ico' + (danger ? " is-danger" : "") + '" aria-hidden="true"><i class="' + escHtml(icon) + '"></i></span>' +
                '    <div class="cwnu-modal-main">' +
                '      <h3 class="cwnu-modal-title" id="cwnuModalTitle">' + escHtml(title) + '</h3>' +
                '      <p class="cwnu-modal-desc" id="cwnuModalDesc">' + escHtml(message) + '</p>' +
                '    </div>' +
                '  </div>' +
                '  <div class="cwnu-modal-foot">' +
                '    <button type="button" class="cwnu-modal-btn is-cancel" data-modal-act="cancel">' + escHtml(cancelText) + '</button>' +
                '    <button type="button" class="cwnu-modal-btn ' + (danger ? "is-danger" : "is-confirm") + '" data-modal-act="ok">' + escHtml(confirmText) + '</button>' +
                '  </div>' +
                '</div>';

            function close(ok) {
                document.removeEventListener("keydown", onKey, true);
                if (mask.parentNode) mask.parentNode.removeChild(mask);
                if (prevFocus && prevFocus.focus) prevFocus.focus();
                resolve(ok);
            }
            function onKey(e) {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    close(false);
                }
            }
            mask.addEventListener("click", function (e) {
                if (e.target === mask) { close(false); return; }
                var act = e.target.closest && e.target.closest("[data-modal-act]");
                if (act) close(act.getAttribute("data-modal-act") === "ok");
            });
            document.addEventListener("keydown", onKey, true);
            document.body.appendChild(mask);
            var okBtn = mask.querySelector('[data-modal-act="ok"]');
            if (okBtn) okBtn.focus();
        });
    }
    window.cwnuConfirm = customConfirm;

    // 三处同步：输入区按钮、侧栏人设卡、旁侧提示
    function paintCurrentAssistant() {
        var a = currentAssistant;
        var name = a ? a.name : "数字助理";
        asst.name.textContent = name;
        asst.icon.className = iconClass(a && a.avatar) + " chat-asst-icon";
        if ($("sideAgentIcon")) $("sideAgentIcon").className = iconClass(a && a.avatar);
        if ($("sideAgentName")) $("sideAgentName").textContent = name;
        var emptyAgentEl = messagesEl && messagesEl.querySelector(".chat-empty-agent");
        if (emptyAgentEl) emptyAgentEl.textContent = name;
        if (!a) {
            asst.tip.hidden = false;
            asst.tip.textContent = "无可用助理，请到后台「数字员工」启用";
            asst.btn.disabled = true;
            return;
        }
        asst.btn.disabled = false;
        asst.tip.hidden = true;
        asst.tip.textContent = "";
    }

    function renderAssistantPanel() {
        if (!assistants.length) {
            asst.list.innerHTML = '<div class="chat-asst-empty">暂无可用的数字助理<br>请到后台「智能体服务 → 数字员工」启用或新增智能体</div>';
            return;
        }
        asst.list.innerHTML = assistants.map(function (a) {
            var active = currentAssistant && currentAssistant.id === a.id;
            return '<button type="button" class="chat-asst-item' + (active ? " is-active" : "") +
                '" data-asst-id="' + escHtml(a.id) + '">' +
                '<span class="chat-asst-item-ico"><i class="' + escHtml(iconClass(a.avatar)) + '"></i></span>' +
                '<span class="chat-asst-item-main">' +
                '<span class="chat-asst-item-name">' + escHtml(a.name) +
                "</span>" +
                '<span class="chat-asst-item-desc">' + escHtml(a.description || "未填写简介") + "</span>" +
                "</span>" +
                (active ? '<i class="fas fa-check chat-asst-check"></i>' : "") +
                "</button>";
        }).join("");
    }

    function openAsstPanel() {
        renderAssistantPanel();
        asst.panel.hidden = false;
        asst.btn.classList.add("is-open");
        asst.btn.setAttribute("aria-expanded", "true");
    }

    function closeAsstPanel() {
        asst.panel.hidden = true;
        asst.btn.classList.remove("is-open");
        asst.btn.setAttribute("aria-expanded", "false");
    }

    async function loadAssistants() {
        try {
            var resp = await fetch("/api/assistants", { headers: { "X-Xsrftoken": xsrf } });
            if (resp.status === 401) { location.href = "/auth/login"; return; }
            if (!resp.ok) return;
            var d = await resp.json();
            assistants = d.list || [];
            currentAssistant = findAssistant(d.selected_id) || (d.selected && d.selected.id ? d.selected : null);
            paintCurrentAssistant();
            renderAssistantPanel();
        } catch (e) {
            /* 助理列表加载失败不阻断对话，保留默认文案 */
        }
    }

    async function selectAssistant(id) {
        var target = findAssistant(id);
        if (!target) return;
        try {
            var resp = await fetch("/api/assistants/select", {
                method: "POST",
                headers: { "X-Xsrftoken": xsrf, "Content-Type": "application/json" },
                body: JSON.stringify({ employee_id: id }),
            });
            var d = await resp.json().catch(function () { return {}; });
            if (!resp.ok || !d.ok) {
                toast((d && d.detail) || "切换数字助理失败", true);
                return;
            }
            currentAssistant = d.selected || target;
            paintCurrentAssistant();
            closeAsstPanel();
            toast("已切换为「" + currentAssistant.name + "」");
        } catch (e) {
            toast("切换失败：" + e.message, true);
        }
    }

    function bindAssistantPicker() {
        asst.btn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (asst.panel.hidden) openAsstPanel(); else closeAsstPanel();
        });
        asst.list.addEventListener("click", function (e) {
            var item = e.target.closest ? e.target.closest("[data-asst-id]") : null;
            if (!item) return;
            selectAssistant(parseInt(item.getAttribute("data-asst-id"), 10));
        });
        // 点外部与 Esc 收起面板
        document.addEventListener("click", function (e) {
            if (asst.panel.hidden) return;
            if (!asst.root.contains(e.target)) closeAsstPanel();
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && !asst.panel.hidden) closeAsstPanel();
        });
    }

    // ---------- @音乐：场景选曲与统一播放器 ----------
    function playMusic(keyword) {
        var row = document.createElement("div");
        row.className = "chat-msg chat-msg-assistant";
        row.innerHTML = '<div class="chat-avatar chat-avatar-bot"><i class="fas fa-music"></i></div>' +
            '<div class="chat-body"><div class="chat-bubble chat-bubble-assistant chat-music-bubble">' +
            '<div class="chat-music"></div></div></div>';
        messagesEl.appendChild(row);
        window.CampusMusic.mount(row.querySelector(".chat-music"), {keyword:keyword, xsrf:xsrf});
        scrollToBottom();
    }

    // ---------- 发送消息并消费流 ----------
    var sessionId = "default";
    var temporaryChat = false, temporaryHistory = [];
    var sessionDraft = false;
    var archiveList = false, sessionArchived = false, sessionChanging = false;
    var sessionListRequest = 0, historyRequest = 0;

    function rememberSession(id) {
        try { localStorage.setItem("campus-chat-session:" + app.dataset.username, id); } catch (e) {}
    }

    function restoreSession(sessions) {
        var savedId;
        try { savedId = localStorage.getItem("campus-chat-session:" + app.dataset.username); } catch (e) {}
        var selected = sessions.find(function (session) { return session.session_id === savedId; }) || sessions[0];
        sessionId = selected ? selected.session_id : "default";
        sessionDraft = false;
        sessionArchived = false;
    }

    function sessionStatus(message) {
        var status = $("chatSessionStatus");
        status.textContent = message;
        status.hidden = !message;
    }

    function setTemporaryChat(enabled) {
        temporaryChat = enabled;
        temporaryHistory = [];
        $("temporaryChatBtn").setAttribute("aria-pressed", String(enabled));
        $("temporaryChatHint").hidden = !enabled;
        var exportButton = $("exportPdfBtn");
        if (exportButton) exportButton.disabled = enabled;
    }

    function newSession(temporary) {
        setTemporaryChat(Boolean(temporary));
        var bytes = crypto.getRandomValues(new Uint8Array(16));
        sessionId = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
        sessionDraft = !temporaryChat;
        sessionArchived = false;
        historyRequest++;
        clearMessages();
        showEmptyTip();
        setBusy(false);
    }

    function setArchiveList(archived) {
        archiveList = archived;
        $("chatHistoryTab").setAttribute("aria-pressed", String(!archived));
        $("chatArchiveTab").setAttribute("aria-pressed", String(archived));
        $("chatSessionList").setAttribute("aria-label", archived ? "已归档会话" : "历史会话");
    }

    function bindSidebarResizer() {
        var handle = $("chatSideResizer");
        if (!handle || !app) return;
        var storageKey = "campusagent.chat.sideWidth";
        var legacyStorageKey = "govcheck.chat.sideWidth";
        var minWidth = 220;
        var maxWidth = 380;
        var width = 250;
        try {
            var stored = Number(localStorage.getItem(storageKey) || localStorage.getItem(legacyStorageKey));
            if (Number.isFinite(stored) && stored >= minWidth && stored <= maxWidth) width = stored;
        } catch (error) {}

        function applyWidth(value) {
            width = Math.max(minWidth, Math.min(maxWidth, Math.round(value)));
            app.style.setProperty("--chat-side-width", width + "px");
            handle.setAttribute("aria-valuenow", String(width));
        }

        applyWidth(width);
        var dragStart = null;
        handle.addEventListener("pointerdown", function (event) {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStart = { x: event.clientX, width: width };
            app.classList.add("is-resizing");
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener("pointermove", function (event) {
            if (!dragStart) return;
            applyWidth(dragStart.width + event.clientX - dragStart.x);
        });
        function finishResize() {
            if (!dragStart) return;
            dragStart = null;
            app.classList.remove("is-resizing");
            try { localStorage.setItem(storageKey, String(width)); } catch (error) {}
        }
        handle.addEventListener("pointerup", finishResize);
        handle.addEventListener("pointercancel", finishResize);
        handle.addEventListener("keydown", function (event) {
            var amount = event.shiftKey ? 32 : 12;
            if (event.key === "ArrowLeft") applyWidth(width - amount);
            else if (event.key === "ArrowRight") applyWidth(width + amount);
            else if (event.key === "Home") applyWidth(minWidth);
            else if (event.key === "End") applyWidth(maxWidth);
            else return;
            event.preventDefault();
            try { localStorage.setItem(storageKey, String(width)); } catch (error) {}
        });
    }

    async function loadSessions(initial) {
        var request = ++sessionListRequest;
        try {
            var response = await fetch("/api/history?sessions=1" + (archiveList ? "&archived=1" : ""));
            if (!response.ok) throw new Error();
            var sessions = await response.json();
            if (request !== sessionListRequest) return;
            if (initial) restoreSession(sessions);
            if (!temporaryChat && !archiveList && !sessionArchived && sessions.some(function (session) { return session.session_id === sessionId; })) {
                sessionDraft = false;
                rememberSession(sessionId);
            }
            renderSessionList(sessions);
        } catch (e) {
            if (request === sessionListRequest) sessionStatus("会话列表加载失败，请重试");
        }
    }

    // 左侧历史会话列表：当前会话高亮，点击切换；当前会话尚未入库时补一条「新会话」
    function renderSessionList(sessions) {
        var listEl = $("chatSessionList");
        if (!listEl) return;
        var items = sessions.slice();
        if (sessionDraft && !archiveList && !sessionArchived &&
                !items.some(function (session) { return session.session_id === sessionId; })) {
            items.unshift({ session_id: sessionId, title: "新会话（未保存）", pending: true });
        }
        var keepTop = listEl.scrollTop;
        listEl.replaceChildren();
        if (!items.length) {
            var empty = document.createElement("li");
            empty.className = "chat-session-empty";
            empty.textContent = archiveList ? "暂无已归档会话" : "暂无历史会话";
            listEl.appendChild(empty);
        }
        items.forEach(function (session) {
            var li = document.createElement("li");
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "chat-session-item" +
                (!temporaryChat && session.session_id === sessionId && archiveList === sessionArchived ? " is-active" : "") +
                (session.pending ? " is-pending" : "");
            btn.setAttribute("data-sid", session.session_id);
            var title = session.title || "未命名会话";
            btn.title = title;
            var viewport = document.createElement("span");
            viewport.className = "chat-session-title";
            var label = document.createElement("span");
            label.className = "chat-session-title-text";
            label.textContent = title;
            viewport.appendChild(label);
            btn.appendChild(viewport);
            li.appendChild(btn);
            if (!session.pending) {
                var actions = archiveList ? [["restore", "恢复", "undo"]] : [["archive", "归档", "archive"]];
                actions.push(["delete", "删除", "trash-alt"]);
                actions.forEach(function (action) {
                    var button = document.createElement("button");
                    button.type = "button";
                    button.className = "chat-session-action";
                    button.dataset.action = action[0];
                    button.dataset.sid = session.session_id;
                    button.title = action[1];
                    button.setAttribute("aria-label", action[1] + "：" + title);
                    var icon = document.createElement("i");
                    icon.className = "fas fa-" + action[2];
                    icon.setAttribute("aria-hidden", "true");
                    button.appendChild(icon);
                    li.appendChild(button);
                });
            }
            listEl.appendChild(li);
        });
        listEl.scrollTop = keepTop;
    }

    async function changeSession(button) {
        var action = button.dataset.action, id = button.dataset.sid;
        if (action === "delete") {
            var ok = await customConfirm({
                title: "删除历史会话",
                message: "确定永久删除这段会话及其全部消息记录吗？删除后将无法恢复。",
                confirmText: "确认删除",
                cancelText: "取消",
                danger: true,
            });
            if (!ok) return;
        }
        sessionChanging = true;
        setBusy(true);
        sessionStatus("");
        var selectRemainingSession = false;
        try {
            var response = await fetch("/api/history", {
                method: "POST",
                headers: { "X-Xsrftoken": xsrf, "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: id, action: action })
            });
            var result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.detail || "会话操作失败");
            if (sessionId === id) {
                if (action === "restore") {
                    sessionArchived = false;
                    setArchiveList(false);
                    loadHistory();
                } else {
                    sessionId = "default";
                    sessionDraft = false;
                    sessionArchived = false;
                    setArchiveList(false);
                    selectRemainingSession = true;
                }
            }
            sessionStatus({ archive: "已归档", restore: "已恢复到历史会话", delete: "已删除" }[action]);
        } catch (error) {
            sessionStatus(error.message || "会话操作失败，请重试");
        } finally {
            await loadSessions(selectRemainingSession);
            if (selectRemainingSession) await loadHistory();
            sessionChanging = false;
            setBusy(false);
        }
    }

    async function sendMessage(text) {
        if (streaming || sessionChanging || sessionArchived) return;
        text = (text || "").trim();
        if (!text) return;

        // 成员 D（任务2）：「@音乐 xxx」前缀拦截 → 本地曲库点歌，不走模型对话
        var musicMatch = text.match(/^@音乐\s*([\s\S]*)$/);
        if (musicMatch) {
            addUserMessage(text);
            inputEl.value = "";
            autosize();
            playMusic(musicMatch[1].trim());
            return;
        }

        clearEmptyTipIfNeeded();
        addUserMessage(text);
        inputEl.value = "";
        autosize();

        var temporaryAnswer = "";
        var turn = addAssistantTurn(currentAssistant);
        scrollToBottom();
        streaming = true;
        setBusy(true);
        var controller = new AbortController();
        var deadline;
        function resetIdleTimer() {
            clearTimeout(deadline);
            deadline = setTimeout(function () { controller.abort(); }, 105000);
        }
        resetIdleTimer();

        try {
            var resp = await fetch("/api/chat", {
                method: "POST",
                signal: controller.signal,
                headers: { "X-Xsrftoken": xsrf, "Content-Type": "application/json" },
                // 任务10：带上输入区选定的数字助理（无选定项时后端沿用已保存助理/默认员工）
                body: JSON.stringify({
                    message: text,
                    session_id: sessionId,
                    temporary: temporaryChat,
                    history: temporaryChat ? temporaryHistory.slice(-16) : undefined,
                    employee_id: currentAssistant ? currentAssistant.id : null,
                }),
            });
            if (resp.status === 401) { turn.finish(); location.href = "/auth/login"; return; }
            if (!resp.ok) {
                // 任务10：指定的助理已被后台停用/删除时，后端直接 400，把 detail 弹进气泡并刷一次助理清单
                var errBody = {};
                try { errBody = await resp.json(); } catch (e) { errBody = {}; }
                turn.showError(errBody.detail || ("请求失败 " + resp.status));
                if (resp.status === 400) loadAssistants();
                return;
            }

            var reader = resp.body.getReader();
            var decoder = new TextDecoder();
            var buf = "";
            var terminal = "";
            while (true) {
                var chunk = await reader.read();
                if (chunk.done) break;
                resetIdleTimer();
                buf += decoder.decode(chunk.value, { stream: true });
                var blocks = buf.split("\n\n");
                buf = blocks.pop();
                for (var i = 0; i < blocks.length; i++) {
                    var frame = parseSseBlock(blocks[i]);
                    if (!frame) continue;
                    if (frame.event === "delta") temporaryAnswer += typeof frame.data === "string" ? frame.data : (frame.data && frame.data.text) || "";
                    handleFrame(turn, frame);
                    if (frame.event === "done" || frame.event === "error") terminal = frame.event;
                }
                if (terminal) break;
            }
            if (terminal) reader.cancel().catch(function () {});
            // 处理残留缓冲
            var tail = parseSseBlock(buf);
            if (!terminal && tail && (tail.event === "done" || tail.event === "error")) {
                terminal = tail.event;
                handleFrame(turn, tail);
            }

            if (terminal === "done") {
                if (temporaryChat) {
                    temporaryHistory.push({ role: "user", content: text }, { role: "assistant", content: temporaryAnswer.slice(0, 8000) });
                    temporaryHistory = temporaryHistory.slice(-16);
                }
                turn.finish();
                loadSessions();
            } else if (!terminal) {
                turn.showError("回复连接已中断，请重试。");
            } else {
                loadSessions();
            }
        } catch (e) {
            turn.showError(controller.signal.aborted ? "长时间没有收到新进度，请重试。" : ("出错了 " + e.message));
        } finally {
            clearTimeout(deadline);
            streaming = false;
            setBusy(false);
            inputEl.focus({ preventScroll: true });
        }
    }

    function handleFrame(turn, frame) {
        var follow = isAtBottom();
        var ev = frame.event, data = frame.data;
        if (ev === "delta") {
            turn.appendDelta(typeof data === "string" ? data : (data && data.text) || "");
        } else if (ev === "tool") {
            turn.addTool((data && data.name) || "tool", data && data.arguments, data && data.call_id);
        } else if (ev === "tool_result" && data) {
            turn.finishTool(data.call_id, data.status);
        } else if (ev === "reasoning") {
            turn.appendReasoning((data && data.text) || (typeof data === "string" ? data : ""));
        } else if (ev === "assistant") {
            // 任务10：后端告知本轮实际应答的助理，气泡头像/署名以此为准
            if (data && data.name) {
                turn.setAssistant(data);
                currentAssistant = findAssistant(data.id) || data;
                paintCurrentAssistant();
            }
        } else if (ev === "notice") {
            turn.addTool("知识仓库", data.text);
        } else if (ev === "sources") {
            turn.setSources((data && data.items) || []);
        } else if (ev === "error") {
            turn.showError((data && data.message) || "未知错误");
        }
        if (follow) scrollToBottom();
        // done 事件：正文与过程已实时渲染，这里无需额外处理（落库由后端负责）
    }

    function clearEmptyTipIfNeeded() {
        var tip = messagesEl.querySelector(".chat-empty");
        if (tip) messagesEl.innerHTML = "";
    }

    function setBusy(busy) {
        sendEl.disabled = busy || sessionChanging || sessionArchived;
        inputEl.disabled = sessionArchived;
        inputEl.placeholder = sessionArchived ? "恢复会话后可继续对话" : "请输入你想了解的校园问题...";
        var sessionList = $("chatSessionList");
        if (sessionList) sessionList.classList.toggle("is-busy", busy || sessionChanging);
        sendEl.classList.toggle("is-busy", busy);
        var icon = sendEl.querySelector("i");
        if (icon) icon.className = busy ? "fas fa-spinner fa-spin" : "fas fa-paper-plane";
    }

    // 历史行的应答助理：messages.employee_name 提供名称，头像类名按 id 从当前清单回查
    function historyAssistant(m) {
        var id = parseInt(m.employee_id, 10) || 0;
        if (!m.employee_name && !id) return null;
        var known = findAssistant(id) || {};
        return { name: m.employee_name || known.name || "", avatar: known.avatar || "" };
    }

    // ---------- 历史加载 ----------
    async function loadHistory() {
        var request = ++historyRequest;
        clearMessages();
        showEmptyTip();
        try {
            var requestedSession = sessionId;
            var resp = await fetch("/api/history?session_id=" + encodeURIComponent(requestedSession) +
                (sessionArchived ? "&archived=1" : ""));
            if (request !== historyRequest || streaming) return;
            if (resp.status === 401) { location.href = "/auth/login"; return; }
            if (!resp.ok) return;
            var list = await resp.json();
            if (request !== historyRequest || streaming || !list || !list.length) return;
            clearMessages();
            for (var i = 0; i < list.length; i++) {
                var m = list[i];
                if (m.role === "user") {
                    addUserMessage(m.content);
                } else if (m.role === "assistant") {
                    var turn = addAssistantTurn(historyAssistant(m));
                    if (m.content) turn.appendDelta(m.content);
                    if (m.is_partial) {
                        turn.showError(sessionArchived ? "这条回复曾中断。" :
                            "上一轮回复中断，可以发送「继续」接着处理。");
                    } else {
                        turn.finish();
                    }
                }
            }
            scrollToBottom();
        } catch (e) {
            /* 历史加载失败不影响使用，保持空状态 */
        }
    }

    // ---------- 输入框自适应 ----------
    function autosize() {
        inputEl.style.height = "auto";
        inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
    }

    // ---------- 初始化 ----------
    function init() {
        app = $("chatApp");
        messagesEl = $("chatMessages");
        scrollEl = $("chatScroll");
        formEl = $("composerForm");
        inputEl = $("chatInput");
        sendEl = $("sendBtn");
        bindSidebarResizer();
        var hidden = formEl.querySelector('input[name="_xsrf"]');
        xsrf = hidden ? hidden.value : "";

        // 任务10：输入区数字助理选择器
        asst.root = $("chatAsst");
        asst.btn = $("chatAsstBtn");
        asst.panel = $("chatAsstPanel");
        asst.list = $("chatAsstList");
        asst.icon = $("chatAsstIcon");
        asst.name = $("chatAsstName");
        asst.tip = $("chatAsstTip");
        bindAssistantPicker();

        formEl.addEventListener("submit", function (e) {
            e.preventDefault();
            sendMessage(inputEl.value);
        });

        messagesEl.addEventListener("click", function (e) {
            var chip = e.target.closest && e.target.closest(".js-prompt-chip");
            if (!chip) return;
            var prompt = chip.getAttribute("data-prompt");
            if (prompt) sendMessage(prompt);
        });

        inputEl.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(inputEl.value);
            }
        });
        inputEl.addEventListener("input", autosize);

        // 新会话：保留历史，后续消息写入新编号
        var clearBtn = $("clearBtn");
        if (clearBtn) {
            clearBtn.addEventListener("click", function () {
                if (streaming || sessionChanging) return;
                newSession();
                setArchiveList(false);
                loadSessions();
            });
        }

        // 成员 D（任务2）：导出当前会话 PDF（后端直下附件，不新开页）
        $("temporaryChatBtn").addEventListener("click", function () {
            if (streaming || sessionChanging) return;
            newSession(true);
            setArchiveList(false);
            loadSessions();
        });

        var exportBtn = $("exportPdfBtn");
        if (exportBtn) {
            exportBtn.addEventListener("click", function () {
                if (temporaryChat) return;
                location.href = "/api/chat/export?session_id=" + encodeURIComponent(sessionId) +
                    (sessionArchived ? "&archived=1" : "");
            });
        }

        // 侧栏底部账号向上弹出卡片：点用户行切换、点空白处或触发弹层后自动收起
        var sideFoot = $("chatSideFoot");
        var footToggle = $("sideFootToggle");
        function setFootOpen(open) {
            if (!sideFoot || !footToggle) return;
            sideFoot.classList.toggle("open", open);
            footToggle.setAttribute("aria-expanded", String(open));
        }
        if (sideFoot && footToggle) {
            footToggle.addEventListener("click", function () {
                setFootOpen(!sideFoot.classList.contains("open"));
            });
            footToggle.addEventListener("keydown", function (e) {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setFootOpen(!sideFoot.classList.contains("open"));
                } else if (e.key === "Escape") {
                    setFootOpen(false);
                }
            });
            document.addEventListener("click", function (e) {
                if (!sideFoot.classList.contains("open")) return;
                if (e.target.closest && e.target.closest("#chatSideFoot")) {
                    if (e.target.closest("#faceEntry")) setFootOpen(false);
                    return;
                }
                setFootOpen(false);
            });
        }

        // 任务10：先拉助理清单再拉历史，历史气泡才能按助理 id 回查头像类名
        var sessionListEl = $("chatSessionList");
        if (sessionListEl) {
            [$("chatHistoryTab"), $("chatArchiveTab")].forEach(function (tab, index) {
                tab.addEventListener("click", function () {
                    if (streaming || sessionChanging || archiveList === Boolean(index)) return;
                    setArchiveList(Boolean(index));
                    sessionStatus("");
                    sessionListEl.replaceChildren();
                    loadSessions();
                });
            });
            // 历史会话列表：点击切换；当前项与「新会话（未保存）」不重复加载
            sessionListEl.addEventListener("click", function (event) {
                if (streaming || sessionChanging) return;
                var action = event.target.closest(".chat-session-action");
                if (action) { changeSession(action); return; }
                var item = event.target.closest(".chat-session-item");
                if (!item) return;
                if (item.classList.contains("is-active") || item.classList.contains("is-pending")) return;
                setTemporaryChat(false);
                sessionId = item.getAttribute("data-sid");
                sessionDraft = false;
                sessionArchived = archiveList;
                if (!sessionArchived) rememberSession(sessionId);
                setBusy(false);
                loadHistory();
                loadSessions();
            });
        }
        sessionChanging = true;
        setBusy(false);
        Promise.all([loadSessions(true), loadAssistants()]).then(function () {
            if (historyRequest === 0) return loadHistory();
        }).finally(function () {
            sessionChanging = false;
            setBusy(false);
        });
        inputEl.focus();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
