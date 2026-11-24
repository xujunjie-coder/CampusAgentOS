(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    if (!$('qqForm')) return;
    var runId = null, page = 1, timer = null, loading = false, generation = 0;
    var openReview = null, commentTimer = null, connectionTimer = null;
    var states = {queued:'等待启动', running:'采集中', cancelling:'正在停止', stopped:'已停止',
        finished:'检索结束', failed:'检索失败', interrupted:'服务重启中断'};
    var reviews = {pending:'待审核', feedback:'普通反馈 / 无需处理', concern:'需要核实'};
    function el(tag, text, cls) {
        var node = document.createElement(tag);
        if (text != null) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function api(url, body) {
        var opt = {headers:{}};
        if (body) {
            var token = document.querySelector('#adminLogoutForm input[name="_xsrf"]');
            opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json';
            opt.headers['X-Xsrftoken'] = token ? token.value : '';
            opt.body = JSON.stringify(body);
        }
        return fetch(url, opt).then(function (r) { return r.json().then(function (d) {
            if (!r.ok || !d.ok) throw new Error(d.error || '请求失败'); return d;
        }); });
    }
    function error(e) { $('qqProgress').textContent = e.message; }
    function busy(on) { $('qqRunBtn').disabled = on; $('qqStopBtn').disabled = !on; $('qqStopBtn').hidden = !on; }
    function loadHistory(selectLatest) {
        return api('/api/collect/qq/runs').then(function (data) {
            var old = runId;
            $('qqHistory').replaceChildren();
            data.list.forEach(function (r) {
                var option = el('option', '#' + r.id + ' · ' + r.channel + ' · ' + r.options.keywords.join('、') + ' · ' + (states[r.status] || r.status));
                option.value = r.id; $('qqHistory').appendChild(option);
            });
            if (!data.list.length) { $('qqHistory').appendChild(el('option', '暂无任务')); return; }
            runId = selectLatest || !old ? data.list[0].id : old;
            $('qqHistory').value = String(runId);
            return loadRun();
        });
    }
    function safeLink(url) {
        try { var u = new URL(url); return u.protocol === 'https:' && u.host === 'pd.qq.com' ? u.href : ''; }
        catch (e) { return ''; }
    }
    function closeReview() {
        clearTimeout(commentTimer); openReview=null;
        var dialog=$('qqReviewDialog');
        if (dialog && dialog.open && dialog.close) dialog.close();
    }
    function showReview(item,audit) {
        var dialog=$('qqReviewDialog'),content=$('qqReviewContent');
        if (!dialog || !content) return;
        content.replaceChildren();
        content.appendChild(el('p',(item.author || '频道帖子')+' · '+(item.published_at || '时间未知'),'qq-match'));
        content.appendChild(el('p',item.content,'qq-original'));
        content.appendChild(audit);
        if (!dialog.open && dialog.showModal) dialog.showModal();
    }
    function renderItem(item, inComments) {
        var card = el('article', null, 'qq-result');
        var header = el('div', null, 'qq-result-header');
        if (item.kind !== 'post') header.appendChild(el('strong', ({comment:'评论',reply:'回复'})[item.kind] || '内容'));
        header.appendChild(el('span', item.author ? item.author + ' · ' + (item.published_at || '时间未知') : (item.published_at || '时间未知')));
        var link = el('a', '查看原帖');
        link.href = safeLink(item.url); link.target = '_blank'; link.rel = 'noopener noreferrer';
        header.appendChild(link); card.appendChild(header);
        card.appendChild(el('span', item.matched.join('、'), 'qq-source-tag'));
        if (item.kind === 'post' && item.metadata && item.metadata.match_source) {
            var metrics=el('div',null,'qq-metrics');
            [['fire','热度',item.heat],['thumbs-up','赞',item.metadata.likes],['comment','评论',item.metadata.comments],['share','转发',item.metadata.shares]].forEach(function(m){
                var metric=el('span'); metric.title=m[1]; metric.setAttribute('aria-label',m[1]+' '+m[2]);
                var icon=el('i',null,'fas fa-'+m[0]); icon.setAttribute('aria-hidden','true'); metric.appendChild(icon); metric.appendChild(el('span',String(m[2]))); metrics.appendChild(metric);
            });
            card.appendChild(metrics);
        }
        card.appendChild(el('p', item.content, 'qq-original'));
        if (item.context) {
            var details = el('details'); details.appendChild(el('summary', '查看原帖及父评论上下文'));
            details.appendChild(el('p', item.context, 'qq-original')); card.appendChild(details);
        }
        var audit = el('div',null,'qq-audit');
        if (item.kind === 'post' && !inComments) {
            var review = el('button','审核帖子 →','pager-btn'); review.type = 'button'; review.title='查看全文、评论并审核';
            audit.hidden = true;
            review.addEventListener('click',function () {
                clearTimeout(commentTimer);
                openReview = {runId:runId,itemId:item.id,page:1};
                audit.hidden = false; review.disabled = true;
                showReview(item,audit);
                commentArea.textContent = '正在请求读取当前帖评论…';
                api('/api/collect/qq/runs/' + runId + '/items/' + item.id + '/comments',{}).then(function () {
                    return loadComments(commentArea,item.id);
                }).catch(function (e) { commentArea.textContent = e.message; }).finally(function () { review.disabled = false; });
            });
            card.appendChild(review);
        }
        var ai = el('div', null, 'qq-ai');
        var finding = item.analysis || {};
        if (finding.category) {
            var labels = {feedback:'普通反馈',verify:'事实指控待核实',safety:'疑似安全或行为问题',uncertain:'无法判断',error:'未能完成初筛'};
            ai.appendChild(el('p', 'AI 初筛（供参考）：' + (labels[finding.category] || finding.category) + ' · ' + finding.reason));
            if (finding.evidence) ai.appendChild(el('p', '原文依据：' + finding.evidence));
        }
        var analyze = el('button', 'AI 辅助初筛', 'pager-btn'); analyze.type = 'button';
        analyze.addEventListener('click', function () {
            var selectedRun = runId;
            analyze.disabled = true; analyze.textContent = '正在分析…';
            api('/api/collect/qq/runs/' + selectedRun + '/items/' + item.id + '/analyze', {}).then(function () {
                analyze.blur();
                if (runId === selectedRun) return loadRun();
            }).catch(error).finally(function () { analyze.disabled = false; analyze.textContent = 'AI 辅助初筛'; });
        });
        ai.appendChild(analyze); audit.appendChild(ai);
        var row = el('div', null, 'qq-review-row');
        var select = el('select'); select.setAttribute('aria-label', '人工审核结果');
        Object.keys(reviews).forEach(function (k) { var opt = el('option', reviews[k]); opt.value = k; select.appendChild(opt); });
        select.value = item.review_status;
        var reason = el('input'); reason.placeholder = '人工核实说明（标记需要核实时必填）';
        reason.maxLength = 1000; reason.value = item.reason || ''; reason.setAttribute('aria-label', '人工核实说明');
        var button = el('button', '保存审核', 'pager-btn'); button.type = 'button';
        button.addEventListener('click', function () {
            var selectedRun = runId;
            button.disabled = true;
            api('/api/collect/qq/runs/' + selectedRun + '/items/' + item.id + '/review',
                {status:select.value, reason:reason.value}).then(function () {
                button.blur();
                if (runId === selectedRun) return loadRun();
            }).catch(error).finally(function () { button.disabled = false; });
        });
        row.append(select, reason, button); audit.appendChild(row);
        if (item.kind === 'post' && !inComments) {
            var commentArea = el('div',null,'qq-comments'); audit.appendChild(commentArea);
            if (openReview && openReview.runId === runId && openReview.itemId === item.id) {
                audit.hidden = false;
                showReview(item,audit);
                loadComments(commentArea,item.id).catch(function (e) { commentArea.textContent = e.message; });
            }
        }
        if (!audit.parentNode) card.appendChild(audit);
        if (item.reviewer) card.appendChild(el('small', '审核人：' + item.reviewer + ' · ' + item.reviewed_at));
        return card;
    }
    function loadComments(area,itemId) {
        clearTimeout(commentTimer);
        if (!openReview || openReview.runId !== runId || openReview.itemId !== itemId) return Promise.resolve();
        var selectedRun = runId, selectedPage = openReview.page;
        return api('/api/collect/qq/runs/' + selectedRun + '/items/' + itemId + '/comments?page=' + selectedPage).then(function (data) {
            if (!openReview || runId !== selectedRun || openReview.itemId !== itemId || !area.isConnected) return;
            if (!area.contains(document.activeElement)) {
                area.replaceChildren();
                var job=data.job, p=job && job.progress || {};
                if (data.post_content && data.post_is_excerpt === false) {
                    area.appendChild(el('h4','当前帖完整正文'));
                    area.appendChild(el('p',data.post_content,'qq-original'));
                }
                area.appendChild(el('h4','当前帖评论与回复'));
                area.appendChild(el('p',job ? (states[job.status] || job.status) + ' · ' + job.message : '尚未读取'));
                area.appendChild(el('p','已读取 ' + (p.scanned_comments || 0) + ' 条；腾讯显示总数：' + (p.expected_comments == null ? '未知' : p.expected_comments)));
                (p.warnings || []).forEach(function (w) { area.appendChild(el('p',w,'panel-tip')); });
                data.items.list.forEach(function (row) { area.appendChild(renderItem(row,true)); });
                if (!data.items.list.length) area.appendChild(el('p','当前尚无已读取评论。'));
                var pager=el('div',null,'qq-pagination'), pages=Math.max(1,Math.ceil(data.items.total/data.items.page_size));
                var previous=el('button','上一页','pager-btn'), next=el('button','下一页','pager-btn');
                previous.type=next.type='button'; previous.disabled=selectedPage<=1; next.disabled=selectedPage>=pages;
                previous.addEventListener('click',function(){openReview.page--;loadComments(area,itemId).catch(error);});
                next.addEventListener('click',function(){openReview.page++;loadComments(area,itemId).catch(error);});
                pager.append(previous,el('span',selectedPage+'/'+pages+' 页'),next); area.appendChild(pager);
                if (job && ['failed','interrupted'].indexOf(job.status)!==-1) {
                    var retry=el('button','重试读取本帖评论','pager-btn'); retry.type='button';
                    retry.addEventListener('click',function(){api('/api/collect/qq/runs/'+selectedRun+'/items/'+itemId+'/comments',{}).then(function(){return loadComments(area,itemId);}).catch(error);});
                    area.appendChild(retry);
                }
            }
            if (data.job && ['queued','running'].indexOf(data.job.status)!==-1) {
                commentTimer=setTimeout(function(){loadComments(area,itemId).catch(error);},2500);
            }
        });
    }
    function loadConnection() {
        clearTimeout(connectionTimer);
        return api('/api/collect/qq/connection').then(function(data){
            var status=data.connection.status;
            $('qqConnectionStatus').textContent=({connected:'已连接',connecting:'等待登录',unknown:'待连接',error:'连接失败'})[status] || '待连接';
            $('qqConnectionStatus').title=data.connection.message;
            $('qqConnectionStatus').dataset.state=status;
            $('qqConnectBtn').textContent=status==='connected'?'重新连接':'连接 QQ';
            $('qqConnectBtn').disabled=data.connection.status==='connecting';
            if(data.connection.status==='connecting') connectionTimer=setTimeout(function(){loadConnection().catch(error);},2500);
        });
    }
    function renderPager(pages, total) {
        var pager=$('qqPager'); pager.replaceChildren();
        if (!total) return;
        function button(label,target,disabled,active,accessibleLabel) {
            var node=el('button',label,'pager-btn'+(active?' active':'')); node.type='button'; node.disabled=disabled;
            node.setAttribute('aria-label',accessibleLabel || '第 '+target+' 页');
            if(active) node.setAttribute('aria-current','page');
            if(!disabled && !active) node.addEventListener('click',function(){closeReview();page=target;loadRun().catch(error);});
            pager.appendChild(node);
        }
        button('‹',page-1,page<=1,false,'上一页');
        var last=0;
        for(var p=1;p<=pages;p++) {
            if(p!==1 && p!==pages && Math.abs(p-page)>1) continue;
            if(p-last>1) pager.appendChild(el('span','…','pager-ellipsis'));
            button(String(p),p,false,p===page); last=p;
        }
        button('›',page+1,page>=pages,false,'下一页');
    }
    function loadRun(force) {
        clearTimeout(timer);
        if (!runId) return Promise.resolve();
        var requestGeneration = ++generation;
        return api('/api/collect/qq/runs/' + runId + '?page=' + page + '&review_status=' + encodeURIComponent($('qqReviewFilter').value)).then(function (data) {
            if (requestGeneration !== generation) return;
            var r = data.run, p = r.progress || {};
            page=data.items.page;
            var active = ['queued','running','cancelling'].indexOf(r.status) !== -1;
            busy(active); $('qqStopBtn').disabled = !active || r.status === 'cancelling';
            $('qqProgress').textContent = (states[r.status] || r.status);
            $('qqProgress').title=r.message;
            if (r.status==='failed' || r.status==='interrupted') $('qqProgress').textContent+=' · '+r.message;
            var coverage = $('qqCoverage'); coverage.replaceChildren();
            var stats=el('div',null,'qq-stats');
            [['发现',p.discovered_posts || 0],['已读取',p.scanned_posts || 0],['结果',p.matched || 0]].forEach(function(s){var stat=el('span');stat.appendChild(el('strong',String(s[1])));stat.appendChild(el('span',s[0]));stats.appendChild(stat);});
            coverage.appendChild(stats);
            var scope=el('details',null,'qq-scope');scope.appendChild(el('summary','采集范围 · 热度排序'));
            scope.appendChild(el('p',p.scope || '公开网页可见范围，未证明覆盖全部历史'));
            if(p.sort) scope.appendChild(el('p',p.sort));
            (p.warnings || []).forEach(function(t){scope.appendChild(el('p',t));});coverage.appendChild(scope);
            // Do not replace an actively edited review while a background run is polling.
            if (force === true || (!$('qqResults').contains(document.activeElement) && !$('qqReviewDialog').contains(document.activeElement))) {
                $('qqResults').replaceChildren();
                data.items.list.forEach(function (it) { $('qqResults').appendChild(renderItem(it)); });
                if (!data.items.list.length) $('qqResults').appendChild(el('p', active ? '正在腾讯频道内检索相关帖子，不读取评论。' : r.status === 'failed' ? '检索未成功，请查看上方原因；这不表示没有相关帖子。' : '腾讯当前返回范围内暂无相关帖子；不代表全部历史没有相关内容。'));
            }
            var pages = Math.max(1, Math.ceil(data.items.total / data.items.page_size));
            renderPager(pages, data.items.total);
            if (active) timer = setTimeout(function () { loadRun().catch(error); }, 3000);
        });
    }
    $('qqForm').addEventListener('submit', function (event) {
        event.preventDefault(); if (loading) return;
        closeReview();
        loading = true; busy(true);
        api('/api/collect/qq/runs', {channel:$('qqChannel').value.trim(), keywords:$('qqKeywords').value.trim(),
            start_date:$('qqStartDate').value, end_date:$('qqEndDate').value,
            max_posts:Number($('qqMaxPosts').value), max_comments:80,
            max_scrolls:Number($('qqMaxScrolls').value)}).then(function (data) {
                runId = data.run.id; page = 1; return loadHistory(false);
            }).catch(function (e) { error(e); busy(false); }).finally(function () { loading = false; });
    });
    $('qqStopBtn').addEventListener('click', function () {
        if (runId) api('/api/collect/qq/runs/' + runId, {action:'stop'}).then(loadRun).catch(error);
    });
    $('qqHistory').addEventListener('change', function () { closeReview();runId = Number(this.value); page = 1; loadRun().catch(error); });
    $('qqReviewFilter').addEventListener('change', function () { closeReview();page = 1; loadRun().catch(error); });
    $('qqRefreshBtn').addEventListener('click', function () { loadHistory(false).catch(error); });
    $('qqReviewClose').addEventListener('click',closeReview);
    $('qqReviewDialog').addEventListener('close',function(){clearTimeout(commentTimer);openReview=null;});
    $('qqConnectBtn').addEventListener('click',function(){
        $('qqConnectBtn').disabled=true;
        api('/api/collect/qq/connection',{channel:$('qqChannel').value.trim()}).then(loadConnection).catch(function(e){$('qqConnectionStatus').textContent=e.message;$('qqConnectBtn').disabled=false;});
    });
    window.addEventListener('pagehide', function () { clearTimeout(timer);clearTimeout(commentTimer);clearTimeout(connectionTimer); });
    loadConnection().catch(error);
    loadHistory(true).catch(error);
})();
