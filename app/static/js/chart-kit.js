/**
 * chart-kit.js —— ECharts 统一封装（成员 C · 前端静态资源封装）
 *
 * 目标：全站图表只走这一层，避免每个页面各写一套 option / resize / 空态逻辑。
 * 统一承担：
 *   1) 主题：亮色（后台报表）与暗色（数智大屏）两套坐标轴/文字/分割线配色；
 *   2) 自适应：ResizeObserver + window.resize，容器隐藏/显隐后 resize 不丢图；
 *   3) 空态：无数据时给统一占位文案，不渲染空白坐标轴；
 *   4) 加载态：请求期间 showLoading，结束 hideLoading；
 *   5) 回收：dispose 释放实例，避免弹层反复打开累积 canvas；
 *   6) 导出：exportPng 直接导出 PNG（报表"自选图例 + 导出"用）。
 *
 * 依赖：window.echarts（/static/vendor/echarts/echarts.min.js），缺失时降级为文字提示，
 * 不会抛异常打断页面其余逻辑。
 */
(function (global) {
    'use strict';

    var PALETTE = ['#003087', '#0f766e', '#d97706', '#c41230', '#475569', '#0369a1',
        '#1d4ed8', '#64748b'];
    var DARK_PALETTE = ['#00e5ff', '#38bdf8', '#2dd4bf', '#fbbf24', '#ff5a6e', '#818cf8',
        '#34d399', '#60a5fa'];

    var LIGHT = {
        text: '#0f172a', sub: '#64748b', axis: '#dce4f0', split: '#eef2f7',
        tooltipBg: 'rgba(255,255,255,.98)', tooltipBorder: '#dce4f0', tooltipText: '#0f172a',
        legend: '#475569'
    };
    var DARK = {
        text: '#e2eeff', sub: '#8eb2de', axis: 'rgba(56,189,248,.28)',
        split: 'rgba(56,189,248,.12)', tooltipBg: 'rgba(6,18,38,.94)',
        tooltipBorder: 'rgba(0,229,255,.45)', tooltipText: '#e6f4ff', legend: '#a6c8f0'
    };

    var instances = [];   // 用数组而非 WeakMap：便于 window.resize 时统一遍历

    function available() {
        return !!(global.echarts && typeof global.echarts.init === 'function');
    }

    function theme(dark) { return dark ? DARK : LIGHT; }

    function palette(i, dark) {
        var p = dark ? DARK_PALETTE : PALETTE;
        return p[i % p.length];
    }

    function resolve(dom) {
        if (typeof dom === 'string') { return global.document.querySelector(dom); }
        return dom;
    }

    function emptyText(dom, text) {
        var el = resolve(dom);
        if (!el) { return; }
        var box = el.querySelector('.ck-empty');
        if (!box) {
            box = global.document.createElement('div');
            box.className = 'ck-empty';
            el.appendChild(box);
        }
        box.textContent = text || '暂无数据';
        box.style.display = text === null ? 'none' : 'flex';
    }

    function clearEmpty(dom) {
        var el = resolve(dom);
        if (!el) { return; }
        var box = el.querySelector('.ck-empty');
        if (box) { box.style.display = 'none'; }
    }

    function track(inst) {
        instances.push(inst);
        if (global.ResizeObserver) {
            var ro = new global.ResizeObserver(function () {
                try { inst.resize(); } catch (e) { /* 容器已销毁 */ }
            });
            ro.observe(inst.getDom());
            inst.__ckRo = ro;
        }
    }

    function baseOption(dark) {
        var t = theme(dark);
        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'inherit', color: t.text },
            animation: !(global.document && global.document.hidden),
            animationDuration: 280,
            animationEasing: 'cubicOut',
            tooltip: {
                trigger: 'axis',
                backgroundColor: t.tooltipBg,
                borderColor: t.tooltipBorder,
                borderWidth: 1,
                padding: [8, 12],
                textStyle: { color: t.tooltipText, fontSize: 12 },
                axisPointer: { type: 'line', lineStyle: { color: t.axis, width: 1 } }
            },
            grid: { left: 44, right: 18, top: 30, bottom: 30, containLabel: false },
            legend: {
                show: true, top: 2, right: 4, itemWidth: 10, itemHeight: 10,
                icon: 'roundRect', textStyle: { color: t.legend, fontSize: 12 }
            }
        };
    }

    function axisCommon(dark, kind) {
        var t = theme(dark);
        var cfg = {
            axisLine: { show: true, lineStyle: { color: t.axis } },
            axisTick: { show: false },
            axisLabel: { color: t.sub, fontSize: 11, hideOverlap: true },
            splitLine: { show: kind === 'value', lineStyle: { color: t.split, type: 'dashed' } }
        };
        return cfg;
    }

    /**
     * 初始化/复用图表实例
     * @param {string|Element} dom 容器（需有明确高度）
     * @param {Object} opts {dark:boolean, renderer:'canvas'}
     */
    function init(dom, opts) {
        var el = resolve(dom);
        if (!el) { return null; }
        if (!available()) {
            emptyText(el, '图表库未加载：请检查 /static/vendor/echarts/echarts.min.js');
            return null;
        }
        if (el.__ckInst && !el.__ckInst.isDisposed()) {
            return el.__ckInst;
        }
        var inst = global.echarts.init(el, null, {
            renderer: (opts && opts.renderer) || 'canvas',
            useDirtyRect: false
        });
        el.__ckInst = inst;
        inst.__ckDark = !!(opts && opts.dark);
        track(inst);
        return inst;
    }

    function dispose(dom) {
        var el = resolve(dom);
        if (el && el.__ckInst && !el.__ckInst.isDisposed()) {
            if (el.__ckInst.__ckRo) { el.__ckInst.__ckRo.disconnect(); }
            el.__ckInst.dispose();
            var idx = instances.indexOf(el.__ckInst);
            if (idx >= 0) { instances.splice(idx, 1); }
        }
        if (el) { el.__ckInst = null; }
    }

    function setOption(dom, option, opts) {
        var inst = init(dom, opts);
        if (!inst) { return null; }
        inst.__ckDark = !!(opts && opts.dark);
        inst.setOption(option, true);
        clearEmpty(dom);
        return inst;
    }

    function loading(dom, on, text) {
        var inst = init(dom);
        if (!inst) { return; }
        if (on) {
            inst.showLoading({
                text: text || '加载中',
                color: PALETTE[0],
                textColor: theme(inst.__ckDark).sub,
                maskColor: 'rgba(255,255,255,0)',
                fontSize: 12
            });
        } else {
            inst.hideLoading();
        }
    }

    // ==================== 常用图表 ====================

    /**
     * 折线/面积图
     * series: [{name, data, area?:boolean, dashed?:boolean}]
     */
    function renderLine(dom, cfg) {
        var dark = !!cfg.dark;
        var t = theme(dark);
        var option = baseOption(dark);
        option.grid = cfg.grid || { left: 46, right: 22, top: 32, bottom: 28 };
        option.tooltip.valueFormatter = cfg.valueFormatter;
        option.xAxis = Object.assign({
            type: 'category', boundaryGap: false, data: cfg.categories || []
        }, axisCommon(dark, 'category'));
        option.yAxis = Object.assign({
            type: 'value', name: cfg.yName || ''
        }, axisCommon(dark, 'value'), {
            nameTextStyle: { color: t.sub, fontSize: 11, padding: [0, 0, 0, 6] }
        });
        option.legend.show = cfg.legend !== false;
        option.series = (cfg.series || []).map(function (s, i) {
            var color = s.color || palette(i, dark);
            return {
                name: s.name,
                type: 'line',
                smooth: cfg.smooth !== false,
                symbol: 'circle',
                symbolSize: 5,
                showSymbol: cfg.showSymbol !== false,
                data: s.data,
                lineStyle: { width: 2, color: color, type: s.dashed ? 'dashed' : 'solid' },
                itemStyle: { color: color },
                areaStyle: s.area ? {
                    opacity: 1,
                    color: new global.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: hexA(color, 0.42) },
                        { offset: 1, color: hexA(color, 0.02) }
                    ])
                } : null,
                emphasis: { focus: 'series' }
            };
        });
        if (!option.series.length) {
            emptyText(dom, cfg.empty || '暂无数据');
            return null;
        }
        return setOption(dom, option, { dark: dark });
    }

    /**
     * 柱状图（支持堆叠）
     * series: [{name, data, color?}]；stack=true 时同 stack 名
     */
    function renderBar(dom, cfg) {
        var dark = !!cfg.dark;
        var t = theme(dark);
        var option = baseOption(dark);
        option.grid = cfg.grid || { left: 46, right: 22, top: 32, bottom: 30 };
        option.tooltip.axisPointer = { type: 'shadow', shadowStyle: { color: hexA(PALETTE[0], 0.06) } };
        option.xAxis = Object.assign({
            type: 'category', data: cfg.categories || [],
            axisLabel: { color: t.sub, fontSize: 11, interval: cfg.interval || 'auto', rotate: cfg.rotate || 0 }
        }, axisCommon(dark, 'category'));
        option.yAxis = Object.assign({ type: 'value' }, axisCommon(dark, 'value'));
        option.legend.show = cfg.legend !== false && (cfg.series || []).length > 1;
        option.series = (cfg.series || []).map(function (s, i) {
            var color = s.color || palette(i, dark);
            return {
                name: s.name,
                type: 'bar',
                stack: cfg.stack ? (s.stack || 'total') : undefined,
                barMaxWidth: cfg.barMaxWidth || 26,
                data: s.data,
                itemStyle: {
                    color: cfg.stack ? color : new global.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: hexA(color, 0.95) },
                        { offset: 1, color: hexA(color, 0.55) }
                    ]),
                    borderRadius: cfg.stack ? 0 : [4, 4, 0, 0]
                },
                emphasis: { focus: 'series' }
            };
        });
        if (!option.series.length) {
            emptyText(dom, cfg.empty || '暂无数据');
            return null;
        }
        return setOption(dom, option, { dark: dark });
    }

    /**
     * 环形/饼图
     * data: [{name, value, color?}]
     */
    function renderPie(dom, cfg) {
        var dark = !!cfg.dark;
        var t = theme(dark);
        var option = baseOption(dark);
        option.tooltip.trigger = 'item';
        option.tooltip.formatter = cfg.formatter;
        option.legend = {
            show: cfg.legend !== false, orient: cfg.legendOrient || 'vertical',
            right: cfg.legendRight === undefined ? 6 : cfg.legendRight,
            top: cfg.legendTop || 'middle', itemWidth: 9, itemHeight: 9,
            icon: 'circle', textStyle: { color: t.legend, fontSize: 12 }
        };
        option.series = [{
            name: cfg.name || '占比',
            type: 'pie',
            radius: cfg.radius || ['52%', '74%'],
            center: cfg.center || ['38%', '52%'],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: dark ? 'rgba(6,14,28,.9)' : '#fff', borderWidth: 3 },
            label: { show: false },
            emphasis: {
                scale: true, scaleSize: 6,
                label: { show: true, color: t.text, fontSize: 13, fontWeight: 600,
                    formatter: cfg.centerLabel || '{b}\n{d}%' }
            },
            labelLine: { show: false },
            data: (cfg.data || []).map(function (d, i) {
                return { name: d.name, value: d.value, itemStyle: { color: d.color || palette(i, dark) } };
            })
        }];
        if (!cfg.data || !cfg.data.length) {
            emptyText(dom, cfg.empty || '暂无数据');
            return null;
        }
        return setOption(dom, option, { dark: dark });
    }

    /**
     * 中国地图（按省级数值着色；暗色大屏默认开启 ECharts 指向性飞线 + 雷达信标）
     * cfg.data: [{name:'广东', value:12}]
     */
    function renderChinaMap(dom, cfg) {
        var dark = !!cfg.dark;
        var t = theme(dark);
        var option = baseOption(dark);
        option.legend.show = false;
        option.grid = undefined;
        option.tooltip.trigger = 'item';
        option.tooltip.formatter = function (p) {
            if (p.seriesType === 'lines') {
                return (p.data.fromName || '') + ' → 西华师大 · 南充' +
                    (p.data.value ? '：' + p.data.value + ' 条' : '');
            }
            if (p.seriesType === 'effectScatter') {
                var v = Array.isArray(p.data && p.data.value) ? p.data.value[2] : (p.data && p.data.value);
                return p.name + (v ? '：' + v + ' 条' : '：高校服务节点');
            }
            if (!p.data || !p.data.value) { return p.name + '：' + (cfg.emptyTip || '暂无提及'); }
            return p.name + '：' + p.data.value + ' 条';
        };
        option.visualMap = {
            show: true, min: 0, max: Math.max(1, cfg.max || 1), seriesIndex: 0,
            left: 10, bottom: 12, orient: 'vertical', itemWidth: 9, itemHeight: 72,
            text: ['高', '低'], textStyle: { color: t.sub, fontSize: 10 },
            inRange: { color: dark ? ['rgba(20,76,148,.38)', 'rgba(0,180,240,.65)', '#00e5ff'] : ['#dbeafe', '#2563eb', '#003087'] },
            calculable: false
        };

        var showFlights = dark && cfg.flightLines !== false;
        var mapSeries = {
            type: 'map',
            map: 'china',
            roam: !!cfg.roam,
            zoom: cfg.zoom || 1.15,
            top: cfg.top || 8,
            bottom: cfg.bottom || 4,
            label: { show: false },
            itemStyle: {
                areaColor: dark ? 'rgba(14,42,88,.68)' : '#eef3fb',
                borderColor: dark ? 'rgba(56,189,248,.52)' : '#c9d6ea',
                borderWidth: 1,
                shadowColor: dark ? 'rgba(0,212,255,.18)' : 'transparent',
                shadowBlur: dark ? 14 : 0
            },
            emphasis: {
                label: { show: true, color: '#fff', fontSize: 11 },
                itemStyle: { areaColor: '#fbbf24', borderColor: '#fff' }
            },
            select: { disabled: true },
            data: (cfg.data || []).map(function (d) { return { name: d.name, value: d.value }; })
        };

        if (!showFlights) {
            option.series = [mapSeries];
            return setOption(dom, option, { dark: dark });
        }

        // 暗色科技大屏模式：启用 geo 底层 + map 热力 + 指向西华师大南充的箭头飞线与信标
        var HUB_COORD = [106.08, 30.79];
        var cpByName = {};
        if (chinaGeoCache && Array.isArray(chinaGeoCache.features)) {
            chinaGeoCache.features.forEach(function (f) {
                var p = f.properties || {};
                if (p.name && Array.isArray(p.cp) && p.cp.length >= 2) {
                    cpByName[p.name] = [Number(p.cp[0]), Number(p.cp[1])];
                }
            });
        }
        var activeRows = (cfg.data || []).filter(function (d) { return d && d.name && cpByName[d.name]; });
        if (!activeRows.length) {
            activeRows = [
                { name: '北京', value: 0 }, { name: '上海', value: 0 },
                { name: '广东', value: 0 }, { name: '浙江', value: 0 },
                { name: '湖北', value: 0 }, { name: '陕西', value: 0 }
            ].filter(function (d) { return !!cpByName[d.name]; });
        }

        var lineData = [];
        var pointData = [];
        activeRows.slice(0, 10).forEach(function (item) {
            var coord = cpByName[item.name];
            if (!coord) return;
            lineData.push({
                fromName: item.name,
                toName: '西华师大 · 南充',
                value: item.value || 0,
                coords: [coord, HUB_COORD]
            });
            pointData.push({
                name: item.name,
                value: [coord[0], coord[1], item.value || 0]
            });
        });

        option.geo = {
            map: 'china',
            roam: !!cfg.roam,
            zoom: cfg.zoom || 1.15,
            top: cfg.top || 8,
            bottom: cfg.bottom || 4,
            label: { show: false },
            itemStyle: mapSeries.itemStyle,
            emphasis: mapSeries.emphasis,
            select: { disabled: true }
        };
        mapSeries.geoIndex = 0;

        option.series = [
            mapSeries,
            {
                name: '智联流向',
                type: 'lines',
                coordinateSystem: 'geo',
                zlevel: 1,
                effect: {
                    show: true,
                    period: 3.4,
                    trailLength: 0.22,
                    symbol: 'arrow',
                    symbolSize: 8,
                    color: '#00e5ff'
                },
                lineStyle: {
                    color: '#38bdf8',
                    width: 1.4,
                    opacity: 0.45,
                    curveness: 0.26
                },
                data: lineData
            },
            {
                name: '地域信标',
                type: 'effectScatter',
                coordinateSystem: 'geo',
                zlevel: 2,
                rippleEffect: { brushType: 'stroke', scale: 3.4, period: 3.5 },
                label: {
                    show: true,
                    position: 'right',
                    formatter: '{b}',
                    color: '#93c5fd',
                    fontSize: 10
                },
                symbolSize: 6,
                itemStyle: { color: '#00e5ff', shadowBlur: 8, shadowColor: '#00e5ff' },
                data: pointData
            },
            {
                name: '校本部枢纽',
                type: 'effectScatter',
                coordinateSystem: 'geo',
                zlevel: 2,
                rippleEffect: { brushType: 'stroke', scale: 4.6, period: 2.8 },
                symbolSize: 12,
                itemStyle: { color: '#fbbf24', shadowBlur: 14, shadowColor: '#fbbf24' },
                label: {
                    show: true,
                    position: 'bottom',
                    formatter: '{b}',
                    color: '#fde68a',
                    fontSize: 11,
                    fontWeight: 700,
                    backgroundColor: 'rgba(6,18,38,.75)',
                    borderColor: 'rgba(251,191,36,.45)',
                    borderWidth: 1,
                    borderRadius: 4,
                    padding: [2, 6]
                },
                data: [{ name: '西华师大 · 南充', value: [HUB_COORD[0], HUB_COORD[1], 1] }]
            }
        ];

        return setOption(dom, option, { dark: dark });
    }

    /**
     * 横向排行条（信源 / 关键词）
     */
    function renderRankBar(dom, cfg) {
        var dark = !!cfg.dark;
        var t = theme(dark);
        var option = baseOption(dark);
        option.legend.show = false;
        option.grid = { left: 8, right: 52, top: 8, bottom: 8, containLabel: true };
        option.tooltip.trigger = 'item';
        option.xAxis = Object.assign({ type: 'value', axisLabel: { show: false } },
            axisCommon(dark, 'value'), { splitLine: { show: false } });
        option.yAxis = Object.assign({
            type: 'category', inverse: true,
            data: (cfg.data || []).map(function (d) { return d.name; })
        }, axisCommon(dark, 'category'), { splitLine: { show: false } });
        option.series = [{
            type: 'bar',
            barMaxWidth: cfg.barMaxWidth || 14,
            data: (cfg.data || []).map(function (d, i) {
                return {
                    value: d.value,
                    itemStyle: {
                        borderRadius: [0, 7, 7, 0],
                        color: new global.echarts.graphic.LinearGradient(0, 0, 1, 0, [
                            { offset: 0, color: hexA(d.color || palette(i, dark), 0.45) },
                            { offset: 1, color: d.color || palette(i, dark) }
                        ])
                    }
                };
            }),
            label: {
                show: true, position: 'right', color: t.text, fontSize: 11,
                formatter: function (p) { return cfg.suffix ? p.value + cfg.suffix : p.value; }
            }
        }];
        if (!cfg.data || !cfg.data.length) {
            emptyText(dom, cfg.empty || '暂无数据');
            return null;
        }
        return setOption(dom, option, { dark: dark });
    }

    /**
     * 迷你趋势图（ECharts 5 无坐标轴微折线 / 微柱图，用于大屏 KPI 卡片）
     */
    function renderMiniSparkline(dom, cfg) {
        var el = resolve(dom);
        if (!el || !available()) { return null; }
        var vals = (cfg && cfg.data) || [];
        var color = (cfg && cfg.color) || '#00e5ff';
        var isBar = !!(cfg && cfg.type === 'bar');
        var option = {
            backgroundColor: 'transparent',
            animationDuration: 360,
            grid: { left: 2, right: 2, top: 6, bottom: 2 },
            tooltip: { show: false },
            xAxis: { type: 'category', show: false, boundaryGap: isBar, data: vals.map(function (_, i) { return i; }) },
            yAxis: { type: 'value', show: false, min: 0 },
            series: [{
                type: isBar ? 'bar' : 'line',
                smooth: 0.45,
                symbol: 'none',
                barMaxWidth: 5,
                data: vals.length ? vals : [0, 0, 0, 0],
                lineStyle: isBar ? undefined : { width: 1.8, color: color },
                itemStyle: isBar ? {
                    borderRadius: [2, 2, 0, 0],
                    color: new global.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: color },
                        { offset: 1, color: hexA(color, 0.25) }
                    ])
                } : { color: color },
                areaStyle: isBar ? undefined : {
                    color: new global.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: hexA(color, 0.42) },
                        { offset: 1, color: hexA(color, 0.02) }
                    ])
                }
            }]
        };
        var inst = el.__ckInst && !el.__ckInst.isDisposed()
            ? el.__ckInst
            : init(el, { dark: true });
        if (!inst) { return null; }
        inst.setOption(option, true);
        return inst;
    }

    /**
     * 迷你环形占比仪表（ECharts 5 gauge，用于大屏 KPI 卡片）
     */
    function renderMiniGauge(dom, cfg) {
        var el = resolve(dom);
        if (!el || !available()) { return null; }
        var pct = Math.max(0, Math.min(100, Number((cfg && cfg.percent) || 0)));
        var color = (cfg && cfg.color) || '#2dd4bf';
        var option = {
            backgroundColor: 'transparent',
            animationDuration: 420,
            series: [{
                type: 'gauge',
                startAngle: 90,
                endAngle: -270,
                radius: '90%',
                pointer: { show: false },
                progress: {
                    show: true,
                    overlap: false,
                    roundCap: true,
                    clip: false,
                    itemStyle: { color: color, shadowBlur: 6, shadowColor: hexA(color, 0.55) }
                },
                axisLine: { lineStyle: { width: 5, color: [[1, 'rgba(56,189,248,.16)']] } },
                splitLine: { show: false },
                axisTick: { show: false },
                axisLabel: { show: false },
                data: [{ value: Math.round(pct) }],
                title: { show: false },
                detail: {
                    offsetCenter: [0, '4%'],
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: '#e2eeff',
                    formatter: '{value}%'
                }
            }]
        };
        var inst = el.__ckInst && !el.__ckInst.isDisposed()
            ? el.__ckInst
            : init(el, { dark: true });
        if (!inst) { return null; }
        inst.setOption(option, true);
        return inst;
    }

    // ==================== 导出 ====================

    function exportPng(dom, filename, dark) {
        var el = resolve(dom);
        if (!el || !el.__ckInst || el.__ckInst.isDisposed()) { return false; }
        var url = el.__ckInst.getDataURL({
            type: 'png', pixelRatio: 2, backgroundColor: dark ? '#081426' : '#ffffff'
        });
        var a = global.document.createElement('a');
        a.href = url;
        a.download = filename || 'chart.png';
        global.document.body.appendChild(a);
        a.click();
        global.document.body.removeChild(a);
        return true;
    }

    // ==================== 地图注册 ====================

    var mapPromise = null;
    var chinaGeoCache = null;

    function loadChinaMap(jsonUrl) {
        if (!available()) { return Promise.reject(new Error('echarts 未加载')); }
        if (chinaGeoCache && global.echarts.getMap && global.echarts.getMap('china')) {
            return Promise.resolve(chinaGeoCache);
        }
        if (mapPromise) { return mapPromise; }
        mapPromise = new Promise(function (resolve, reject) {
            var xhr = new global.XMLHttpRequest();
            xhr.open('GET', jsonUrl || '/static/vendor/echarts/china.json', true);
            xhr.onload = function () {
                if (xhr.status !== 200) {
                    mapPromise = null;
                    reject(new Error('地图数据加载失败：HTTP ' + xhr.status));
                    return;
                }
                try {
                    var geo = JSON.parse(xhr.responseText);
                    chinaGeoCache = geo;
                    global.echarts.registerMap('china', geo);
                    resolve(geo);
                } catch (e) {
                    mapPromise = null;
                    reject(e);
                }
            };
            xhr.onerror = function () {
                mapPromise = null;
                reject(new Error('地图数据加载失败：网络错误'));
            };
            xhr.send();
        });
        return mapPromise;
    }

    // ==================== 工具函数 ====================

    function hexA(hex, alpha) {
        if (!hex || hex.indexOf('#') !== 0) { return hex; }
        var h = hex.slice(1);
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        var r = parseInt(h.slice(0, 2), 16);
        var g = parseInt(h.slice(2, 4), 16);
        var b = parseInt(h.slice(4, 6), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    function resizeAll() {
        instances.forEach(function (inst) {
            if (!inst.isDisposed()) {
                try { inst.resize(); } catch (e) { /* ignore */ }
            }
        });
    }

    if (global.addEventListener) {
        var timer = null;
        global.addEventListener('resize', function () {
            global.clearTimeout(timer);
            timer = global.setTimeout(resizeAll, 120);
        });
    }

    global.ChartKit = {
        available: available,
        init: init,
        dispose: dispose,
        setOption: setOption,
        loading: loading,
        empty: emptyText,
        clearEmpty: clearEmpty,
        renderLine: renderLine,
        renderBar: renderBar,
        renderPie: renderPie,
        renderChinaMap: renderChinaMap,
        renderRankBar: renderRankBar,
        renderMiniSparkline: renderMiniSparkline,
        renderMiniGauge: renderMiniGauge,
        getChinaGeo: function () { return chinaGeoCache; },
        exportPng: exportPng,
        loadChinaMap: loadChinaMap,
        resizeAll: resizeAll,
        palette: palette,
        theme: theme,
        hexA: hexA
    };
})(window);
