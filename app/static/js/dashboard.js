/**
 * dashboard.js —— 数智大屏（高科指挥大屏 · ECharts 5 + 3D 地球拓扑）
 *
 * 数据链路：EventSource(/api/stats/stream) 首帧 bootstrap + 周期 snapshot；
 *          断线时 EventSource 自动重连，重连成功会再发一帧 bootstrap 覆盖旧数据。
 * 图表：全量使用本地 ECharts 5（KPI 迷你火花线/仪表 + 发光双曲线趋势 + 双环风险仪表 + 胶囊光柱排行 + 2D 飞线）
 *       与本地 Three.js r128 3D 科技地球（DashboardGlobe，支持 3D 地球 / 2D 飞线瞬时切换与自动降级）。
 * 语音：TTS 用浏览器原生 speechSynthesis 播报指标；ASR 用 webkitSpeechRecognition，
 *      不可用时在浮层里明确提示"请键盘输入"，不静默失败。
 */
(function () {
    'use strict';

    var C = window.Console;
    var PAGE = document.getElementById('consolePage');
    var REFRESH = parseInt(PAGE.getAttribute('data-refresh'), 10) || 10;
    var state = {
        snap: null,
        sse: null,
        sound: localStorage.getItem('ckb_sound') !== '0',
        lastHigh: null,
        speaking: false,
        listening: false,
        charts: {},
        mapMode: 'globe', // 'globe' | '2d'
        globe: null,
        chinaGeo: null
    };

    function id(name) { return document.getElementById(name); }

    function isReducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function setKpi(boxId, value, unit, subText, subId) {
        var box = id(boxId);
        if (box) {
            var formatted = C.fmtNum(value);
            var numMatch = !box.__ckbCounted && !isReducedMotion() && !document.hidden
                ? String(formatted).match(/^(\d[\d,]*(?:\.\d+)?)([\s\S]*)$/)
                : null;
            if (numMatch && Number(numMatch[1].replace(/,/g, '')) > 0) {
                box.__ckbCounted = true;
                var rawNum = numMatch[1];
                var plain = rawNum.replace(/,/g, '');
                var target = Number(plain);
                var dec = plain.indexOf('.') >= 0 ? plain.length - plain.indexOf('.') - 1 : 0;
                var commas = rawNum.indexOf(',') >= 0;
                var suffix = numMatch[2] || '';
                box.innerHTML = '0' + suffix + '<small>' + unit + '</small>';
                var tNode = box.firstChild;
                var t0 = null;
                var dur = 460;
                var done = false;
                var safetyTimer = window.setTimeout(function () {
                    if (done || !tNode || !tNode.isConnected) { return; }
                    done = true;
                    tNode.nodeValue = formatted;
                }, dur + 160);
                var stepFn = function (ts) {
                    if (done) { return; }
                    if (!tNode || !tNode.isConnected) {
                        done = true;
                        window.clearTimeout(safetyTimer);
                        return;
                    }
                    if (t0 === null) { t0 = ts; }
                    var p = Math.min((ts - t0) / dur, 1);
                    var eased = 1 - Math.pow(1 - p, 4);
                    var cur = p >= 1 ? target : target * eased;
                    var str;
                    if (dec > 0) {
                        var fx = cur.toFixed(dec);
                        if (commas) {
                            var parts = fx.split('.');
                            str = Number(parts[0]).toLocaleString('en-US') + '.' + parts[1];
                        } else {
                            str = fx;
                        }
                    } else {
                        var rd = Math.round(cur);
                        str = commas ? rd.toLocaleString('en-US') : String(rd);
                    }
                    tNode.nodeValue = str + suffix;
                    if (p < 1) {
                        window.requestAnimationFrame(stepFn);
                    } else {
                        done = true;
                        window.clearTimeout(safetyTimer);
                    }
                };
                window.requestAnimationFrame(stepFn);
            } else {
                box.innerHTML = formatted + '<small>' + unit + '</small>';
            }
        }
        if (subId && subText !== undefined) {
            var s = id(subId);
            if (s) { s.textContent = subText; }
        }
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

    /* ---------------- KPI ECharts 微图表 ---------------- */
    function renderKpiMinis(snap) {
        if (!window.ChartKit || !window.ChartKit.available()) { return; }
        var rows = (snap && snap.trend ? snap.trend : []).slice(-10);
        var collectArr = rows.map(function (d) { return d.collect || 0; });
        var msgArr = rows.map(function (d) { return d.messages || 0; });
        var tokArr = rows.map(function (d) { return d.tokens || 0; });

        var ov = (snap && snap.overview) || {};
        var wh = ov.warehouse || {};
        var whDone = (typeof wh === 'object') ? (wh.done || 0) : (wh || 0);
        var collectTotal = Number(ov.collect_total || 0);
        var whPct = collectTotal > 0 ? Math.min(100, Math.round((whDone / collectTotal) * 100)) : (whDone > 0 ? 100 : 0);

        var risk = (ov.risk && ov.risk.counts) || {};
        var riskSum = (risk.high || 0) + (risk.watch || 0) + (risk.normal || 0) + (risk.error || 0);
        var riskPct = riskSum > 0 ? Math.round(((risk.high || 0) / riskSum) * 100) : 0;

        window.ChartKit.renderMiniSparkline('#kpiMiniCollect', { type: 'line', data: collectArr, color: '#00e5ff' });
        window.ChartKit.renderMiniSparkline('#kpiMiniToday', { type: 'bar', data: collectArr, color: '#38bdf8' });
        window.ChartKit.renderMiniGauge('#kpiMiniWarehouse', { percent: whPct, color: '#2dd4bf' });
        window.ChartKit.renderMiniGauge('#kpiMiniRisk', { percent: riskPct, color: '#ff5a6e' });
        window.ChartKit.renderMiniSparkline('#kpiMiniToken', { type: 'bar', data: tokArr, color: '#fbbf24' });
        window.ChartKit.renderMiniSparkline('#kpiMiniActive', { type: 'line', data: msgArr, color: '#34d399' });
    }

    /* ---------------- 主图表：问答服务量趋势（ECharts 发光双样条 + 峰值标注） ---------------- */
    function renderTrend(trend) {
        var rows = (trend || []).slice(-14);
        if (!rows.length) {
            window.ChartKit.empty('#chartTrend', '近 14 日暂无采集/对话数据');
            return;
        }
        var inst = window.ChartKit.init('#chartTrend', { dark: true });
        if (!inst) { return; }
        var categories = rows.map(function (d) { return (d.date || '').slice(5); });
        var collect = rows.map(function (d) { return d.collect || 0; });
        var messages = rows.map(function (d) { return d.messages || 0; });
        var theme = window.ChartKit.theme(true);

        function areaGrad(hex) {
            return new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: window.ChartKit.hexA(hex, 0.44) },
                { offset: 0.72, color: window.ChartKit.hexA(hex, 0.12) },
                { offset: 1, color: window.ChartKit.hexA(hex, 0.01) }
            ]);
        }

        var option = {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'inherit', color: theme.text },
            animationDuration: 280,
            tooltip: {
                trigger: 'axis',
                backgroundColor: theme.tooltipBg,
                borderColor: theme.tooltipBorder,
                borderWidth: 1,
                textStyle: { color: theme.tooltipText, fontSize: 12 },
                axisPointer: { type: 'line', lineStyle: { color: 'rgba(0,229,255,.45)', type: 'dashed' } }
            },
            legend: {
                show: true, top: 2, right: 6, itemWidth: 10, itemHeight: 10, icon: 'roundRect',
                textStyle: { color: theme.legend, fontSize: 11 }
            },
            grid: { left: 42, right: 16, top: 32, bottom: 22 },
            xAxis: {
                type: 'category', boundaryGap: false, data: categories,
                axisLine: { lineStyle: { color: theme.axis } },
                axisTick: { show: false },
                axisLabel: { color: theme.sub, fontSize: 10.5, hideOverlap: true }
            },
            yAxis: {
                type: 'value',
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: theme.sub, fontSize: 10.5 },
                splitLine: { lineStyle: { color: theme.split, type: 'dashed' } }
            },
            series: [
                {
                    name: '采集条目',
                    type: 'line',
                    smooth: 0.42,
                    symbol: 'circle',
                    symbolSize: 5,
                    showSymbol: false,
                    data: collect,
                    lineStyle: { width: 2.2, color: '#00e5ff', shadowBlur: 10, shadowColor: 'rgba(0,229,255,.55)' },
                    itemStyle: { color: '#00e5ff' },
                    areaStyle: { color: areaGrad('#00e5ff') },
                    markPoint: {
                        symbol: 'pin',
                        symbolSize: 28,
                        itemStyle: { color: '#00e5ff' },
                        label: { color: '#030b19', fontSize: 9.5, fontWeight: 700 },
                        data: [{ type: 'max', name: '峰值' }]
                    }
                },
                {
                    name: '对话消息',
                    type: 'line',
                    smooth: 0.42,
                    symbol: 'circle',
                    symbolSize: 5,
                    showSymbol: false,
                    data: messages,
                    lineStyle: { width: 2.2, color: '#2dd4bf', shadowBlur: 10, shadowColor: 'rgba(45,212,191,.55)' },
                    itemStyle: { color: '#2dd4bf' },
                    areaStyle: { color: areaGrad('#2dd4bf') },
                    markPoint: {
                        symbol: 'pin',
                        symbolSize: 28,
                        itemStyle: { color: '#2dd4bf' },
                        label: { color: '#030b19', fontSize: 9.5, fontWeight: 700 },
                        data: [{ type: 'max', name: '峰值' }]
                    }
                }
            ]
        };

        inst.setOption(option, true);
        window.ChartKit.clearEmpty('#chartTrend');
        state.charts.trend = inst;
    }

    /* ---------------- 中心：3D 科技地球 + 指向箭头 / ECharts 2D 飞线双模式 ---------------- */
    function updateMapUiButtons() {
        var sw = id('mapModeSwitch');
        if (!sw) { return; }
        Array.prototype.forEach.call(sw.querySelectorAll('button[data-mode]'), function (btn) {
            btn.classList.toggle('is-active', btn.getAttribute('data-mode') === state.mapMode);
        });
    }

    function renderMap(region) {
        var list = (region && region.list) || [];
        var tip = id('mapTip');
        var sub = id('mapSub');
        if (region) {
            sub.textContent = region.matched
                ? ('命中 ' + region.matched + ' / 扫描 ' + region.scanned + ' 篇')
                : '全域节点实时连接';
            tip.textContent = '口径：按采集标题/摘要中出现的省级行政区或省会城市计数，共扫描 '
                + (region.scanned || 0) + ' 篇；3D 指向箭头表示各省/高校节点汇聚至西华师大 · 南充。';
        }

        window.ChartKit.loadChinaMap('/static/vendor/echarts/china.json').then(function (geo) {
            if (geo && typeof geo === 'object') { state.chinaGeo = geo; }
            else { state.chinaGeo = window.ChartKit.getChinaGeo(); }
            window.ChartKit.clearEmpty('#chartMap');

            var globeBox = id('globeStage');
            var map2dBox = id('chartMap2d');
            var canGlobe = !!(window.DashboardGlobe && window.DashboardGlobe.hasWebGL && window.DashboardGlobe.hasWebGL());
            if (state.mapMode === 'globe' && !canGlobe) {
                state.mapMode = '2d';
            }
            updateMapUiButtons();

            if (state.mapMode === 'globe' && globeBox) {
                if (map2dBox) { map2dBox.hidden = true; }
                globeBox.hidden = false;
                try {
                    var newlyMounted = false;
                    if (!state.globe) {
                        state.globe = window.DashboardGlobe.mount(globeBox, {
                            regionList: list,
                            chinaGeo: state.chinaGeo
                        });
                        newlyMounted = !!state.globe;
                    }
                    if (state.globe) {
                        state.globe.setActive(true);
                        if (!newlyMounted) {
                            state.globe.update(list, state.chinaGeo);
                        }
                        return;
                    }
                } catch (globeErr) {
                    console.error('3D 地球渲染异常，自动切换 2D 飞线', globeErr);
                    if (state.globe && state.globe.dispose) {
                        try { state.globe.dispose(); } catch (e) { /* ignore */ }
                    }
                    state.globe = null;
                }
                state.mapMode = '2d';
                updateMapUiButtons();
            }

            if (globeBox) { globeBox.hidden = true; }
            if (state.globe) { state.globe.setActive(false); }
            if (map2dBox) {
                map2dBox.hidden = false;
                window.ChartKit.clearEmpty(map2dBox);
                state.charts.map = window.ChartKit.renderChinaMap(map2dBox, {
                    dark: true,
                    data: list,
                    max: (region && region.max) || 1,
                    roam: false,
                    zoom: 1.2,
                    flightLines: true
                });
                if (state.charts.map) { state.charts.map.resize(); }
            }
        }).catch(function (err) {
            window.ChartKit.empty('#chartMap', err.message || '地图数据加载失败');
        });
    }

    /* ---------------- 右上：话题/风险构成（ECharts 外圈刻度表盘 + 内圈发光环形图） ---------------- */
    function renderRisk(byRisk) {
        var rows = byRisk || [];
        var total = rows.reduce(function (sum, r) { return sum + (r.count || 0); }, 0);
        id('riskTotal').textContent = '共 ' + total + ' 条';
        var colors = { high: '#ff5a6e', watch: '#fbbf24', normal: '#2dd4bf', error: '#60a5fa' };
        var data = rows.map(function (r) {
            return {
                name: r.label,
                value: r.count || 0,
                itemStyle: { color: colors[r.level] || '#38bdf8' }
            };
        });
        if (!data.length) {
            window.ChartKit.empty('#chartRisk', '暂无风险分析结果');
            return;
        }
        var inst = window.ChartKit.init('#chartRisk', { dark: true });
        if (!inst) { return; }
        var theme = window.ChartKit.theme(true);

        var option = {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'inherit', color: theme.text },
            animationDuration: 280,
            tooltip: {
                trigger: 'item',
                backgroundColor: theme.tooltipBg,
                borderColor: theme.tooltipBorder,
                borderWidth: 1,
                textStyle: { color: theme.tooltipText, fontSize: 12 },
                formatter: '{b}：{c} 条（{d}%）'
            },
            legend: {
                show: true,
                orient: 'vertical',
                right: 4,
                top: 'middle',
                itemWidth: 9,
                itemHeight: 9,
                icon: 'circle',
                textStyle: { color: theme.legend, fontSize: 11.5 }
            },
            graphic: [
                {
                    type: 'group',
                    left: '31%',
                    top: '44%',
                    children: [
                        {
                            type: 'text',
                            style: {
                                text: C.fmtNum(total),
                                textAlign: 'center',
                                fill: '#e8f3ff',
                                fontSize: 18,
                                fontWeight: 700
                            },
                            left: 'center',
                            top: 0
                        },
                        {
                            type: 'text',
                            style: {
                                text: '总线索',
                                textAlign: 'center',
                                fill: '#7fa3cf',
                                fontSize: 10.5
                            },
                            left: 'center',
                            top: 22
                        }
                    ]
                }
            ],
            series: [
                {
                    type: 'gauge',
                    center: ['36%', '52%'],
                    radius: '86%',
                    startAngle: 90,
                    endAngle: -270,
                    splitNumber: 12,
                    axisLine: { lineStyle: { width: 1, color: [[1, 'rgba(56,189,248,.22)']] } },
                    axisTick: { distance: -4, length: 4, splitNumber: 3, lineStyle: { color: 'rgba(0,229,255,.32)', width: 1 } },
                    splitLine: { distance: -5, length: 7, lineStyle: { color: 'rgba(0,229,255,.55)', width: 1.5 } },
                    axisLabel: { show: false },
                    pointer: { show: false },
                    detail: { show: false }
                },
                {
                    name: '占比',
                    type: 'pie',
                    radius: ['50%', '72%'],
                    center: ['36%', '52%'],
                    avoidLabelOverlap: true,
                    itemStyle: {
                        borderRadius: 4,
                        borderColor: 'rgba(6, 18, 38, .92)',
                        borderWidth: 2.5
                    },
                    label: { show: false },
                    emphasis: {
                        scale: true,
                        scaleSize: 5,
                        label: { show: false }
                    },
                    labelLine: { show: false },
                    data: data
                }
            ]
        };

        inst.setOption(option, true);
        window.ChartKit.clearEmpty('#chartRisk');
        state.charts.risk = inst;
    }

    /* ---------------- 左下：信源 / 助手使用分布（ECharts 暗轨胶囊进度条 + 末端光点） ---------------- */
    function renderSource(items) {
        var rows = (items || []).slice(0, 7).map(function (r) {
            return { name: r.source_name || r.name || '-', value: Number(r.count || r.value || 0) };
        });
        if (!rows.length) {
            window.ChartKit.empty('#chartSource', '暂无信源采集记录');
            return;
        }
        var inst = window.ChartKit.init('#chartSource', { dark: true });
        if (!inst) { return; }
        var theme = window.ChartKit.theme(true);
        var maxVal = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));

        var option = {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'inherit', color: theme.text },
            animationDuration: 280,
            grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
            tooltip: {
                trigger: 'item',
                backgroundColor: theme.tooltipBg,
                borderColor: theme.tooltipBorder,
                borderWidth: 1,
                textStyle: { color: theme.tooltipText, fontSize: 12 },
                formatter: function (p) { return C.esc(p.name) + '：' + p.value + ' 条'; }
            },
            xAxis: {
                type: 'value',
                max: Math.ceil(maxVal * 1.12),
                show: false
            },
            yAxis: {
                type: 'category',
                inverse: true,
                data: rows.map(function (d) { return d.name; }),
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: '#a6c8f0', fontSize: 11 }
            },
            series: [
                {
                    type: 'bar',
                    barWidth: 9,
                    showBackground: true,
                    backgroundStyle: {
                        color: 'rgba(56, 189, 248, .10)',
                        borderRadius: 999
                    },
                    data: rows.map(function (d, idx) {
                        var startCol = idx === 0 ? '#0284c7' : '#1d4ed8';
                        var endCol = idx === 0 ? '#fbbf24' : '#00e5ff';
                        return {
                            value: d.value,
                            itemStyle: {
                                borderRadius: 999,
                                color: new window.echarts.graphic.LinearGradient(0, 0, 1, 0, [
                                    { offset: 0, color: startCol },
                                    { offset: 1, color: endCol }
                                ])
                            }
                        };
                    }),
                    label: {
                        show: true,
                        position: 'right',
                        color: '#e2eeff',
                        fontSize: 11,
                        fontWeight: 600,
                        formatter: '{c} 条'
                    }
                },
                {
                    type: 'scatter',
                    symbolSize: 8,
                    z: 4,
                    silent: true,
                    itemStyle: {
                        color: '#e0f2fe',
                        shadowBlur: 10,
                        shadowColor: '#00e5ff'
                    },
                    data: rows.map(function (d, i) { return [d.value, i]; })
                }
            ]
        };

        inst.setOption(option, true);
        window.ChartKit.clearEmpty('#chartSource');
        state.charts.source = inst;
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
        }).join(' <span style="color:#00e5ff">·</span> ');
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

        renderKpiMinis(snap);
        renderTrend(snap.trend);
        renderMap(snap.by_region);
        renderRisk(snap.by_risk);
        renderSource(snap.by_source);
        renderFeed(snap.latest_risks);
        renderHotwords(snap.keywords);
        renderTicker(snap.recent_items);
        id('genTime').textContent = snap.generated_at || '-';

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
        es.onerror = function () { live(false, '连接中断，重试中'); };
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
        id('btnSound').addEventListener('click', function () {
            if (state.sound && state.snap) {
                var ov = state.snap.overview || {};
                speak('已开启语音播报。当前累计采集 ' + (ov.collect_total || 0) + ' 条。');
            }
        });

        var sw = id('mapModeSwitch');
        if (sw) {
            sw.addEventListener('click', function (e) {
                var btn = e.target.closest ? e.target.closest('button[data-mode]') : null;
                if (!btn) { return; }
                var mode = btn.getAttribute('data-mode');
                if (mode === state.mapMode) { return; }
                state.mapMode = mode;
                renderMap(state.snap ? state.snap.by_region : null);
            });
        }
    }

    function boot() {
        tickClock();
        setInterval(tickClock, 1000);
        setSound(state.sound);
        bind();
        setupAsr();
        // 先挂载基线 3D 地球避免首屏空白，待快照抵达再增量注入数据
        renderMap(null);
        connect();
        setTimeout(function () {
            if (!state.snap) {
                C.api('GET', '/api/stats/snapshot?days=14').then(function (res) {
                    applySnapshot(res.snapshot);
                }).catch(function () { /* SSE 仍在重试 */ });
            }
        }, 3000);
        window.addEventListener('beforeunload', function () {
            if (state.sse) { state.sse.close(); }
            if (state.globe) { state.globe.dispose(); }
            if (window.speechSynthesis) { window.speechSynthesis.cancel(); }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
