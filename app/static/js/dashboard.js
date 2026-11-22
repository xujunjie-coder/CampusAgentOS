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
        mapMode: 'globe', // 'globe' | '2d' | 'campus'
        globe: null,
        chinaGeo: null,
        highlightTimer: null
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

    /* ---------------- 中心：3D 科技地球 + 2D 飞线 + 华凤/北湖双校区三态切换 ---------------- */
    function updateMapUiButtons() {
        var sw = id('mapModeSwitch');
        if (!sw) { return; }
        Array.prototype.forEach.call(sw.querySelectorAll('button[data-mode]'), function (btn) {
            btn.classList.toggle('is-active', btn.getAttribute('data-mode') === state.mapMode);
        });
    }

    /* ---------------- 下钻详情抽屉 ---------------- */
    function closeDrillDrawer() {
        var drawer = id('drillDrawer');
        if (drawer) { drawer.hidden = true; }
    }

    function openDrillDrawer(cfg) {
        var drawer = id('drillDrawer');
        if (!drawer || !cfg) { return; }
        id('drillBadge').textContent = cfg.badge || '态势下钻';
        id('drillTitle').textContent = cfg.title || '详情';
        var statsBox = id('drillStats');
        statsBox.innerHTML = (cfg.stats || []).map(function (st) {
            return '<div class="ckb-drill-stat"><span>' + C.esc(st.label) + '</span><b>' +
                C.esc(st.value) + (st.unit ? '<small>' + C.esc(st.unit) + '</small>' : '') + '</b></div>';
        }).join('');
        var noteBox = id('drillNote');
        if (cfg.note) {
            noteBox.textContent = cfg.note;
            noteBox.hidden = false;
        } else {
            noteBox.textContent = '';
            noteBox.hidden = true;
        }
        var listBox = id('drillList');
        var items = cfg.items || [];
        listBox.innerHTML = items.length
            ? items.map(function (it) {
                return '<li><div class="d-title">' + C.esc(it.title || '') + '</div>' +
                    '<div class="d-meta">' + C.esc(it.meta || '') + '</div></li>';
            }).join('')
            : '<li class="d-empty">' + C.esc(cfg.emptyText || '当前筛选条件下暂无明细记录') + '</li>';
        drawer.hidden = false;
    }

    function openRegionDrill(info) {
        var snap = state.snap || {};
        var regionName = (info && (info.region || info.name)) || '四川';
        if (regionName.indexOf('西华师大') !== -1) { regionName = '四川'; }
        var regList = (snap.by_region && snap.by_region.list) || [];
        var foundIdx = -1;
        for (var i = 0; i < regList.length; i++) {
            if (regList[i].name === regionName) { foundIdx = i; break; }
        }
        var hit = foundIdx >= 0 ? regList[foundIdx] : null;
        var count = hit ? hit.value : ((info && typeof info.value === 'number') ? info.value : 0);
        var matchedTotal = (snap.by_region && snap.by_region.matched) || 0;
        var pct = matchedTotal > 0 ? Math.round((count / matchedTotal) * 100) + '%' : '-';

        var related = [].concat(snap.latest_risks || [], snap.recent_items || []).filter(function (row) {
            var txt = ((row && row.title) || '') + ' ' + ((row && row.source_name) || '');
            return txt.indexOf(regionName) !== -1 || (regionName === '四川' && /南充|华凤|西华|成都/.test(txt));
        });

        openDrillDrawer({
            badge: (info && info.isHub) ? '主枢纽节点' : '区域下钻',
            title: (info && info.name && info.name !== regionName) ? (regionName + ' · ' + info.name) : regionName,
            emptyText: '该地区暂无关联资讯',
            stats: [
                { label: '文本提及', value: String(count), unit: '篇' },
                { label: '全网排名', value: foundIdx >= 0 ? ('#' + (foundIdx + 1)) : '基线', unit: '' },
                { label: '区域占比', value: pct, unit: '' }
            ],
            note: (info && info.isHub)
                ? '南充主枢纽（华凤 / 北湖校区）：全网高校及省级节点数据汇总中心。'
                : '口径：统计采集标题及摘要中出现的省级行政区或关联高校提及热度。',
            items: related.slice(0, 4).map(function (r) {
                return {
                    title: r.title || '暂无标题',
                    meta: (r.level_label ? (r.level_label + ' · ') : '') + (r.source_name || '采集信源') + ' · ' + C.fmtTime(r.reviewed_at || r.collected_at)
                };
            })
        });
    }

    function openRiskDrill(row) {
        if (!row) { return; }
        var extra = [];
        if (row.evidence) {
            extra.push({ title: '证据摘录：' + row.evidence, meta: '模型人工可核验原文依据' });
        }
        if (row.url && row.url !== '#') {
            extra.push({ title: '原始链接：' + row.url, meta: '信源原文地址' });
        }
        openDrillDrawer({
            badge: row.level_label || '风险线索',
            title: row.title || '预警详情',
            stats: [
                { label: '风险等级', value: row.level_label || '-', unit: '' },
                { label: '来源信源', value: row.source_name || '-', unit: '' }
            ],
            note: row.reason || '已触发大屏实时风险预警流监控。',
            items: extra
        });
    }

    function campusHotScore(snap, regex) {
        var score = 12;
        var kws = (snap && snap.keywords) || [];
        kws.forEach(function (k) {
            if (regex.test(k.keyword || '')) { score += Number(k.count || 0); }
        });
        var srcs = (snap && snap.by_source) || [];
        srcs.forEach(function (s) {
            if (regex.test(s.source_name || '')) { score += Math.round(Number(s.count || 0) * 0.25); }
        });
        return score;
    }

    function openCampusDomainDrill(nodeData) {
        var snap = state.snap || {};
        var name = (nodeData && nodeData.name) || '华凤校区';
        var desc = (nodeData && nodeData.desc) || '西华师范大学智慧校园专题态势监测。';
        var kwRegex = (nodeData && nodeData.kwRegex) || /校园|华凤|北湖|奖学金|双选/;
        var rows = [].concat(snap.latest_risks || [], snap.recent_items || []).filter(function (r) {
            var txt = ((r && r.title) || '') + ' ' + ((r && r.source_name) || '');
            return kwRegex.test(txt);
        });
        openDrillDrawer({
            badge: (nodeData && nodeData.isHub) ? '双校区枢纽' : '校园专题',
            title: name,
            emptyText: '该校园节点暂无关联资讯',
            stats: [
                { label: '活跃指数', value: String((nodeData && nodeData.heat) || 12), unit: '' },
                { label: '关联线索', value: String(rows.length), unit: '条' }
            ],
            note: desc,
            items: rows.slice(0, 4).map(function (r) {
                return {
                    title: r.title || '-',
                    meta: (r.source_name || '校内信源') + ' · ' + C.fmtTime(r.reviewed_at || r.collected_at)
                };
            })
        });
    }

    function renderCampusMap(snap) {
        var campusBox = id('chartMapCampus');
        if (!campusBox || !window.ChartKit || !window.ChartKit.available()) { return null; }
        var inst = window.ChartKit.init(campusBox, { dark: true });
        if (!inst) { return null; }
        var theme = window.ChartKit.theme(true);

        var domains = [
            { name: '教务教学', pos: [18, 82], hub: '华凤校区', col: '#00e5ff', kwRegex: /教务|选课|考试|成绩|课程/, desc: '覆盖选课、考务安排、四六级与培养方案动态。' },
            { name: '图书馆自习', pos: [50, 86], hub: '华凤校区', col: '#38bdf8', kwRegex: /图书|自习|馆|阅览/, desc: '华凤主馆与北湖分馆开放时段、数据库及期末延长开放反馈。' },
            { name: '就业双选', pos: [82, 82], hub: '北湖校区', col: '#fbbf24', kwRegex: /双选|就业|招聘|考研|复试/, desc: '四川省教育厅与校招就处专场双选会、考研调剂及基层补贴动态。' },
            { name: '宿舍后勤', pos: [18, 20], hub: '华凤校区', col: '#f472b6', kwRegex: /宿舍|报修|非机动车|东门|校车/, desc: '包含校园交通隐患预警、宿舍报修与两校区校车运行监测。' },
            { name: '食堂餐饮', pos: [50, 14], hub: '北湖校区', col: '#34d399', kwRegex: /食堂|餐饮|保温|后勤/, desc: '两校区学生食堂饭菜温度、卫生巡检与窗口建议跟踪。' },
            { name: '资助与心理', pos: [82, 20], hub: '北湖校区', col: '#a78bfa', kwRegex: /奖学金|资助|心理|学工/, desc: '国家奖助学金评审公示、学工动态及心理健康支持关注热度。' }
        ];

        var hubs = {
            '华凤校区': { name: '华凤校区 · 主枢纽', value: [28, 52], symbolSize: 34, isHub: true, col: '#fbbf24', kwRegex: /华凤|东门|图书|奖学金/, desc: '主行政教学枢纽：图书馆主馆、招生就业、教务核心与二期食堂。' },
            '北湖校区': { name: '北湖校区 · 联动枢纽', value: [72, 52], symbolSize: 28, isHub: true, col: '#00e5ff', kwRegex: /北湖|二食堂|双选|学工/, desc: '北湖老校区枢纽：教学楼群、宿舍区与跨校区校车衔接节点。' }
        };

        var nodeList = [
            {
                name: hubs['华凤校区'].name,
                value: [28, 52, 100],
                symbolSize: 34,
                isHub: true,
                heat: campusHotScore(snap, hubs['华凤校区'].kwRegex),
                kwRegex: hubs['华凤校区'].kwRegex,
                desc: hubs['华凤校区'].desc,
                itemStyle: { color: '#fbbf24', borderColor: '#fef9c3', borderWidth: 2, shadowBlur: 18, shadowColor: 'rgba(251,191,36,.7)' },
                label: {
                    color: '#fef08a',
                    fontWeight: 700,
                    fontSize: 12,
                    position: 'bottom',
                    distance: 10,
                    backgroundColor: 'rgba(4, 14, 32, 0.90)',
                    borderColor: 'rgba(251, 191, 36, 0.65)',
                    borderWidth: 1,
                    borderRadius: 4,
                    padding: [3, 8]
                }
            },
            {
                name: hubs['北湖校区'].name,
                value: [72, 52, 85],
                symbolSize: 28,
                isHub: true,
                heat: campusHotScore(snap, hubs['北湖校区'].kwRegex),
                kwRegex: hubs['北湖校区'].kwRegex,
                desc: hubs['北湖校区'].desc,
                itemStyle: { color: '#00e5ff', borderColor: '#e0f2fe', borderWidth: 2, shadowBlur: 16, shadowColor: 'rgba(0,229,255,.65)' },
                label: {
                    color: '#bae6fd',
                    fontWeight: 700,
                    fontSize: 12,
                    position: 'bottom',
                    distance: 10,
                    backgroundColor: 'rgba(4, 14, 32, 0.90)',
                    borderColor: 'rgba(0, 229, 255, 0.58)',
                    borderWidth: 1,
                    borderRadius: 4,
                    padding: [3, 8]
                }
            }
        ];

        var lineData = [
            {
                coords: [[28, 52], [72, 52]],
                fromName: '华凤校区', toName: '北湖校区',
                lineStyle: { color: '#fbbf24', width: 2.6, curveness: 0.14, opacity: 0.85 }
            },
            {
                coords: [[72, 52], [28, 52]],
                fromName: '北湖校区', toName: '华凤校区',
                lineStyle: { color: '#00e5ff', width: 2.0, curveness: 0.14, opacity: 0.72 }
            }
        ];

        domains.forEach(function (d) {
            var heat = campusHotScore(snap, d.kwRegex);
            var hubPos = hubs[d.hub].value;
            var isTopRow = d.pos[1] > 55;
            nodeList.push({
                name: d.name,
                value: [d.pos[0], d.pos[1], heat],
                symbolSize: Math.max(18, Math.min(30, 14 + Math.round(heat * 0.14))),
                isHub: false,
                heat: heat,
                kwRegex: d.kwRegex,
                desc: d.desc,
                itemStyle: { color: d.col, shadowBlur: 12, shadowColor: d.col },
                label: {
                    color: '#e2f0ff',
                    fontSize: 11.5,
                    fontWeight: 600,
                    position: isTopRow ? 'top' : 'bottom',
                    distance: 8,
                    backgroundColor: 'rgba(4, 14, 32, 0.82)',
                    borderColor: 'rgba(56, 189, 248, 0.28)',
                    borderWidth: 1,
                    borderRadius: 3,
                    padding: [2, 6]
                }
            });
            lineData.push({
                coords: [d.pos, hubPos],
                fromName: d.name,
                toName: d.hub,
                lineStyle: { color: d.col, width: 1.5, curveness: 0.16, opacity: 0.55 }
            });
        });

        var option = {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'inherit', color: theme.text },
            tooltip: {
                trigger: 'item',
                backgroundColor: theme.tooltipBg,
                borderColor: theme.tooltipBorder,
                borderWidth: 1,
                textStyle: { color: theme.tooltipText, fontSize: 12 },
                formatter: function (p) {
                    if (p.seriesType === 'lines') {
                        return C.esc(p.data.fromName) + ' ↔ ' + C.esc(p.data.toName);
                    }
                    var d = p.data || {};
                    return '<b>' + C.esc(d.name) + '</b><br/>关注热度：' + (d.heat || 0) + '<br/><span style="color:#7dd3fc;">点击查看校内详情</span>';
                }
            },
            grid: { left: 20, right: 20, top: 34, bottom: 26 },
            xAxis: { type: 'value', min: 0, max: 100, show: false },
            yAxis: { type: 'value', min: 0, max: 100, show: false },
            series: [
                {
                    type: 'lines',
                    coordinateSystem: 'cartesian2d',
                    zlevel: 1,
                    effect: {
                        show: !isReducedMotion(),
                        period: 3.2,
                        trailLength: 0.25,
                        symbol: 'arrow',
                        symbolSize: 7,
                        color: '#fef9c3'
                    },
                    data: lineData
                },
                {
                    type: 'effectScatter',
                    coordinateSystem: 'cartesian2d',
                    zlevel: 4,
                    rippleEffect: { brushType: 'stroke', scale: 2.6, period: 3.5 },
                    label: {
                        show: true,
                        position: 'bottom',
                        distance: 6,
                        formatter: '{b}'
                    },
                    data: nodeList
                }
            ]
        };

        inst.setOption(option, true);
        if (!inst.__campusClickBound) {
            inst.__campusClickBound = true;
            inst.on('click', function (params) {
                if (params && params.seriesType === 'effectScatter' && params.data) {
                    openCampusDomainDrill(params.data);
                }
            });
        }
        state.charts.campus = inst;
        return inst;
    }

    function renderMap(region) {
        var list = (region && region.list) || [];
        var tip = id('mapTip');
        var sub = id('mapSub');
        var globeBox = id('globeStage');
        var map2dBox = id('chartMap2d');
        var campusBox = id('chartMapCampus');
        updateMapUiButtons();

        if (state.mapMode === 'campus') {
            if (globeBox) { globeBox.hidden = true; }
            if (map2dBox) { map2dBox.hidden = true; }
            if (state.globe) { state.globe.setActive(false); }
            window.ChartKit.clearEmpty('#chartMap');
            if (sub) { sub.textContent = '华凤 ↔ 北湖双校区联防态势'; }
            if (tip) { tip.textContent = '校内双校区拓扑：点击任意校区枢纽或业务域节点，查看对应校园热点与线索下钻。'; }
            if (campusBox) {
                campusBox.hidden = false;
                renderCampusMap(state.snap);
                if (state.charts.campus) { state.charts.campus.resize(); }
            }
            return;
        }

        if (campusBox) { campusBox.hidden = true; }
        if (region) {
            sub.textContent = region.matched
                ? ('命中 ' + region.matched + ' / 扫描 ' + region.scanned + ' 篇')
                : '全域节点实时连接';
            tip.textContent = '口径：按采集标题/摘要中出现的省级行政区或省会城市计数，共扫描 '
                + (region.scanned || 0) + ' 篇；点击节点可下钻查看明细（3D 指向箭头汇聚至西华师大 · 南充）。';
        }

        window.ChartKit.loadChinaMap('/static/vendor/echarts/china.json').then(function (geo) {
            if (geo && typeof geo === 'object') { state.chinaGeo = geo; }
            else { state.chinaGeo = window.ChartKit.getChinaGeo(); }
            window.ChartKit.clearEmpty('#chartMap');

            if (state.mapMode === 'campus') { return; }
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
                            chinaGeo: state.chinaGeo,
                            onNodeClick: openRegionDrill
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
                if (state.charts.map) {
                    if (!state.charts.map.__drillClickBound) {
                        state.charts.map.__drillClickBound = true;
                        state.charts.map.on('click', function (params) {
                            if (!params) { return; }
                            var rName = params.name || (params.data && params.data.fromName) || '';
                            if (rName) {
                                openRegionDrill({ name: rName, region: rName, value: Number(params.value) || 0 });
                            }
                        });
                    }
                    state.charts.map.resize();
                }
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
        list.innerHTML = rows.map(function (r, idx) {
            return '<li data-risk-idx="' + idx + '" title="点击查看风险预警详情"><i class="lv ' + C.esc(r.level) + '"></i>' +
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

    function pulsePanel(selector) {
        var el = document.querySelector(selector);
        if (!el) { return; }
        document.querySelectorAll('.is-ask-focus').forEach(function (node) {
            node.classList.remove('is-ask-focus');
        });
        el.classList.add('is-ask-focus');
        if (state.highlightTimer) { window.clearTimeout(state.highlightTimer); }
        state.highlightTimer = window.setTimeout(function () {
            el.classList.remove('is-ask-focus');
        }, 2600);
    }

    function applyAskAction(action) {
        if (!action || !action.type) { return; }
        if (action.type === 'switch_map_mode' && action.mode) {
            state.mapMode = action.mode;
            renderMap(state.snap ? state.snap.by_region : null);
            pulsePanel('.ckb-center');
            return;
        }
        if (action.type === 'focus_region' && action.region) {
            state.mapMode = 'globe';
            renderMap(state.snap ? state.snap.by_region : null);
            if (state.globe && state.globe.focusRegion) {
                state.globe.focusRegion(action.region);
            }
            pulsePanel('.ckb-center');
            openRegionDrill({ name: action.region, region: action.region });
            return;
        }
        if (action.type === 'highlight_panel' && action.target) {
            var map = {
                risk: '.ckb-right-top',
                trend: '.ckb-left-top',
                source: '.ckb-left-bottom',
                center: '.ckb-center',
                kpis: '.ckb-kpis'
            };
            if (map[action.target]) { pulsePanel(map[action.target]); }
        }
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
            applyAskAction(res.action);
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

        var feedList = id('feedRisk');
        if (feedList) {
            feedList.addEventListener('click', function (e) {
                var li = e.target.closest ? e.target.closest('li[data-risk-idx]') : null;
                if (!li || !state.snap || !state.snap.latest_risks) { return; }
                var idx = parseInt(li.getAttribute('data-risk-idx'), 10);
                var row = state.snap.latest_risks[idx];
                if (row) { openRiskDrill(row); }
            });
        }

        var drillClose = id('drillClose');
        if (drillClose) {
            drillClose.addEventListener('click', closeDrillDrawer);
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { closeDrillDrawer(); }
        });
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
