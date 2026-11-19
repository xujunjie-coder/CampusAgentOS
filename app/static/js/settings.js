/**
 * settings.js —— 系统设置（成员 C）
 *
 * 接口：POST /api/admin/settings
 *   {action:"save", group:"brand|voice|security|db", values:{...}}
 *   {action:"brand", kind:"logo|favicon", data_uri:"data:image/..."}
 *   {action:"db_test", driver:"sqlite|mysql", params:{...}}
 *   {action:"db_switch", driver:"sqlite|mysql", params:{...}}
 *
 * 约定：图标上传即落库（返回 url），表单只负责名称/水印/刷新间隔等文本项；
 * 数据库参数里密码为掩码时不随请求发送，服务端回退到 .env 现网密码。
 */
(function () {
    'use strict';

    var C = window.Console;
    var MAX_IMAGE = 64 * 1024;

    function id(name) { return document.getElementById(name); }
    function val(name) { var el = id(name); return el ? el.value.trim() : ''; }
    function on(name) { var el = id(name); return el && el.checked ? '1' : '0'; }

    function msg(text, kind) {
        if (window.layui && layui.layer) {
            layui.layer.msg(text, { icon: kind === 'error' ? 2 : 1, time: 2400 });
        } else {
            C.toast(text, kind === 'error' ? 'error' : 'ok');
        }
    }

    function post(payload) { return C.api('POST', '/api/admin/settings', payload); }

    function fail(err) { msg(err.message || '保存失败', 'error'); }

    /* ---------------- 系统标识 ---------------- */
    function saveBrand() {
        var name = val('siteName');
        if (!name) { msg('系统名称不能为空', 'error'); return; }
        if (name.length > 48) { msg('系统名称不能超过 48 字', 'error'); return; }
        post({
            action: 'save', group: 'brand',
            values: {
                site_name: name,
                site_subtitle: val('siteSubtitle'),
                site_logo: val('siteLogo'),
                site_favicon: val('siteFavicon'),
                ui_watermark: on('uiWatermark'),
                dashboard_refresh: val('dashboardRefresh')
            }
        }).then(function () {
            document.title = name + ' | ' + val('siteSubtitle');
            msg('标识设置已保存，新打开页面即时生效');
        }).catch(fail);
    }

    function uploadIcon(kind, inputId, hiddenId, previewId) {
        var input = id(inputId);
        var file = input.files && input.files[0];
        if (!file) { return; }
        if (file.size > MAX_IMAGE) {
            msg('图片超过 64 KB，请压缩后再上传', 'error');
            input.value = '';
            return;
        }
        var reader = new FileReader();
        reader.onload = function () {
            post({ action: 'brand', kind: kind, data_uri: reader.result }).then(function (res) {
                id(hiddenId).value = res.url;
                var box = id(previewId);
                box.innerHTML = '<img src="' + C.esc(res.url) + '" alt="' + kind + '">';
                if (kind === 'favicon') {
                    var link = document.querySelector("link[rel='icon']");
                    if (!link) {
                        link = document.createElement('link');
                        link.rel = 'icon';
                        document.head.appendChild(link);
                    }
                    link.href = res.url;
                }
                msg('已上传 ' + Math.round(res.size / 1024) + ' KB（' + res.ext + '），保存后全站生效');
            }).catch(fail);
            input.value = '';
        };
        reader.readAsDataURL(file);
    }

    /* ---------------- 数据库 ---------------- */
    function currentDriver() {
        var radios = document.querySelectorAll('input[name="dbDriver"]');
        for (var i = 0; i < radios.length; i += 1) {
            if (radios[i].checked) { return radios[i].value; }
        }
        return 'sqlite';
    }

    function dbParams() {
        var driver = currentDriver();
        if (driver !== 'mysql') { return {}; }
        var params = {
            host: val('dbHost'), port: val('dbPort'), user: val('dbUser'),
            name: val('dbName'), charset: val('dbCharset')
        };
        var pw = val('dbPassword');
        if (pw && pw.indexOf('******') !== 0) { params.password = pw; }
        return params;
    }

    function syncDriverFields() {
        var isMysql = currentDriver() === 'mysql';
        id('mysqlFields').classList.toggle('is-on', isMysql);
    }

    function testDb() {
        var btn = id('btnTestDb');
        btn.classList.add('layui-btn-disabled');
        post({ action: 'db_test', driver: currentDriver(), params: dbParams() }).then(function (res) {
            btn.classList.remove('layui-btn-disabled');
            msg('连接正常：' + (res.version || '') + ' · ' + (res.detail || ''));
        }).catch(function (err) {
            btn.classList.remove('layui-btn-disabled');
            msg(err.message, 'error');
        });
    }

    function switchDb() {
        var driver = currentDriver();
        var tip = driver === 'mysql'
            ? '确认切换到 MySQL？目标库为空表结构，历史数据不会自动迁移，切换后需要重新登录。'
            : '确认切回 SQLite？本地数据库文件中的原有数据仍在。';
        var doSwitch = function () {
            var btn = id('btnSwitchDb');
            btn.classList.add('layui-btn-disabled');
            post({ action: 'db_switch', driver: driver, params: dbParams() }).then(function () {
                btn.classList.remove('layui-btn-disabled');
                if (window.layui && layui.layer) {
                    layui.layer.alert('切换成功，即将返回登录页（新库会话需重新登录）。', { icon: 1 }, function () {
                        location.href = '/auth/login?next=/admin/settings';
                    });
                } else {
                    location.href = '/auth/login?next=/admin/settings';
                }
            }).catch(function (err) {
                btn.classList.remove('layui-btn-disabled');
                msg(err.message, 'error');
            });
        };
        if (window.layui && layui.layer) {
            layui.layer.confirm(tip, { title: '切换数据库', icon: 3 }, function () { layui.layer.closeAll(); doSwitch(); });
        } else if (window.confirm(tip)) {
            doSwitch();
        }
    }

    /* ---------------- 语音与人脸 ---------------- */
    function fillVoices() {
        if (!window.speechSynthesis) {
            id('ttsVoice').innerHTML = '<option value="">当前浏览器不支持 speechSynthesis</option>';
            return;
        }
        var select = id('ttsVoice');
        var current = select.value;
        var voices = window.speechSynthesis.getVoices() || [];
        var options = ['<option value="">自动（优先中文语音）</option>'];
        voices.forEach(function (v) {
            if ((v.lang || '').toLowerCase().indexOf('zh') !== 0) { return; }
            options.push('<option value="' + C.esc(v.name) + '"' +
                (v.name === current ? ' selected' : '') + '>' + C.esc(v.name) + '（' + v.lang + '）</option>');
        });
        if (voices.length) { select.innerHTML = options.join(''); }
        if (window.layui && layui.form) { layui.form.render('select'); }
    }

    function saveVoice() {
        post({
            action: 'save', group: 'voice',
            values: {
                tts_voice: val('ttsVoice'),
                tts_rate: val('ttsRate'),
                tts_autoplay: on('ttsAutoplay'),
                asr_enabled: on('asrEnabled'),
                face_engine: val('faceEngine'),
                face_threshold: val('faceThreshold')
            }
        }).then(function () { msg('语音与人脸配置已保存'); }).catch(fail);
    }

    /* ---------------- 安全参数 ---------------- */
    function saveSecurity() {
        post({
            action: 'save', group: 'security',
            values: {
                session_ttl_hours: val('sessionTtl'),
                login_max_fails: val('loginFails'),
                login_lock_minutes: val('lockMinutes'),
                audit_keep_days: val('auditDays')
            }
        }).then(function () {
            msg('安全参数已保存，新登录按新策略执行');
        }).catch(fail);
    }

    /* ---------------- 绑定 ---------------- */
    function bind() {
        id('btnSaveBrand').addEventListener('click', saveBrand);
        id('btnPickLogo').addEventListener('click', function () { id('logoFile').click(); });
        id('btnPickFavicon').addEventListener('click', function () { id('faviconFile').click(); });
        id('logoFile').addEventListener('change', function () {
            uploadIcon('logo', 'logoFile', 'siteLogo', 'logoPreview');
        });
        id('faviconFile').addEventListener('change', function () {
            uploadIcon('favicon', 'faviconFile', 'siteFavicon', 'faviconPreview');
        });

        Array.prototype.forEach.call(document.querySelectorAll('input[name="dbDriver"]'), function (radio) {
            radio.addEventListener('click', function () { setTimeout(syncDriverFields, 0); });
        });
        id('btnTestDb').addEventListener('click', testDb);
        id('btnSwitchDb').addEventListener('click', switchDb);

        id('btnSaveVoice').addEventListener('click', saveVoice);
        id('btnSaveSecurity').addEventListener('click', saveSecurity);
    }

    function boot() {
        bind();
        syncDriverFields();
        fillVoices();
        if (window.speechSynthesis) {
            window.speechSynthesis.addEventListener('voiceschanged', fillVoices);
        }
        if (window.layui && layui.form) { layui.form.render(); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else { boot(); }
})();
