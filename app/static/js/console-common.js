/**
 * console-common.js —— 大屏 / 报表 / 预警台 / 系统设置共用的小工具（成员 C）
 *
 * 只做四件事，不掺业务：
 *   1) api()：统一带 X-Xsrftoken 的 fetch 封装，401 跳登录，错误统一提示；
 *   2) esc()/fmtNum()/fmtTime()：文本转义与数字、时间格式化（后台所有动态 DOM 必须走 esc）；
 *   3) toast()：有 layui 用 layer.msg，大屏这种无 layui 页面用自绘轻提示；
 *   4) tabSwitch()：同页多卡片/多视图切换的通用 class 切换。
 */
(function (global) {
    'use strict';

    var doc = global.document;

    function $(sel, root) { return (root || doc).querySelector(sel); }
    function $all(sel, root) {
        return Array.prototype.slice.call((root || doc).querySelectorAll(sel));
    }

    function cookie(name) {
        var match = doc.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : '';
    }

    function xsrf() {
        var fromCookie = cookie('_xsrf');
        if (fromCookie) { return fromCookie; }
        var input = doc.querySelector('input[name="_xsrf"]');
        return input ? input.value : '';
    }

    /**
     * 统一请求：返回解析后的 JSON；失败抛 Error（带 status 与后端 error 文案）
     * @param {string} method GET/POST/PUT/DELETE
     * @param {string} url
     * @param {Object} [body] JSON 体
     */
    function api(method, url, body) {
        var opts = {
            method: method || 'GET',
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        };
        if (body !== undefined && body !== null) {
            opts.headers['Content-Type'] = 'application/json';
            opts.headers['X-Xsrftoken'] = xsrf();
            opts.body = JSON.stringify(body);
        }
        return global.fetch(url, opts).then(function (resp) {
            if (resp.status === 401) {
                global.location.href = '/auth/login?next=' + encodeURIComponent(global.location.pathname);
                throw new Error('登录已过期');
            }
            return resp.text().then(function (text) {
                var data = null;
                try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { ok: false, error: text }; }
                if (!resp.ok || (data && data.ok === false)) {
                    var msg = (data && (data.error || data.message)) || ('请求失败 HTTP ' + resp.status);
                    var err = new Error(msg);
                    err.status = resp.status;
                    throw err;
                }
                return data || {};
            });
        });
    }

    function esc(value) {
        if (value === null || value === undefined) { return ''; }
        return String(value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmtNum(value) {
        var n = Number(value || 0);
        if (!isFinite(n)) { return '0'; }
        if (Math.abs(n) >= 100000000) { return (n / 100000000).toFixed(2) + ' 亿'; }
        if (Math.abs(n) >= 10000) { return (n / 10000).toFixed(1) + ' 万'; }
        return n.toLocaleString('zh-CN');
    }

    function fmtTime(value, withSecond) {
        if (!value) { return '-'; }
        var text = String(value).replace('T', ' ');
        return withSecond ? text.slice(0, 19) : text.slice(0, 16);
    }

    function toast(message, type) {
        if (global.layui && global.layui.layer && global.layui.layer.msg) {
            global.layui.layer.msg(message, { icon: type === 'error' ? 2 : (type === 'ok' ? 1 : 0),
                time: 2200 });
            return;
        }
        var box = doc.querySelector('.ck-toast');
        if (!box) {
            box = doc.createElement('div');
            box.className = 'ck-toast';
            doc.body.appendChild(box);
        }
        box.textContent = message;
        box.setAttribute('data-type', type || 'info');
        box.classList.add('is-show');
        global.clearTimeout(box.__timer);
        box.__timer = global.setTimeout(function () { box.classList.remove('is-show'); }, 2400);
    }

    function tabSwitch(root, attr, value) {
        $all('[' + attr + ']', root).forEach(function (btn) {
            btn.classList.toggle('is-active', btn.getAttribute(attr) === value);
        });
    }

    function debounce(fn, wait) {
        var timer = null;
        return function () {
            var args = arguments, self = this;
            global.clearTimeout(timer);
            timer = global.setTimeout(function () { fn.apply(self, args); }, wait || 300);
        };
    }

    global.Console = {
        $: $, $all: $all, api: api, esc: esc, fmtNum: fmtNum, fmtTime: fmtTime,
        toast: toast, tabSwitch: tabSwitch, debounce: debounce, xsrf: xsrf
    };
})(window);
