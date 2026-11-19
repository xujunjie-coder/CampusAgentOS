/**
 * dashboard.js —— 数智大屏（成员 C）
 *
 * 数据链路：EventSource(/api/stats/stream) 首帧 bootstrap + 周期 snapshot；
 *          断线时 EventSource 自动重连，重连成功会再发一帧 bootstrap 覆盖旧数据。
 * 图表：全部走 ChartKit（暗色主题 / 自适应 / 空态 / 回收）。
 * 语音：TTS 用浏览器原生 speechSynthesis 播报指标；ASR 用 webkitSpeechRecognition，
 *      不可用时在浮层里明确提示"请键盘输入"，不静默失败。
 */
(function () {
    'use strict';

    var C = window.Console;
    var PAGE = document.getElementById('consolePage');
    var REFRESH = parseInt(PAGE.getAttribute('data-refresh'), 10) || 10;
    var state = {
        snap: null, sse: null, sound: localStorage.getItem('ckb_sound') !== '0',
        lastHigh: null, speaking: false, listening: false, charts: {}
    };

    function id(name) { return document.getElementById(name); }

    function setKpi(boxId, value, unit, subText, subId) {
        var box = id(boxId);
        if (box) { box.innerHTML = C.fmtNum(value) + '<small>' + unit + '</small>'; }
        if (subId && subText !== undefined) { var s = id(subId); if (s) { s.textContent = subText; } }
    }

    /* ---------------- 时钟 ---------------- */
    function tickClock() {
        var now = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        id('clock').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
        var week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
        id('today').textContent = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
            + ' 星期' + week;
    }

    /* ---------------- 图表 ---------------- */
    function renderTrend(trend) {
        var rows = (trend || []).slice(-14);
        var categories = rows.map(function (d) { return (d.date || '').slice(5); });
        var collect = rows.map(function (d) { return d.collect || 0; });
        var messages = rows.map(function (d) { return d.messages || 0; });
        state.charts.trend = window.ChartKit.renderLine('#chartTrend', {
            dark: true, categories: categories,
            series: [
                { name: '采集条目', data: collect, area: true, color: '#4ea1ff' },
                { name: '对话消息', data: messages, area: true, color: '#37d0c4' }
            ],
            grid: { left: 40, right: 14, top: 28, bottom: 22 },
            empty: '近 14 日暂无采集/对话数据'
        });
    }

    function renderMap(region) {
        var list = (region && region.list) || [];
        var tip = id('mapTip');
        var sub = id('mapSub');
        if (region) {
            sub.textContent = region.matched
                ? ('命中 ' + region.matched + ' / 扫描 ' + region.scanned + ' 篇')
                : '未识别到省级提及';
            tip.textContent = '口径：按采集标题/摘要中出现的省级行政区或省会城市计数，共扫描 '
                + region.scanned + ' 篇；这是文本提及热度，不是采集地分布。';
        }
        window.ChartKit.loadChinaMap('/static/vendor/echarts/china.json').then(function () {
            var dom = id('chartMap');
            if (!list.length) {
                window.ChartKit.clearEmpty(dom);
            }
            state.charts.map = window.ChartKit.renderChinaMap('#chartMap', {
                dark: true, data: list, max: (region && region.max) || 1, roam: false, zoom: 1.2
            });
        }).catch(function (err) {
            window.ChartKit.empty('#chartMap', err.message || '地图数据加载失败');
        });
    }

    function renderRisk(byRisk) {
        var rows = byRisk || [];
        var total = rows.reduce(function (sum, r) { return sum + (r.count || 0); }, 0);
        id('riskTotal').textContent = '共 ' + total + ' 条';
        var colors = { high: '#ff6b61', watch: '#ffc86b', normal: '#5fe3b5', error: '#7fa3cf' };
        state.charts.risk = window.ChartKit.renderPie('#chartRisk', {
            dark: true,
            data: rows.map(function (r) { return { name: r.label, value: r.count || 0, color: colors[r.level] }; }),
            radius: ['46%', '70%'], center: ['38%', '50%'], legendOrient: 'vertical', legendRight: 4,
            empty: '暂无风险分析结果'
        });
    }

    function renderSource(items) {
        var rows = (items || []).map(function (r) { return { name: r.source_name, value: r.count }; });
        state.charts.source = window.ChartKit.renderRankBar('#chartSource', {
            dark: true, data: rows, suffix: ' 条', barMaxWidth: 13, empty: '暂无信源采集记录'
        });
    }

    /* ---------------- 列表 ---------------- */
    function renderFeed(risks) {
        var list = id('feedRisk');
        var rows = risks || [];
        id('feedSub').textContent = rows.length ? ('最近 ' + rows.length + ' 条') : '暂无预警';
        if (!rows.length) {
            list.innerHTML = '<li class="ckb-feed-empty">当前没有风险线索，采集分析结果会实时出现在这里。</li>';
            return;
        }
        list.innerHTML = rows.map(function (r) {
            return '<li><i class="lv ' + C.esc(r.level) + '"></i>' +
                '<span class="txt"><b>' + C.esc(r.title || '') + '</b></span>' +
                '<span class="meta">' + C.esc(r.level_label || '') + ' · ' +
                C.esc(C.fmtTime(r.reviewed_at)) + '</span></li>';
        }).join('');
    }

    function renderHotwords(keywords) {
        var rows = keywords || [];
        var box = id('hotwords');
        if (!rows.length) {
            box.innerHTML = '<span class="hw-label">热词</span><span class="hw">暂无</span>';
            return;
        }
        box.innerHTML = '<span class="hw-label">热词</span>' + rows.slice(0, 9).map(function (r) {
            return '<span class="hw">' + C.esc(r.keyword) + '<b>' + C.fmtNum(r.count) + '</b></span>';
        }).join('');
    }

    function renderTicker(items) {
        var rows = items || [];
        var box = id('footTicker');
        if (!rows.length) { box.innerHTML = '<span>暂无采集记录</span>'; return; }
        var text = rows.map(function (r) {
            return '<b>' + C.esc(r.source_name || '未知信源') + '</b> ' + C.esc(r.title || '') +
                ' <span style="color:#6f93bd">(' + C.esc(C.fmtTime(r.collected_at)) + ')</span>';
        }).join(' <span style="color:#4ea1ff">·</span> ');
        box.innerHTML = '<span>' + text + '</span>';
    }

    /* ---------------- 快照应用 ---------------- */
    function applySnapshot(snap) {
        if (!snap) { return; }
        state.snap = snap;
        var ov = snap.overview || {};
        var wh = ov.warehouse || {};
        var whDone = (typeof wh === 'object') ? (wh.done || 0) : (wh || 0);
        var risk = (ov.risk && ov.risk.counts) || {};
        var token = ov.token || {};

        setKpi('kpiCollect', ov.collect_total, '条');
        setKpi('kpiToday', ov.collect_today, '条');
        setKpi('kpiWarehouse', whDone, '篇');
        setKpi('kpiRiskHigh', risk.high || 0, '条');
        setKpi('kpiToken', token.call_count, '次');
        setKpi('kpiActive', ov.active_sessions, '个');
        id('kpiCollectSub').textContent = '今日新增 ' + C.fmtNum(ov.collect_today || 0);
        id('kpiRiskSub').textContent = '关注 ' + C.fmtNum(risk.watch || 0) + ' · 待复核 ' + C.fmtNum(risk.error || 0);
        id('kpiTokenSub').textContent = 'Token ' + C.fmtNum(token.token_total || 0);
        id('kpiUserSub').textContent = '用户 ' + C.fmtNum(ov.users || 0) + ' · 消息 ' + C.fmtNum(ov.messages || 0);

        renderTrend(snap.trend);
        renderMap(snap.by_region);
        renderRisk(snap.by_risk);
        renderSource(snap.by_source);
        renderFeed(snap.latest_risks);
        renderHotwords(snap.keywords);
        renderTicker(snap.recent_items);
        id('genTime').textContent = snap.generated_at || '-';

        // 高风险增量播报：只在开启了"播报"且高风险条数上升时提示，避免重复噪音
        var high = risk.high || 0;
        if (state.lastHigh !== null && high > state.lastHigh && state.sound) {
            speak('注意，新增 ' + (high - state.lastHigh) + ' 条高风险线索，请到智能舆情页复核。');
        }
        state.lastHigh = high;
    }

    /* ---------------- SSE ---------------- */
    function connect() {
        if (state.sse) { state.sse.close(); }
        var url = '/api/stats/stream?interval=' + REFRESH + '&days=14';
        var es = new EventSource(url);
        state.sse = es;
        es.addEventListener('bootstrap', function (e) { onPayload(e); });
        es.addEventListener('snapshot', function (e) { onPayload(e); });
        es.onopen = function () { live(true, '实时推送中'); };
        es.onerror = function () {
            // EventSource 会按浏览器策略自动重连；这里只更新状态，不重复 new
            live(false, '连接中断，重试中');
        };
    }

    function onPayload(e) {
        try {
            applySnapshot(JSON.parse(e.data));
            live(true, '实时推送中');
        } catch (err) {
            console.error('大屏数据解析失败', err);
        }
    }

    function live(on, text) {
        var box = id('liveFlag');
        box.classList.toggle('is-on', !!on);
        id('liveText').textContent = text || (on ? '实时推送中' : '未连接');
    }

    /* ---------------- 语音 ---------------- */
    function pickVoice() {
        if (!window.speechSynthesis) { return null; }
        var voices = window.speechSynthesis.getVoices() || [];
        for (var i = 0; i < voices.length; i += 1) {
            if ((voices[i].lang || '').indexOf('zh') === 0) { return voices[i]; }
        }
        return voices[0] || null;
    }

    function speak(text) {
        if (!state.sound || !text) { return; }
        if (!window.speechSynthesis) {
            C.toast('当前浏览器不支持语音播报，请使用 Chrome / Edge', 'error');
            return;
        }
        try {
            window.speechSynthesis.cancel();
            var utter = new SpeechSynthesisUtterance(String(text).slice(0, 260));
            utter.lang = 'zh-CN';
            utter.rate = 1.05;
            var voice = pickVoice();
            if (voice) { utter.voice = voice; }
            window.speechSynthesis.speak(utter);
        } catch (err) {
            C.toast('语音播报失败：' + err.message, 'error');
        }
    }

    function setSound(on) {
        state.sound = !!on;
        localStorage.setItem('ckb_sound', on ? '1' : '0');
        var btn = id('btnSound');
        btn.innerHTML = '<i class="fas fa-' + (on ? 'volume-up' : 'volume-mute') + '"></i> ' + (on ? '播报开' : '播报关');
        btn.classList.toggle('is-primary', !!on);
        if (!on && window.speechSynthesis) { window.speechSynthesis.cancel(); }
    }

    /* ---------------- 问答 ---------------- */
    function appendBubble(text, mine, chips) {
        var log = id('askLog');
        var div = document.createElement('div');
        div.className = mine ? 'ckb-ask-q' : 'ckb-ask-a';
        var html = C.esc(text);
        if (!mine && chips && chips.length) {
            html += '<div class="chips">' + chips.map(function (c) {
                return '<span>' + C.esc(c.label) + ' ' + C.esc(c.value) + C.esc(c.unit || '') + '</span>';
            }).join('') + '</div>';
        }
        div.innerHTML = html;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
        return div;
    }

    function ask(question) {
        var text = (question || '').trim();
        if (!text) { return; }
        appendBubble(text, true);
        id('askInput').value = '';
        var pending = appendBubble('正在按库内口径统计…', false);
        C.api('POST', '/api/dashboard/ask', { question: text }).then(function (res) {
            pending.innerHTML = C.esc(res.answer || '暂无结论');
            if (res.chips && res.chips.length) {
                var chips = document.createElement('div');
                chips.className = 'chips';
                chips.innerHTML = res.chips.map(function (c) {
                    return '<span>' + C.esc(c.label) + ' ' + C.esc(c.value) + C.esc(c.unit || '') + '</span>';
                }).join('');
                pending.appendChild(chips);
            }
            id('askLog').scrollTop = id('askLog').scrollHeight;
            speak(res.speak || res.answer);
        }).catch(function (err) {
            pending.innerHTML = '回答失败：' + C.esc(err.message);
        });
    }

    function setupAsr() {
        var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
        var tip = id('asrTip');
        if (!Ctor) {
            tip.textContent = '语音输入不可用（当前浏览器不支持 Web Speech），请键盘输入';
            return;
        }
        var rec = new Ctor();
        rec.lang = 'zh-CN';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        var mic = id('btnMic');
        rec.onstart = function () {
            state.listening = true;
            mic.classList.add('is-listening');
            tip.textContent = '正在聆听…说完会自动提问';
        };
        rec.onend = function () {
            state.listening = false;
            mic.classList.remove('is-listening');
            tip.textContent = '语音识别：浏览器原生 Web Speech，不可用时请键盘输入';
        };
        rec.onerror = function (e) {
            tip.textContent = '语音识别未成功（' + e.error + '），请键盘输入';
        };
        rec.onresult = function (e) {
            var text = (e.results && e.results[0] && e.results[0][0].transcript) || '';
            if (text) {
                id('askInput').value = text;
                ask(text);
            }
        };
        mic.addEventListener('click', function () {
            if (state.listening) { rec.stop(); return; }
            try { rec.start(); } catch (err) { C.toast('无法启动语音识别：' + err.message, 'error'); }
        });
    }

    /* ---------------- 交互绑定 ---------------- */
    function bind() {
        id('btnAsk').addEventListener('click', function () { ask(id('askInput').value); });
        id('askInput').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); ask(id('askInput').value); }
        });
        id('btnSound').addEventListener('click', function () { setSound(!state.sound); });
        id('btnRefresh').addEventListener('click', function () {
            C.api('GET', '/api/stats/snapshot?days=14').then(function (res) {
                applySnapshot(res.snapshot);
                C.toast('已刷新', 'ok');
            }).catch(function (err) { C.toast(err.message, 'error'); });
        });
        id('btnFull').addEventListener('click', function () {
            if (!document.fullscreenElement) {
                (PAGE.requestFullscreen || PAGE.webkitRequestFullscreen || function () {}).call(PAGE);
            } else {
                (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
            }
        });
        var head = id('askHead');
        head.addEventListener('click', function () {
            var panel = id('askPanel');
            var min = panel.classList.toggle('is-min');
            id('askToggle').textContent = min ? '展开' : '收起';
        });
        // 首次播报需要用户手势解锁（浏览器策略），点击顶栏"播报开"即触发一次示例朗读
        id('btnSound').addEventListener('click', function () {
            if (state.sound && state.snap) {
                var ov = state.snap.overview || {};
                speak('已开启语音播报。当前累计采集 ' + (ov.collect_total || 0) + ' 条。');
            }
        });
    }

    function boot() {
        tickClock();
        setInterval(tickClock, 1000);
        setSound(state.sound);
        bind();
        setupAsr();
        connect();
        // 兜底：SSE 首帧偶尔被代理吞掉时，3 秒后主动拉一次快照
        setTimeout(function () {
            if (!state.snap) {
                C.api('GET', '/api/stats/snapshot?days=14').then(function (res) {
                    applySnapshot(res.snapshot);
                }).catch(function () { /* SSE 仍在重试 */ });
            }
        }, 3000);
        window.addEventListener('beforeunload', function () {
            if (state.sse) { state.sse.close(); }
            if (window.speechSynthesis) { window.speechSynthesis.cancel(); }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
