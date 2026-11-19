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
    var DARK_PALETTE = ['#2f6feb', '#13b5a6', '#f0a83a', '#e5544b', '#8a7bf0', '#54b96b',
        '#c9a227', '#5a8fbf'];

    var LIGHT = {
        text: '#0f172a', sub: '#64748b', axis: '#dce4f0', split: '#eef2f7',
        tooltipBg: 'rgba(255,255,255,.98)', tooltipBorder: '#dce4f0', tooltipText: '#0f172a',
        legend: '#475569'
    };
    var DARK = {
        text: '#dbe7ff', sub: '#8ba2c4', axis: 'rgba(120,160,220,.28)',
        split: 'rgba(120,160,220,.14)', tooltipBg: 'rgba(10,22,44,.94)',
        tooltipBorder: 'rgba(86,160,255,.42)', tooltipText: '#e7f0ff', legend: '#9db6d8'
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
            animationDuration: 420,
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
            el.__ckInst.clear();
            return el.__ckInst;
        }
        var inst = global.echarts.init(el, null, {
            renderer: (opts && opts.renderer) || 'canvas',
            useDirtyRect: true
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
     * 中国地图（按省级数值着色）
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
            if (!p.data) { return p.name + '：' + (cfg.emptyTip || '暂无提及'); }
            return p.name + '：' + p.data.value + ' 条';
        };
        option.visualMap = {
            show: true, min: 0, max: Math.max(1, cfg.max || 1),
            left: 10, bottom: 12, orient: 'vertical', itemWidth: 10, itemHeight: 74,
            text: ['高', '低'], textStyle: { color: t.sub, fontSize: 10 },
            inRange: { color: ['rgba(64,140,255,.16)', 'rgba(64,160,255,.62)', '#2f6feb'] },
            calculable: false
        };
        option.series = [{
            type: 'map',
            map: 'china',
            roam: !!cfg.roam,
            zoom: cfg.zoom || 1.15,
            top: cfg.top || 8,
            bottom: cfg.bottom || 4,
            label: { show: false },
            itemStyle: {
                areaColor: dark ? 'rgba(28,58,104,.55)' : '#eef3fb',
                borderColor: dark ? 'rgba(96,168,255,.45)' : '#c9d6ea',
                borderWidth: 1
            },
            emphasis: {
                label: { show: true, color: '#fff', fontSize: 11 },
                itemStyle: { areaColor: '#f0a83a', borderColor: '#fff' }
            },
            select: { disabled: true },
            data: (cfg.data || []).map(function (d) { return { name: d.name, value: d.value }; })
        }];
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

    function loadChinaMap(jsonUrl) {
        if (!available()) { return Promise.reject(new Error('echarts 未加载')); }
        if (global.echarts.getMap && global.echarts.getMap('china')) { return Promise.resolve(true); }
        if (mapPromise) { return mapPromise; }
        mapPromise = new Promise(function (resolve, reject) {
            var xhr = new global.XMLHttpRequest();
            xhr.open('GET', jsonUrl || '/static/vendor/echarts/china.json', true);
            xhr.onload = function () {
                if (xhr.status !== 200) {
                    reject(new Error('地图数据加载失败：HTTP ' + xhr.status));
                    return;
                }
                try {
                    var geo = JSON.parse(xhr.responseText);
                    global.echarts.registerMap('china', geo);
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            };
            xhr.onerror = function () { reject(new Error('地图数据加载失败：网络错误')); };
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
        exportPng: exportPng,
        loadChinaMap: loadChinaMap,
        resizeAll: resizeAll,
        palette: palette,
        theme: theme,
        hexA: hexA
    };
})(window);
