/*
 * ui-motion.js —— 全站轻量化交互组件包（零 CDN · 原生 JS · 自动退化）
 * 参考 GitHub 设计工程规范（emilkowalski/skills、pbakaus/impeccable）与微交互模式：
 *   1. Route Progress Bar      ：同源跳转顶部 2px 细进度条（nprogress 风格）
 *   2. Sliding Segmented Pill  ：分段切换控件共享元素滑块（.auth-tabs / .ck-seg / .avatar-switcher）
 *   3. DOM FLIP Auto-Animate   ：动态列表/卡片新增项柔和入场（auto-animate 风格）
 *   4. KPI Number Ticker       ：指标数字首次呈现平滑滚动递增（保留单位节点）
 *   5. Admin Command Palette   ：后台 Ctrl+K / Cmd+K 快速检索跳转面板（cmdk 风格，继承 RBAC 菜单）
 *   6. Below-Fold Reveal       ：仅对首屏下方卡片启用渐进显现，首屏零闪烁
 *
 * 严格隔离：遇到 .ckb-page 或 /admin/dashboard（数智大屏）立即静默退出，保持大屏原样。
 */
(function () {
    "use strict";

    if (
        window.location.pathname.indexOf("/admin/dashboard") === 0 ||
        document.querySelector(".ckb-page")
    ) {
        return;
    }

    var motionQuery = window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    function isReducedMotion() {
        return !!(motionQuery && motionQuery.matches);
    }

    var EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
    var progressController = null;

    /* ============================================================
     * 1. 同源页面跳转顶部 2px 细进度条
     * ============================================================ */
    function initProgressBar() {
        if (!document.body || document.getElementById("uiProgressBar")) {
            return;
        }
        var bar = document.createElement("div");
        bar.id = "uiProgressBar";
        bar.className = "ui-progress-bar";
        bar.setAttribute("aria-hidden", "true");
        document.body.appendChild(bar);

        var hideTimer = null;

        function reset() {
            window.clearTimeout(hideTimer);
            bar.classList.remove("is-active", "is-done");
        }

        function start() {
            if (isReducedMotion()) return;
            window.clearTimeout(hideTimer);
            bar.classList.remove("is-done", "is-active");
            void bar.offsetWidth;
            bar.classList.add("is-active");
            hideTimer = window.setTimeout(reset, 6000);
        }

        document.addEventListener("click", function (e) {
            if (e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            var link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
            if (!link) return;
            var rawHref = (link.getAttribute("href") || "").trim();
            if (
                !rawHref ||
                rawHref.charAt(0) === "#" ||
                rawHref.indexOf("javascript:") === 0 ||
                rawHref.indexOf("mailto:") === 0 ||
                rawHref.indexOf("tel:") === 0 ||
                link.hasAttribute("download") ||
                link.target === "_blank"
            ) {
                return;
            }
            try {
                var targetUrl = new URL(link.href, window.location.href);
                if (targetUrl.origin !== window.location.origin) return;
                if (
                    targetUrl.pathname === window.location.pathname &&
                    targetUrl.search === window.location.search
                ) {
                    return;
                }
                start();
            } catch (err) { /* ignore invalid URL */ }
        });

        document.addEventListener("submit", function (e) {
            if (e.defaultPrevented) return;
            var form = e.target;
            if (!form || form.tagName !== "FORM") return;
            if (form.target === "_blank" || form.hasAttribute("data-no-progress")) return;
            start();
        });

        window.addEventListener("pageshow", reset);
        window.addEventListener("load", reset);

        progressController = { start: start, reset: reset };
    }

    /* ============================================================
     * 2. 分段控件共享元素滑块（.auth-tabs / .ck-seg / .avatar-switcher）
     * ============================================================ */
    function initSlidingTabs() {
        var configs = [
            { container: ".auth-tabs", item: ".auth-tab", active: "active" },
            { container: ".ck-seg", item: "button", active: "is-active" },
            { container: ".avatar-switcher", item: ".avatar-switch-btn", active: "is-active" }
        ];

        configs.forEach(function (cfg) {
            var containers = document.querySelectorAll(cfg.container);
            Array.prototype.forEach.call(containers, function (wrap) {
                if (wrap.getAttribute("data-ui-sliding") === "1") return;
                var items = Array.prototype.slice.call(wrap.children).filter(function (el) {
                    return el.matches && el.matches(cfg.item);
                });
                if (items.length < 2) return;

                wrap.setAttribute("data-ui-sliding", "1");
                var thumb = document.createElement("span");
                thumb.className = "ui-sliding-thumb";
                thumb.setAttribute("aria-hidden", "true");
                wrap.insertBefore(thumb, wrap.firstChild);
                wrap.classList.add("ui-sliding-ready", "ui-sliding-no-anim");

                var rafId = 0;
                function sync(immediate) {
                    var activeEl = null;
                    for (var i = 0; i < wrap.children.length; i++) {
                        var child = wrap.children[i];
                        if (
                            child !== thumb &&
                            child.matches &&
                            child.matches(cfg.item) &&
                            child.classList.contains(cfg.active)
                        ) {
                            activeEl = child;
                            break;
                        }
                    }
                    if (!activeEl) {
                        thumb.style.opacity = "0";
                        return;
                    }
                    var w = activeEl.offsetWidth;
                    var h = activeEl.offsetHeight;
                    if (!w || !h) {
                        thumb.style.opacity = "0";
                        return;
                    }
                    if (immediate) {
                        wrap.classList.add("ui-sliding-no-anim");
                    }
                    thumb.style.width = w + "px";
                    thumb.style.height = h + "px";
                    thumb.style.transform =
                        "translate3d(" + activeEl.offsetLeft + "px, " + activeEl.offsetTop + "px, 0)";
                    thumb.style.opacity = "1";
                    if (immediate) {
                        window.cancelAnimationFrame(rafId);
                        rafId = window.requestAnimationFrame(function () {
                            rafId = window.requestAnimationFrame(function () {
                                wrap.classList.remove("ui-sliding-no-anim");
                            });
                        });
                    }
                }

                sync(true);

                if (window.MutationObserver) {
                    var mo = new MutationObserver(function (records) {
                        var relevant = records.some(function (r) {
                            return r.target !== thumb;
                        });
                        if (relevant) sync(false);
                    });
                    mo.observe(wrap, {
                        attributes: true,
                        attributeFilter: ["class"],
                        subtree: true,
                        childList: true
                    });
                }

                if (window.ResizeObserver) {
                    var ro = new ResizeObserver(function () { sync(true); });
                    ro.observe(wrap);
                } else {
                    window.addEventListener("resize", function () { sync(true); });
                }
            });
        });
    }

    /* ============================================================
     * 3. 动态列表/卡片轻量化 FLIP 入场（auto-animate 思路）
     * ============================================================ */
    function initAutoAnimate() {
        if (isReducedMotion() || !window.MutationObserver) return;
        var selectors = ["#chatSessionList", "#riskStream", "#showcase", ".kb-table tbody"];

        selectors.forEach(function (sel) {
            var container = document.querySelector(sel);
            if (!container || container.getAttribute("data-ui-aa") === "1") return;
            container.setAttribute("data-ui-aa", "1");

            var observer = new MutationObserver(function (mutations) {
                if (isReducedMotion() || container.children.length > 40) return;
                var addedEls = [];
                mutations.forEach(function (m) {
                    Array.prototype.forEach.call(m.addedNodes, function (node) {
                        if (
                            node &&
                            node.nodeType === 1 &&
                            typeof node.animate === "function" &&
                            !node.classList.contains("ui-sliding-thumb")
                        ) {
                            addedEls.push(node);
                        }
                    });
                });
                if (!addedEls.length || addedEls.length > 40) return;
                addedEls.forEach(function (el, idx) {
                    var delay = Math.min(idx * 16, 128);
                    try {
                        el.animate(
                            [
                                { opacity: 0, transform: "translateY(6px)" },
                                { opacity: 1, transform: "translateY(0)" }
                            ],
                            {
                                duration: 200,
                                delay: delay,
                                easing: EASE_OUT,
                                fill: "backwards"
                            }
                        );
                    } catch (err) { /* ignore animation error */ }
                });
            });

            observer.observe(container, { childList: true });
        });
    }

    /* ============================================================
     * 4. KPI 指标数字滚动递增（保留单位子节点，仅首次有效值触发）
     * ============================================================ */
    function parseLeadingMetric(el) {
        var textNode = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : null;
        if (!textNode) return null;
        var raw = String(textNode.nodeValue || "");
        var match = raw.match(/^(\s*)(\d[\d,]*(?:\.\d+)?)([\s\S]*)$/);
        if (!match) return null;
        var numericStr = match[2];
        var plain = numericStr.replace(/,/g, "");
        var value = Number(plain);
        if (!isFinite(value) || value <= 0) return null;
        var dotIdx = plain.indexOf(".");
        var decimals = dotIdx >= 0 ? plain.length - dotIdx - 1 : 0;
        var useCommas = numericStr.indexOf(",") >= 0;
        return {
            textNode: textNode,
            prefix: match[1],
            suffix: match[3],
            target: value,
            decimals: decimals,
            useCommas: useCommas
        };
    }

    function formatNumber(val, decimals, useCommas) {
        if (decimals > 0) {
            var fixed = val.toFixed(decimals);
            if (!useCommas) return fixed;
            var parts = fixed.split(".");
            return Number(parts[0]).toLocaleString("en-US") + "." + parts[1];
        }
        var rounded = Math.round(val);
        return useCommas ? rounded.toLocaleString("en-US") : String(rounded);
    }

    function animateKpiElement(el) {
        if (!el || el.getAttribute("data-ui-counted") === "1" || el.__uiAnimating) return false;
        var parsed = parseLeadingMetric(el);
        if (!parsed) return false;

        el.setAttribute("data-ui-counted", "1");
        if (isReducedMotion()) return true;

        el.__uiAnimating = true;
        var duration = 420;
        var startTs = null;
        var target = parsed.target;
        var node = parsed.textNode;

        node.nodeValue = parsed.prefix + formatNumber(0, parsed.decimals, parsed.useCommas) + parsed.suffix;

        function step(ts) {
            if (!node.isConnected) {
                el.__uiAnimating = false;
                return;
            }
            if (startTs === null) startTs = ts;
            var p = Math.min((ts - startTs) / duration, 1);
            var eased = 1 - Math.pow(1 - p, 4);
            var current = target * eased;
            node.nodeValue =
                parsed.prefix +
                formatNumber(p >= 1 ? target : current, parsed.decimals, parsed.useCommas) +
                parsed.suffix;
            if (p < 1) {
                window.requestAnimationFrame(step);
            } else {
                el.__uiAnimating = false;
            }
        }
        window.requestAnimationFrame(step);
        return true;
    }

    function initCountUp() {
        var selector = ".admin-stat-value, .user-stat b, .qa-metric b, .ck-kpi-v";
        var observed = typeof WeakSet === "function" ? new WeakSet() : null;

        var io = window.IntersectionObserver
            ? new IntersectionObserver(
                  function (entries) {
                      entries.forEach(function (entry) {
                          if (!entry.isIntersecting) return;
                          var target = entry.target;
                          if (animateKpiElement(target)) {
                              io.unobserve(target);
                          }
                      });
                  },
                  { threshold: 0.1 }
              )
            : null;

        function watchElement(el) {
            if (!el || (observed && observed.has(el))) return;
            if (observed) observed.add(el);

            if (animateKpiElement(el)) return;

            if (window.MutationObserver && el.getAttribute("data-ui-counted") !== "1") {
                var mo = new MutationObserver(function () {
                    if (el.__uiAnimating || el.getAttribute("data-ui-counted") === "1") return;
                    if (parseLeadingMetric(el)) {
                        mo.disconnect();
                        if (io) io.observe(el);
                        else animateKpiElement(el);
                    }
                });
                mo.observe(el, { childList: true, characterData: true, subtree: true });
            } else if (io) {
                io.observe(el);
            }
        }

        Array.prototype.forEach.call(document.querySelectorAll(selector), watchElement);

        // 覆盖 #qaReport 动态插入的 .qa-metric b
        var qaReport = document.getElementById("qaReport");
        if (qaReport && window.MutationObserver) {
            var qaMo = new MutationObserver(function () {
                Array.prototype.forEach.call(qaReport.querySelectorAll(".qa-metric b"), watchElement);
            });
            qaMo.observe(qaReport, { childList: true, subtree: true });
        }
    }

    /* ============================================================
     * 5. 后台快速跳转命令面板（Ctrl+K / Cmd+K + 顶栏入口，继承当前用户可见菜单）
     * ============================================================ */
    function initCommandPalette() {
        var layout = document.getElementById("adminLayout");
        if (!layout) return;

        function collectRoutes() {
            var items = [];
            var seen = {};

            function pushItem(group, label, href, iconClass, newTab) {
                if (!href || href === "#" || href.indexOf("javascript:") === 0) return;
                if (seen[href]) return;
                seen[href] = true;
                items.push({
                    group: group,
                    label: label,
                    href: href,
                    icon: iconClass || "fas fa-arrow-right",
                    newTab: !!newTab,
                    searchText: (group + " " + label + " " + href).toLowerCase()
                });
            }

            // 1) 从左侧导航树提取（自动继承服务端按角色下发的菜单）
            var sideTree = layout.querySelector(".admin-side .layui-nav-tree");
            if (sideTree) {
                Array.prototype.forEach.call(sideTree.children, function (navItem) {
                    if (!navItem.classList.contains("layui-nav-item")) return;
                    var childList = navItem.querySelector("dl.layui-nav-child");
                    var parentLink = null;
                    for (var i = 0; i < navItem.children.length; i++) {
                        if (navItem.children[i].tagName === "A") {
                            parentLink = navItem.children[i];
                            break;
                        }
                    }
                    if (childList && parentLink) {
                        var groupName = (parentLink.textContent || "").trim() || "系统功能";
                        Array.prototype.forEach.call(childList.querySelectorAll("dd a[href]"), function (a) {
                            var ic = a.querySelector("i");
                            pushItem(
                                groupName,
                                (a.textContent || "").trim(),
                                a.getAttribute("href"),
                                ic ? ic.className : "fas fa-circle",
                                a.target === "_blank"
                            );
                        });
                    } else if (parentLink && parentLink.hasAttribute("href")) {
                        var ic2 = parentLink.querySelector("i");
                        pushItem(
                            "工作台",
                            (parentLink.textContent || "").trim(),
                            parentLink.getAttribute("href"),
                            ic2 ? ic2.className : "fas fa-home",
                            parentLink.target === "_blank"
                        );
                    }
                });
            }

            // 2) 补充顶栏快捷入口（如数智大屏、前台工作台等）
            Array.prototype.forEach.call(layout.querySelectorAll(".admin-header a[href]"), function (a) {
                var href = a.getAttribute("href");
                var text = (a.textContent || "").trim();
                if (!text || text === "退出登录") return;
                var ic = a.querySelector("i");
                pushItem(
                    "快捷入口",
                    text,
                    href,
                    ic ? ic.className : "fas fa-external-link-alt",
                    a.target === "_blank"
                );
            });

            return items;
        }

        var mask = null;
        var inputEl = null;
        var listEl = null;
        var activeIdx = 0;
        var filtered = [];
        var allItems = [];
        var lastFocus = null;
        var isOpen = false;

        function buildDom() {
            if (mask) return;
            mask = document.createElement("div");
            mask.className = "admin-cmdk-mask";
            mask.hidden = true;
            mask.innerHTML =
                '<div class="admin-cmdk-dialog" role="dialog" aria-modal="true" aria-label="后台快速跳转">' +
                '  <div class="admin-cmdk-head">' +
                '    <i class="fas fa-search"></i>' +
                '    <input type="text" class="admin-cmdk-input" placeholder="输入页面名称或路径（如 知识库、通知、models）…" autocomplete="off" spellcheck="false">' +
                '    <kbd class="admin-cmdk-esc">Esc</kbd>' +
                "  </div>" +
                '  <div class="admin-cmdk-list" role="listbox"></div>' +
                '  <div class="admin-cmdk-foot">' +
                '    <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>' +
                '    <span><kbd>Enter</kbd> 跳转</span>' +
                '    <span><kbd>Esc</kbd> 关闭</span>' +
                "  </div>" +
                "</div>";
            document.body.appendChild(mask);

            inputEl = mask.querySelector(".admin-cmdk-input");
            listEl = mask.querySelector(".admin-cmdk-list");

            mask.addEventListener("click", function (e) {
                if (e.target === mask) close();
            });
            mask.querySelector(".admin-cmdk-esc").addEventListener("click", close);

            inputEl.addEventListener("input", function () {
                activeIdx = 0;
                renderList(inputEl.value);
            });

            inputEl.addEventListener("keydown", function (e) {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (filtered.length) {
                        activeIdx = (activeIdx + 1) % filtered.length;
                        updateActiveItem();
                    }
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (filtered.length) {
                        activeIdx = (activeIdx - 1 + filtered.length) % filtered.length;
                        updateActiveItem();
                    }
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (filtered[activeIdx]) {
                        navigateTo(filtered[activeIdx]);
                    }
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    close();
                }
            });

            listEl.addEventListener("mousemove", function (e) {
                var btn = e.target.closest(".admin-cmdk-item");
                if (!btn) return;
                var idx = Number(btn.getAttribute("data-idx"));
                if (!isNaN(idx) && idx !== activeIdx) {
                    activeIdx = idx;
                    updateActiveItem(true);
                }
            });

            listEl.addEventListener("click", function (e) {
                var btn = e.target.closest(".admin-cmdk-item");
                if (!btn) return;
                var idx = Number(btn.getAttribute("data-idx"));
                if (filtered[idx]) navigateTo(filtered[idx]);
            });
        }

        function navigateTo(item) {
            close();
            if (item.newTab) {
                window.open(item.href, "_blank", "noopener");
                return;
            }
            if (progressController) progressController.start();
            window.location.href = item.href;
        }

        function updateActiveItem(noScroll) {
            if (!listEl) return;
            var btns = listEl.querySelectorAll(".admin-cmdk-item");
            Array.prototype.forEach.call(btns, function (btn, idx) {
                var on = idx === activeIdx;
                btn.classList.toggle("is-active", on);
                btn.setAttribute("aria-selected", on ? "true" : "false");
                if (on && !noScroll && typeof btn.scrollIntoView === "function") {
                    btn.scrollIntoView({ block: "nearest" });
                }
            });
        }

        function escHtml(s) {
            return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
                return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
            });
        }

        function renderList(query) {
            var q = String(query || "").trim().toLowerCase();
            filtered = allItems.filter(function (it) {
                return !q || it.searchText.indexOf(q) !== -1;
            });
            if (!filtered.length) {
                listEl.innerHTML =
                    '<div class="admin-cmdk-empty"><i class="fas fa-inbox"></i> 未找到匹配的后台页面</div>';
                return;
            }
            if (activeIdx >= filtered.length) activeIdx = 0;

            var html = [];
            var lastGroup = null;
            filtered.forEach(function (it, idx) {
                if (it.group !== lastGroup) {
                    lastGroup = it.group;
                    html.push('<div class="admin-cmdk-group">' + escHtml(it.group) + "</div>");
                }
                var isCur = it.href === window.location.pathname;
                html.push(
                    '<button type="button" class="admin-cmdk-item' +
                        (idx === activeIdx ? " is-active" : "") +
                        '" role="option" aria-selected="' +
                        (idx === activeIdx ? "true" : "false") +
                        '" data-idx="' +
                        idx +
                        '">' +
                        '<span class="admin-cmdk-item-icon"><i class="' +
                        escHtml(it.icon) +
                        '"></i></span>' +
                        '<span class="admin-cmdk-item-label">' +
                        escHtml(it.label) +
                        (isCur ? ' <em class="admin-cmdk-cur">当前页</em>' : "") +
                        "</span>" +
                        '<span class="admin-cmdk-item-url">' +
                        escHtml(it.href) +
                        "</span>" +
                        "</button>"
                );
            });
            listEl.innerHTML = html.join("");
        }

        function open() {
            buildDom();
            if (isOpen) {
                inputEl.focus();
                inputEl.select();
                return;
            }
            lastFocus = document.activeElement;
            allItems = collectRoutes();
            activeIdx = 0;
            inputEl.value = "";
            renderList("");
            mask.hidden = false;
            isOpen = true;
            window.requestAnimationFrame(function () {
                inputEl.focus();
            });
        }

        function close() {
            if (!mask || !isOpen) return;
            mask.hidden = true;
            isOpen = false;
            if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === "function") {
                lastFocus.focus();
            }
        }

        var triggerBtn = document.getElementById("adminCmdkBtn");
        if (triggerBtn) {
            triggerBtn.addEventListener("click", function (e) {
                e.preventDefault();
                open();
            });
        }

        document.addEventListener("keydown", function (e) {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === "k") {
                e.preventDefault();
                if (isOpen) close();
                else open();
            } else if (e.key === "Escape" && isOpen) {
                e.preventDefault();
                close();
            }
        });
    }

    /* ============================================================
     * 6. 首屏下方卡片渐进显现（首屏直接可见，无闪烁）
     * ============================================================ */
    function initScrollReveal() {
        if (isReducedMotion() || !window.IntersectionObserver) return;
        var targets = document.querySelectorAll(".admin-card, .ck-panel, .user-card, .panel");
        if (!targets.length) return;

        var vh = window.innerHeight || document.documentElement.clientHeight || 800;
        var belowFold = [];

        Array.prototype.forEach.call(targets, function (el) {
            var rect = el.getBoundingClientRect();
            if (rect.top >= vh * 0.96) {
                el.classList.add("ui-reveal");
                belowFold.push(el);
            }
        });

        if (!belowFold.length) return;

        var io = new IntersectionObserver(
            function (entries) {
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) return;
                    entry.target.classList.add("is-visible");
                    io.unobserve(entry.target);
                });
            },
            { threshold: 0.06 }
        );

        belowFold.forEach(function (el) {
            io.observe(el);
        });
    }

    function boot() {
        initProgressBar();
        initSlidingTabs();
        initAutoAnimate();
        initCountUp();
        initCommandPalette();
        initScrollReveal();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
