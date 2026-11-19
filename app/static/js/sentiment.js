/**
 * sentiment.js —— 智能舆情预警台（成员 C）
 *
 * 后端契约（成员 B/A 已实现，前端只消费）：
 *   GET  /admin/sentiment             服务端渲染首屏 reviews
 *   POST /admin/sentiment             触发 review_pending()，返回本批结果
 *   WS   /ws/admin/sentiment          每 3 秒推送 {"reviews":[...]}，数据变化时才推
 *   GET  /api/stats/snapshot          风险走势与等级计数（与报表同源）
 *
 * 前端职责：等级筛选、高风险高亮/声音/桌面通知、断线重连、首屏不被 WS 覆盖成空。
 */
(function () {
    'use strict';

    var C = window.Console;
    var LABELS = { high: '高风险', watch: '关注', normal: '常规', error: '待重试' };
    var state = {
        ws: null, reviews: null, filter: '', sound: localStorage.getItem('ck_sentiment_sound') === '1',
        notify: false, knownHigh: {}, retry: 0, firstPush: true
    };

    function id(name) { return document.getElementById(name); }

    /* ---------------- 声音 / 通知 ---------------- */
    function beep() {
        try {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) { return; }
            var ctx = new Ctx();
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 880;
            gain.gain.value = 0.12;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            setTimeout(function () { osc.stop(); ctx.close(); }, 260);
        } catch (err) { /* 浏览器策略限制时静默 */ }
    }

    function setSound(on) {
        state.sound = !!on;
        localStorage.setItem('ck_sentiment_sound', on ? '1' : '0');
        var el = id('soundToggle');
        el.classList.toggle('is-on', on);
        el.innerHTML = '<i class="fas fa-' + (on ? 'volume-up' : 'volume-mute') + '"></i> 声音提醒';
        if (on) { beep(); }
    }

    function setNotify(on) {
        state.notify = !!on;
        var el = id('notifyToggle');
        el.classList.toggle('is-on', on);
        el.innerHTML = '<i class="fas fa-' + (on ? 'bell' : 'bell-slash') + '"></i> 桌面通知';
        if (on && window.Notification && Notification.permission === 'default') {
            Notification.requestPermission().then(function (perm) {
                if (perm !== 'granted') { setNotify(false); C.toast('桌面通知未授权', 'error'); }
            });
        }
        if (on && window.Notification && Notification.permission === 'denied') {
            setNotify(false);
            C.toast('浏览器已拒绝通知权限', 'error');
        }
    }

    /* ---------------- 列表渲染 ---------------- */
    function rowHtml(r) {
        var level = r.level || 'normal';
        var title = r.url
            ? '<a href="' + C.esc(r.url) + '" target="_blank" rel="noopener">' + C.esc(r.title || '（无标题）') + '</a>'
            : C.esc(r.title || '（无标题）');
        return '<div class="ck-stream-row' + (level === 'high' ? ' is-high' : '') +
            '" data-level="' + C.esc(level) + '" data-id="' + C.esc(r.id) + '">' +
            '<div class="ck-stream-main">' +
            '<div class="ck-stream-title">' + title + '</div>' +
            '<div class="ck-stream-meta">' +
            '<span class="ck-badge ' + C.esc(level) + '">' + C.esc(LABELS[level] || level) + '</span>' +
            '<span><i class="fas fa-rss"></i> ' + C.esc(r.source_name || '未知信源') + '</span>' +
            '<span><i class="fas fa-clock"></i> ' + C.esc(C.fmtTime(r.reviewed_at)) + '</span>' +
            '</div>' +
            (r.reason ? '<div class="ck-stream-reason"><b>分析结论：</b>' + C.esc(r.reason) +
                (r.evidence ? '<br><b>证据片段：</b>' + C.esc(r.evidence) : '') + '</div>' : '') +
            '</div>' +
            '<div class="ck-stream-side"><span class="ck-badge ' + C.esc(level) + '">#' + C.esc(r.id) + '</span></div>' +
            '</div>';
    }

    function domRows() {
        var box = id('riskStream');
        return box ? Array.prototype.slice.call(box.querySelectorAll('.ck-stream-row')) : [];
    }

    function countsFromDom() {
        var counts = { high: 0, watch: 0, normal: 0, error: 0 };
        domRows().forEach(function (row) {
            var lv = row.getAttribute('data-level');
            counts[lv] = (counts[lv] || 0) + 1;
        });
        return counts;
    }

    function applyCounts(counts, total) {
        id('kpiHigh').innerHTML = C.fmtNum(counts.high || 0) + '<small>条</small>';
        id('kpiWatch').innerHTML = C.fmtNum(counts.watch || 0) + '<small>条</small>';
        id('kpiNormal').innerHTML = C.fmtNum(counts.normal || 0) + '<small>条</small>';
        id('kpiError').innerHTML = C.fmtNum(counts.error || 0) + '<small>条</small>';
        id('totalCount').textContent = total;
        var warning = id('reviewWarning');
        var failed = counts.error || 0;
        warning.hidden = !failed;
        warning.textContent = failed
            ? '当前列表有 ' + C.fmtNum(failed) + ' 条舆情分析待重试。点击「分析待处理条目」可重新分析。'
            : '';
    }

    function renderList() {
        var box = id('riskStream');
        // WS 还没推第一帧时，直接对服务端渲染的行做显隐：点筛选立刻见效，不会把整页清空
        if (state.reviews === null) {
            var shown = 0;
            domRows().forEach(function (row) {
                var hit = !state.filter || row.getAttribute('data-level') === state.filter;
                row.style.display = hit ? '' : 'none';
                if (hit) { shown += 1; }
            });
            var placeholder = box.querySelector('.ck-dom-empty');
            if (!shown) {
                if (!placeholder) {
                    placeholder = document.createElement('div');
                    placeholder.className = 'ck-dom-empty';
                    placeholder.style.cssText = 'padding:32px;text-align:center;color:#9aa4b2;';
                    box.appendChild(placeholder);
                }
                placeholder.textContent = state.filter ? '该等级下暂无记录' : '暂无风险分析记录';
            } else if (placeholder) {
                placeholder.parentNode.removeChild(placeholder);
            }
            return;
        }
        var rows = state.reviews.filter(function (r) {
            return !state.filter || r.level === state.filter;
        });
        if (!rows.length) {
            box.innerHTML = '<div style="padding:32px;text-align:center;color:#9aa4b2;">' +
                (state.filter ? '该等级下暂无记录' : '暂无风险分析记录') + '</div>';
            return;
        }
        box.innerHTML = rows.map(rowHtml).join('');
    }

    function updateCounts() {
        if (state.reviews === null) {
            applyCounts(countsFromDom(), domRows().length);
            return;
        }
        var counts = { high: 0, watch: 0, normal: 0, error: 0 };
        state.reviews.forEach(function (r) { counts[r.level] = (counts[r.level] || 0) + 1; });
        applyCounts(counts, state.reviews.length);
    }

    /* ---------------- 新高风险提醒 ---------------- */
    function detectNewHigh(rows) {
        var newOnes = [];
        rows.forEach(function (r) {
            if (r.level !== 'high') { return; }
            if (!state.knownHigh[r.id]) {
                state.knownHigh[r.id] = true;
                if (!state.firstPush) { newOnes.push(r); }
            }
        });
        if (!newOnes.length) { return; }
        if (state.sound) { beep(); }
        var top = newOnes[0];
        C.toast('新增 ' + newOnes.length + ' 条高风险线索：' + (top.title || '').slice(0, 28), 'error');
        if (state.notify && window.Notification && Notification.permission === 'granted') {
            try {
                new Notification('智能舆情 · 高风险预警', {
                    body: newOnes.length + ' 条新线索，最新：' + (top.title || ''),
                    tag: 'gov-risk-' + top.id
                });
            } catch (err) { /* ignore */ }
        }
        var box = id('riskStream');
        var first = box.querySelector('.ck-stream-row');
        if (first) { first.classList.add('is-new'); }
    }

    /* ---------------- WS ---------------- */
    function setWsFlag(on, text) {
        id('wsFlag').classList.toggle('is-on', !!on);
        id('wsText').textContent = text;
    }

    function connect() {
        if (state.ws) { try { state.ws.close(); } catch (e) {} }
        var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var ws = new WebSocket(scheme + location.host + '/ws/admin/sentiment');
        state.ws = ws;
        ws.onopen = function () {
            state.retry = 0;
            setWsFlag(true, '实时推送中');
        };
        ws.onmessage = function (e) {
            var payload;
            try { payload = JSON.parse(e.data); } catch (err) { return; }
            if (!payload || !Array.isArray(payload.reviews)) { return; }
            state.reviews = payload.reviews;
            updateCounts();
            renderList();
            detectNewHigh(payload.reviews);
            state.firstPush = false;
        };
        ws.onclose = function () {
            setWsFlag(false, '连接已断开');
            if (state.retry < 8) {
                state.retry += 1;
                setTimeout(connect, 2500);
            }
        };
        ws.onerror = function () { setWsFlag(false, '连接异常，重试中'); };
    }

    /* ---------------- 风险走势 ---------------- */
    function renderTrend(rt) {
        var RISK_COLORS = { high: '#e5544b', watch: '#f0a83a', normal: '#23b26d', error: '#7c879c' };
        var data = rt || { dates: [], series: [] };
        window.ChartKit.renderBar('#chartRiskTrend', {
            categories: (data.dates || []).map(function (d) { return (d || '').slice(5); }),
            series: (data.series || []).map(function (s) {
                return { name: s.label, data: s.data, color: RISK_COLORS[s.key] || '#8a7bf0' };
            }),
            stack: true, legend: true, barMaxWidth: 20, empty: '近 7 日暂无风险记录'
        });
    }

    function loadSnapshot() {
        C.api('GET', '/api/stats/snapshot?days=7').then(function (res) {
            var snap = res.snapshot || {};
            renderTrend(snap.risk_trend);
            // 首屏若 WS 还没推第一帧，先用快照里的等级计数填 KPI（页面无服务端行时才用）
            if (state.reviews === null && !domRows().length) {
                var byRisk = snap.by_risk || [];
                var map = {};
                byRisk.forEach(function (r) { map[r.level] = r.count; });
                id('kpiHigh').innerHTML = C.fmtNum(map.high || 0) + '<small>条</small>';
                id('kpiWatch').innerHTML = C.fmtNum(map.watch || 0) + '<small>条</small>';
                id('kpiNormal').innerHTML = C.fmtNum(map.normal || 0) + '<small>条</small>';
                id('kpiError').innerHTML = C.fmtNum(map.error || 0) + '<small>条</small>';
            }
        }).catch(function (err) {
            console.warn('风险快照加载失败', err);
        });
    }

    /* ---------------- 绑定 ---------------- */
    function bind() {
        Array.prototype.forEach.call(id('levelFilter').querySelectorAll('button'), function (btn) {
            btn.addEventListener('click', function () {
                state.filter = btn.getAttribute('data-level') || '';
                C.tabSwitch(id('levelFilter'), 'data-level', state.filter);
                renderList();
            });
        });
        id('soundToggle').addEventListener('click', function () { setSound(!state.sound); });
        id('notifyToggle').addEventListener('click', function () { setNotify(!state.notify); });
        id('btnReload').addEventListener('click', function () {
            state.retry = 0;
            connect();
            loadSnapshot();
            C.toast('已重新连接推送', 'ok');
        });
        var form = id('reviewForm');
        if (form) {
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                var btn = id('btnReview');
                if (btn.disabled) { return; }
                var label = btn.innerHTML;
                var started = Date.now();
                function updateButton() {
                    var seconds = Math.floor((Date.now() - started) / 1000);
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在分析 · ' + seconds + ' 秒';
                }
                btn.disabled = true;
                btn.classList.add('layui-btn-disabled');
                updateButton();
                var timer = setInterval(updateButton, 1000);
                C.api('POST', form.action, {}).then(function (res) {
                    if (res.busy) {
                        C.toast('已有一批手动分析正在运行', 'ok');
                    } else if (!res.result.processed) {
                        C.toast('暂无可分析条目，正在分析的条目会自动更新', 'ok');
                    } else {
                        var result = res.result;
                        C.toast('本次处理 ' + result.processed + ' 条，' + result.failed + ' 条待重试',
                            result.failed ? 'error' : 'ok');
                    }
                    loadSnapshot();
                }).catch(function () {
                    C.toast('分析请求失败，请重试', 'error');
                }).finally(function () {
                    clearInterval(timer);
                    btn.disabled = false;
                    btn.classList.remove('layui-btn-disabled');
                    btn.innerHTML = label;
                });
            });
        }
        window.addEventListener('beforeunload', function () {
            if (state.ws) { state.ws.close(); }
        });
    }

    function boot() {
        setSound(state.sound);
        updateCounts();
        bind();
        loadSnapshot();
        connect();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
