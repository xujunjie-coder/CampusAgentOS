/**
 * reports.js —— 统计报表（成员 C）
 *
 * 四个分区：趋势（双 Y 轴：条数 / Token）/ 风险构成 / 信源分布 / 风险走势 / 热词 / 最新清单。
 * 自选图例：趋势区的三个系列可单独勾选，变化即时重绘。
 * 实时推送：开关打开后走 EventSource(/api/stats/stream)，关闭则按需手动刷新。
 * 导出：每个分区右上角 PNG；"导出全部"依次导出六个图（表格不导出）。
 */
(function () {
    'use strict';

    var C = window.Console;
    var state = { days: 14, live: false, sse: null, snap: null, visible: { collect: true, messages: true, tokens: true } };

    function id(name) { return document.getElementById(name); }

    var RISK_COLORS = { high: '#c41230', watch: '#d97706', normal: '#0f766e', error: '#64748b' };

    function kpi(boxId, value, unit) {
        var box = id(boxId);
        if (box) { box.innerHTML = C.fmtNum(value) + '<small>' + unit + '</small>'; }
    }

    /* ---------------- 趋势（双 Y 轴，自行组装 option 以支持 Token 右轴） ---------------- */
    function renderTrend(rows) {
        var list = rows || [];
        var categories = list.map(function (d) { return (d.date || '').slice(5); });
        var collect = list.map(function (d) { return d.collect || 0; });
        var messages = list.map(function (d) { return d.messages || 0; });
        var tokens = list.map(function (d) { return d.tokens || 0; });

        var inst = window.ChartKit.init('#chartTrend');
        if (!inst) { return; }
        var theme = window.ChartKit.theme(false);
        var gradient = function (color) {
            return new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: window.ChartKit.hexA(color, 0.34) },
                { offset: 1, color: window.ChartKit.hexA(color, 0.02) }
            ]);
        };
        var option = {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'inherit', color: theme.text },
            animation: !document.hidden,
            animationDuration: 280,
            tooltip: {
                trigger: 'axis', backgroundColor: theme.tooltipBg, borderColor: theme.tooltipBorder,
                textStyle: { color: theme.tooltipText, fontSize: 12 }
            },
            legend: { show: false },
            grid: { left: 44, right: 54, top: 18, bottom: 26 },
            xAxis: {
                type: 'category', data: categories, boundaryGap: false,
                axisLine: { lineStyle: { color: theme.axis } }, axisTick: { show: false },
                axisLabel: { color: theme.sub, fontSize: 11 }
            },
            yAxis: [
                { type: 'value', name: '条', nameTextStyle: { color: theme.sub, fontSize: 11 },
                  axisLine: { show: false }, axisTick: { show: false },
                  axisLabel: { color: theme.sub, fontSize: 11 },
                  splitLine: { lineStyle: { color: theme.split, type: 'dashed' } } },
                { type: 'value', name: 'Token', nameTextStyle: { color: theme.sub, fontSize: 11 },
                  axisLine: { show: false }, axisTick: { show: false },
                  axisLabel: { color: theme.sub, fontSize: 11,
                      formatter: function (v) { return v >= 10000 ? (v / 10000) + '万' : v; } },
                  splitLine: { show: false } }
            ],
            series: [
                { name: '采集条目', type: 'line', yAxisIndex: 0, smooth: true, symbolSize: 5,
                  data: collect, show: state.visible.collect,
                  lineStyle: { width: 2, color: '#003087' }, itemStyle: { color: '#003087' },
                  areaStyle: { color: gradient('#003087') } },
                { name: '对话消息', type: 'line', yAxisIndex: 0, smooth: true, symbolSize: 5,
                  data: messages, show: state.visible.messages,
                  lineStyle: { width: 2, color: '#0f766e' }, itemStyle: { color: '#0f766e' },
                  areaStyle: { color: gradient('#0f766e') } },
                { name: '模型 Token', type: 'bar', yAxisIndex: 1, barMaxWidth: 12,
                  data: tokens, show: state.visible.tokens,
                  itemStyle: { color: 'rgba(180,83,9,.45)', borderRadius: [3, 3, 0, 0] } }
            ]
        };
        inst.setOption(option, true);
        window.ChartKit.clearEmpty('#chartTrend');
    }

    /* ---------------- 风险构成 ---------------- */
    function renderRisk(byRisk) {
        var rows = byRisk || [];
        var data = rows.map(function (r) {
            return { name: r.label, value: r.count || 0, color: RISK_COLORS[r.level] || '#8a7bf0' };
        }).filter(function (d) { return d.value > 0; });
        var total = (byRisk || []).reduce(function (sum, r) { return sum + (r.count || 0); }, 0);
        window.ChartKit.renderPie('#chartRisk', {
            data: data, radius: ['44%', '68%'], center: ['42%', '52%'],
            legendOrient: 'vertical', legendRight: 2,
            empty: total ? '暂无数据' : '暂无风险分析结果'
        });
    }

    /* ---------------- 信源分布 ---------------- */
    function renderSource(items) {
        var rows = (items || []).map(function (r) { return { name: r.source_name, value: r.count }; });
        var active = document.querySelector('#sourceType .is-active');
        var mode = active ? active.getAttribute('data-type') : 'rank';
        if (mode === 'pie') {
            window.ChartKit.renderPie('#chartSource', {
                data: rows, radius: ['42%', '66%'], center: ['40%', '52%'],
                legendOrient: 'vertical', legendRight: 0, empty: '暂无信源采集记录'
            });
        } else {
            window.ChartKit.renderRankBar('#chartSource', {
                data: rows, suffix: ' 条', barMaxWidth: 14, empty: '暂无信源采集记录'
            });
        }
    }

    /* ---------------- 近 7 日风险走势（堆叠柱） ---------------- */
    function renderRiskTrend(riskTrend) {
        var rt = riskTrend || { dates: [], series: [] };
        var series = (rt.series || []).map(function (s) {
            return { name: s.label, data: s.data, color: RISK_COLORS[s.key] || '#8a7bf0' };
        });
        window.ChartKit.renderBar('#chartRiskTrend', {
            categories: (rt.dates || []).map(function (d) { return (d || '').slice(5); }),
            series: series, stack: true, legend: true, barMaxWidth: 22,
            empty: '近 7 日暂无风险复核记录'
        });
    }

    /* ---------------- 热词 ---------------- */
    function renderKeywords(items) {
        var rows = (items || []).map(function (r) { return { name: r.keyword, value: r.count }; });
        window.ChartKit.renderRankBar('#chartKeywords', {
            data: rows.slice(0, 16), suffix: ' 次', barMaxWidth: 12, empty: '暂无关键词统计'
        });
    }

    /* ---------------- 最新清单 ---------------- */
    function renderTable(items) {
        var body = id('latestBody');
        var rows = items || [];
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="3" style="color:#9aa4b2;">暂无采集记录</td></tr>';
            return;
        }
        body.innerHTML = rows.map(function (r) {
            return '<tr><td class="col-title"><a href="' + C.esc(r.url || '#') + '" target="_blank" rel="noopener">'
                + C.esc(r.title || '（无标题）') + '</a></td>' +
                '<td>' + C.esc(r.source_name || '-') + '</td>' +
                '<td class="num">' + C.esc(C.fmtTime(r.collected_at)) + '</td></tr>';
        }).join('');
    }

    /* ---------------- 快照应用 ---------------- */
    function apply(snap) {
        if (!snap) { return; }
        state.snap = snap;
        var ov = snap.overview || {};
        var wh = ov.warehouse || {};
        var whDone = (typeof wh === 'object') ? (wh.done || 0) : (wh || 0);
        var risk = (ov.risk && ov.risk.counts) || {};
        var token = ov.token || {};

        kpi('kpiCollect', ov.collect_total, '条');
        kpi('kpiToday', ov.collect_today, '条');
        kpi('kpiWarehouse', whDone, '篇');
        kpi('kpiRisk', risk.high || 0, '条');
        kpi('kpiCalls', token.call_count, '次');
        kpi('kpiActive', ov.active_sessions, '个');
        id('kpiCollectSub').textContent = '今日 ' + C.fmtNum(ov.collect_today || 0);
        id('kpiWarehouseSub').textContent = '失败 ' + C.fmtNum((typeof wh === 'object' && wh.failed) || 0);
        id('kpiRiskSub').textContent = '关注 ' + C.fmtNum(risk.watch || 0);
        id('kpiTokenSub').textContent = 'Token ' + C.fmtNum(token.token_total || 0);
        id('kpiUserSub').textContent = '用户 ' + C.fmtNum(ov.users || 0);
        id('genTime').textContent = snap.generated_at || '-';

        renderTrend(snap.trend);
        renderRisk(snap.by_risk);
        renderSource(snap.by_source);
        renderRiskTrend(snap.risk_trend);
        renderKeywords(snap.keywords);
        renderTable(snap.recent_items);
    }

    /* ---------------- 数据获取 ---------------- */
    function load() {
        C.api('GET', '/api/stats/snapshot?days=' + state.days).then(function (res) {
            apply(res.snapshot);
        }).catch(function (err) {
            C.toast('数据加载失败：' + err.message, 'error');
        });
    }

    function startLive() {
        stopLive();
        var es = new EventSource('/api/stats/stream?interval=15&days=' + state.days);
        state.sse = es;
        es.addEventListener('bootstrap', onEvent);
        es.addEventListener('snapshot', onEvent);
        es.onopen = function () { setLiveFlag(true, '实时推送中'); };
        es.onerror = function () { setLiveFlag(false, '连接中断，自动重试'); };
    }

    function onEvent(e) {
        try {
            apply(JSON.parse(e.data));
            setLiveFlag(true, '实时推送中');
        } catch (err) { console.error(err); }
    }

    function stopLive() {
        if (state.sse) { state.sse.close(); state.sse = null; }
        setLiveFlag(false, '轮询模式');
    }

    function setLiveFlag(on, text) {
        var flag = id('liveFlag');
        flag.classList.toggle('is-on', !!on);
        id('liveText').textContent = text;
    }

    /* ---------------- 图例自选 ---------------- */
    var LEGEND = [
        { key: 'collect', label: '采集条目', color: '#003087' },
        { key: 'messages', label: '对话消息', color: '#0f766e' },
        { key: 'tokens', label: '模型 Token（右轴）', color: '#b45309' }
    ];

    function buildLegend() {
        id('trendLegend').innerHTML = LEGEND.map(function (l) {
            return '<label class="ck-legend-item"><input type="checkbox" data-key="' + l.key + '"' +
                (state.visible[l.key] ? ' checked' : '') +
                '><i class="ck-legend-swatch" style="background:' + l.color + '"></i>' + l.label + '</label>';
        }).join('');
        Array.prototype.forEach.call(id('trendLegend').querySelectorAll('input'), function (box) {
            box.addEventListener('change', function () {
                state.visible[box.getAttribute('data-key')] = box.checked;
                if (state.snap) { renderTrend(state.snap.trend); }
            });
        });
    }

    /* ---------------- 导出 ---------------- */
    var EXPORTS = {
        trend: ['#chartTrend', '采集对话趋势'],
        risk: ['#chartRisk', '风险等级构成'],
        source: ['#chartSource', '信源采集分布'],
        risktrend: ['#chartRiskTrend', '近7日风险走势'],
        keywords: ['#chartKeywords', '采集热词TOP16']
    };

    function exportOne(key) {
        var item = EXPORTS[key];
        if (!item) { return; }
        var ok = window.ChartKit.exportPng(item[0], item[1] + '-' + state.days + '日.png', false);
        if (!ok) { C.toast('该图表暂无数据可导出', 'error'); }
    }

    /* ---------------- 绑定 ---------------- */
    function bind() {
        Array.prototype.forEach.call(id('rangeSeg').querySelectorAll('button'), function (btn) {
            btn.addEventListener('click', function () {
                state.days = parseInt(btn.getAttribute('data-days'), 10) || 14;
                C.tabSwitch(id('rangeSeg'), 'data-days', String(state.days));
                if (state.live) { startLive(); } else { load(); }
            });
        });
        Array.prototype.forEach.call(id('sourceType').querySelectorAll('button'), function (btn) {
            btn.addEventListener('click', function () {
                C.tabSwitch(id('sourceType'), 'data-type', btn.getAttribute('data-type'));
                if (state.snap) { renderSource(state.snap.by_source); }
            });
        });
        id('btnRefresh').addEventListener('click', function () {
            load();
            C.toast('已刷新', 'ok');
        });
        id('liveSwitch').addEventListener('change', function () {
            state.live = this.checked;
            if (state.live) { startLive(); C.toast('已开启实时推送（SSE）', 'ok'); }
            else { stopLive(); C.toast('已切回按需刷新'); }
        });
        id('btnExportAll').addEventListener('click', function () {
            Object.keys(EXPORTS).forEach(function (key, i) {
                setTimeout(function () { exportOne(key); }, i * 180);
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-export]'), function (btn) {
            btn.addEventListener('click', function () { exportOne(btn.getAttribute('data-export')); });
        });
        window.addEventListener('beforeunload', function () {
            if (state.sse) { state.sse.close(); }
        });
    }

    function boot() {
        buildLegend();
        bind();
        load();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
