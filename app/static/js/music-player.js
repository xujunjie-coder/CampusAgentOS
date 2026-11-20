/* Campus music: one audio element per card, one active player across the page. */
(function () {
    "use strict";
    var active = null;
    var scenes = [ ["全部", ""], ["自习专注", "轻音乐"], ["放松减压", "治愈"], ["运动充电", "摇滚"], ["夜晚氛围", "电子"] ];
    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function time(n) {
        n = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
        return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
    }
    function providerUrl(value, domains) {
        try {
            var u = new URL(value);
            return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && domains.some(function (d) {
                return u.hostname === d || u.hostname.endsWith("." + d);
            }) ? u.href : "";
        } catch (e) { return ""; }
    }
    window.CampusMusic = { mount: function (root, options) {
        var tracks = [], index = -1, mode = "list", request = 0, generation = 0;
        var deadline = 0, interval = null, disposed = false, counted = false;
        root.replaceChildren();
        var top = el("div", "music-top");
        var heading = el("div");
        heading.append(el("span", "music-eyebrow", "CAMPUS · SOUND BREAK"), el("h3", "", "给此刻，留一点旋律"));
        var badge = el("span", "music-local", "正在连接曲库");
        top.append(heading, badge);
        var chips = el("div", "music-scenes");
        var form = el("form", "music-search");
        var input = el("input");
        input.type = "search"; input.maxLength = 50; input.placeholder = "搜索曲名、风格或标签";
        input.setAttribute("aria-label", "搜索音乐");
        var search = el("button", "", "搜索"); search.type = "submit";
        form.append(input, search);
        var sourceLabel = el("label", "music-source", "曲库 ");
        var source = el("select"); source.setAttribute("aria-label", "选择音乐来源");
        [["auto", "Jamendo 优先"], ["jamendo", "Jamendo 在线"], ["local", "本地示例"]].forEach(function (pair) {
            var option = el("option", "", pair[1]); option.value = pair[0]; source.append(option);
        });
        source.value = "auto"; sourceLabel.append(source);
        var hero = el("div", "music-hero");
        var disc = el("div", "music-disc", "♫"); disc.setAttribute("aria-hidden", "true");
        var cover = el("img", "music-cover"); cover.hidden = true; cover.alt = "当前曲目封面"; cover.referrerPolicy = "no-referrer";
        cover.addEventListener("error", function () { cover.hidden = true; disc.hidden = false; });
        var info = el("div", "music-info");
        var title = el("strong", "music-title", "选一首，开始聆听");
        var meta = el("span", "music-meta", "支持列表连播 · 循环 · 专注定时");
        var attribution = el("div", "music-attribution");
        info.append(title, meta, attribution); hero.append(disc, cover, info);
        var audio = el("audio", "music-audio");
        audio.controls = true; audio.preload = "metadata";
        audio.setAttribute("aria-label", "音乐播放、进度与音量控制");
        var controls = el("div", "music-controls");
        function button(label, fn) {
            var b = el("button", "", label); b.type = "button"; b.addEventListener("click", fn); controls.append(b); return b;
        }
        var prev = button("上一首", function () { step(-1); });
        var toggle = button("播放", function () { if (audio.paused) start(); else audio.pause(); });
        var next = button("下一首", function () { step(1); });
        var modes = button("列表循环", function () {
            mode = mode === "list" ? "one" : mode === "one" ? "shuffle" : "list";
            modes.textContent = {list:"列表循环", one:"单曲循环", shuffle:"随机播放"}[mode];
        });
        var timerLabel = el("label", "music-timer", "定时停止 ");
        var timer = el("select"); timer.setAttribute("aria-label", "定时停止音乐");
        [ [0,"关闭"], [15,"15 分钟"], [25,"25 分钟"], [45,"45 分钟"] ].forEach(function (pair) {
            var o = el("option", "", pair[1]); o.value = pair[0]; timer.append(o);
        });
        timerLabel.append(timer); controls.append(timerLabel);
        var status = el("div", "music-status", "正在读取曲库…"); status.setAttribute("role", "status");
        var list = el("div", "music-list"); list.setAttribute("aria-label", "播放列表");
        var note = el("p", "music-note", "正在读取音乐来源…");
        root.append(top, chips, sourceLabel, form, hero, audio, controls, status, list, note);
        [prev,toggle,next,modes,timer].forEach(function (b) { b.disabled = true; });

        function creditLink(label, url) {
            var a = el("a", "", label); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; return a;
        }

        function highlight() {
            Array.prototype.forEach.call(list.children, function (row) {
                var selected = Number(row.dataset.index) === index;
                row.classList.toggle("is-selected", selected);
                row.setAttribute("aria-pressed", String(selected));
                row.querySelector(".music-track-state").textContent = selected ? (audio.paused ? "已选择" : "播放中") : "播放";
            });
            disc.classList.toggle("is-playing", !audio.paused);
            toggle.textContent = audio.paused ? "播放" : "暂停";
        }
        function start() {
            if (disposed || index < 0) return;
            if (active && active.audio !== audio) active.pause();
            active = {audio:audio, pause:function () { audio.pause(); }};
            var token = generation;
            var promise = audio.play();
            if (promise) promise.catch(function (err) {
                if (token !== generation || disposed || err.name === "AbortError") return;
                status.textContent = err.name === "NotAllowedError" ? "已准备好，点击播放开始聆听。" : "暂时无法播放，请重试或切换曲目。";
                highlight();
            });
        }
        function choose(i, autoplay) {
            if (!tracks.length || disposed) return;
            generation++; audio.pause(); index = (i + tracks.length) % tracks.length; counted = false;
            var t = tracks[index];
            title.textContent = t.title; meta.textContent = t.artist + " · " + t.style + " · " + time(t.duration);
            attribution.replaceChildren();
            if (t.source === "jamendo") {
                attribution.append(creditLink("在 Jamendo 查看作品", t.page_url), creditLink("歌曲许可", t.license_url));
            }
            var coverUrl = providerUrl(t.cover, ["jamendo.com"]);
            cover.hidden = !coverUrl; disc.hidden = !!coverUrl;
            if (coverUrl) cover.src = coverUrl; else cover.removeAttribute("src");
            audio.src = t.file; audio.load(); highlight();
            status.textContent = "已选择「" + t.title + "」";
            if (autoplay) start();
        }
        function step(delta) {
            var target = index + delta;
            if (mode === "shuffle" && tracks.length > 1) target = index + 1 + Math.floor(Math.random() * (tracks.length - 1));
            choose(target, true);
        }
        audio.addEventListener("playing", function () {
            if (index < 0 || !tracks[index]) return;
            if (active && active.audio !== audio) active.pause();
            active = {audio:audio, pause:function () { audio.pause(); }};
            highlight(); status.textContent = "正在播放「" + tracks[index].title + "」";
            if (!counted) {
                counted = true;
                // Remote streams are played directly; do not count their IDs in the local database.
                if (tracks[index].source !== "jamendo") fetch("/api/music/play", {method:"POST", headers:{"Content-Type":"application/json", "X-Xsrftoken":options.xsrf}, body:JSON.stringify({id:tracks[index].id,source:"local"})}).catch(function () {});
            }
        });
        audio.addEventListener("pause", highlight);
        audio.addEventListener("ended", function () { if (mode === "one") choose(index, true); else step(1); });
        audio.addEventListener("error", function () { status.textContent = "音频加载失败，请切换曲目或重新搜索。"; highlight(); });
        function clearTimer() { clearInterval(interval); interval = null; deadline = 0; }
        timer.addEventListener("change", function () {
            clearTimer();
            var minutes = Number(timer.value);
            if (!minutes) { status.textContent = "已关闭定时停止。"; return; }
            deadline = Date.now() + minutes * 60000;
            status.textContent = minutes + " 分钟后停止播放。";
            interval = setInterval(function () {
                if (Date.now() >= deadline) {
                    clearTimer(); audio.pause(); timer.value = "0";
                    status.textContent = "专注时间结束，音乐已暂停，休息一下吧。";
                }
            }, 1000);
        });
        async function load(keyword) {
            var ticket = ++request;
            status.textContent = "正在检索曲库…"; search.disabled = true;
            input.value = keyword;
            Array.prototype.forEach.call(chips.children, function (b, i) { b.setAttribute("aria-pressed", String(scenes[i][1] === keyword)); });
            try {
                var resp = await fetch("/api/music/search?limit=20&source=" + encodeURIComponent(source.value) + "&q=" + encodeURIComponent(keyword));
                var data = await resp.json();
                if (disposed || ticket !== request) return;
                if (!resp.ok || !data.ok) throw new Error(data.error || "曲库暂时不可用，请重新搜索。");
                generation++; audio.pause(); audio.removeAttribute("src"); audio.load(); index = -1;
                tracks = (data.list || []).filter(function (t) {
                    if (t.source !== "jamendo") return /^\/static\/music\/[\w.-]+$/.test(t.file);
                    return providerUrl(t.file, ["jamendo.com"]) && providerUrl(t.page_url, ["jamendo.com"]) && providerUrl(t.license_url, ["creativecommons.org"]);
                });
                var online = data.source === "jamendo";
                badge.textContent = online ? "Jamendo 在线曲库" : "本地示例曲库";
                note.textContent = online ? "音乐由 Jamendo 提供，创作归各音乐人所有；各曲目许可见作品链接。这里以在线播放方式提供独立音乐。" : "当前为 6 段本地合成短片段，用于体验播放功能。";
                list.replaceChildren();
                tracks.forEach(function (t, i) {
                    var row = el("button", "music-track"); row.type = "button"; row.dataset.index = i;
                    row.append(el("span", "music-track-number", String(i + 1).padStart(2,"0")));
                    var detail = el("span", "music-track-detail");
                    detail.append(el("b", "", t.title), el("small", "", t.artist + " · " + t.tags));
                    row.append(detail, el("span", "music-duration", time(t.duration)), el("span", "music-track-state", "播放"));
                    row.addEventListener("click", function () { choose(i, true); }); list.append(row);
                });
                [prev,toggle,next,modes,timer].forEach(function (b) { b.disabled = !tracks.length; });
                if (tracks.length) { choose(0, false); status.textContent = (data.message ? data.message + " " : "") + "找到 " + tracks.length + " 首 · 点击播放，开启片刻休息"; }
                else {
                    title.textContent = "暂时没有匹配的曲目"; meta.textContent = "试试轻音乐、钢琴、电子，或选择上方场景";
                    attribution.replaceChildren(); cover.hidden = true; disc.hidden = false;
                    status.textContent = (data.message ? data.message + " " : "") + "没有找到「" + keyword + "」，可点击“全部”浏览曲库。"; highlight();
                }
            } catch (e) {
                if (!disposed && ticket === request) status.textContent = e.message + (tracks.length ? " 当前列表仍可使用。" : " 可切换本地示例曲库。");
            } finally { if (!disposed && ticket === request) search.disabled = false; }
        }
        scenes.forEach(function (s) {
            var b = el("button", "", s[0]); b.type = "button";
            b.addEventListener("click", function () { load(s[1]); }); chips.append(b);
        });
        form.addEventListener("submit", function (e) { e.preventDefault(); load(input.value.trim()); });
        source.addEventListener("change", function () { load(input.value.trim()); });
        // Conversation changes remove cards: stop audio and release timers immediately.
        var observer = new MutationObserver(function () {
            if (root.isConnected) return;
            disposed = true; request++; generation++; clearTimer(); audio.pause();
            audio.removeAttribute("src"); audio.load();
            if (active && active.audio === audio) active = null;
            observer.disconnect();
        });
        observer.observe(document.getElementById("chatMessages") || root.parentNode.parentNode.parentNode, {childList:true, subtree:true});
        load(options.keyword || "");
    }};
})();
