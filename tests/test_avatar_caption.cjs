// Run with: node tests/test_avatar_caption.cjs (no packages or live server).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Element {
    constructor() { this.children = []; this.className = ''; this.textContent = ''; this.innerHTML = ''; }
    replaceChildren() { this.children = []; }
    appendChild(child) { child.parentNode = this; this.children.push(child); }
    insertBefore(child, before) { child.parentNode = this; this.children.splice(this.children.indexOf(before), 0, child); }
    remove() { this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
    setAttribute(name,value) { (this.attributes ||= {})[name] = value; }
    querySelector(selector) { return this.children.find(c=>selector==='[aria-selected="true"]' ? c.attributes?.['aria-selected']==='true' : selector==='[role="option"]' ? c.attributes?.role==='option' : false) || null; }
    addEventListener(name, fn) { (this.listeners ||= {})[name] = fn; }
    focus() {}
}
const ids = Object.fromEntries(['captionBody', 'avatarAssistant', 'avatarSend', 'avatarInput', 'avatarAgentSelect', 'avatarAgentTrigger', 'avatarAgentCurrent', 'avatarAgentMenu', 'avatarAgentPicker'].map(id => [id, new Element()]));
let chunks = [];
const sandbox = {
    document: {readyState: 'loading', cookie: '', getElementById: id => ids[id], createElement: () => new Element(), querySelector: () => null, addEventListener() {}},
    window: {}, localStorage: { getItem: () => '0' }, TextDecoder, setTimeout,
    fetch: async () => ({ok: true, status: 200, body: {getReader: () => ({read: async () => chunks.length ? {done: false, value: new TextEncoder().encode(chunks.shift())} : {done: true}})}})
};
let source = fs.readFileSync(path.join(__dirname, '../app/static/js/avatar.js'), 'utf8');
source = source.replace('    if (document.readyState === "loading") {', '    window.testAvatar = {sendMessage, handleFrame, renderMarkdown, bindCaptionScroll, loadAgents, selectAgent, openAgentMenu, closeAgentMenu};\n    if (document.readyState === "loading") {');
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const api = sandbox.window.testAvatar;
const frame = (event, data) => api.handleFrame({event, data});
const rows = () => ids.captionBody.children;
const type = name => rows().filter(r => r.className.includes(name));
const drawers = () => type('avatar-process');
const latestDrawer = () => drawers().at(-1);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
(async () => {
    frame('reasoning', '先检查资料');
    const firstProcess = latestDrawer();
    assert.equal(firstProcess.open, true);
    frame('tool', {name: 'search', arguments: {query: '奖学金'}});
    assert.equal(drawers().length, 1);
    assert.match(firstProcess.children[0].textContent, /1 次工具调用/);
    assert.match(firstProcess.children[1].children[1].children[1].textContent, /奖学金/);
    frame('delta', '答复');
    assert.equal(firstProcess.open, false);
    firstProcess.open = true;
    frame('delta', '继续');
    frame('done', {});
    assert.equal(firstProcess.open, true, 'manual reopen must survive further deltas and done');
    assert.equal(firstProcess.children[1].children[0].children[1].textContent, '先检查资料');
    ids.captionBody.children = [];
    chunks = ['event: assistant\ndata: {"name":"华小竹"}\n\nevent: reasoning\ndata: {"text":"分析中"}\n\nevent: delta\ndata: "## 答案\\n\\n**你好**"\n\nevent: done\ndata: {}'];
    api.sendMessage('问题一');
    await settle();
    assert.equal(type('is-user').length, 1);
    assert.equal(type('is-user')[0].children[1].textContent, '问题一');
    assert.equal(type('is-assistant').length, 1);
    assert.match(type('is-assistant')[0].children[1].innerHTML, /<h3>答案<\/h3>/);
    assert.match(type('is-assistant')[0].children[1].innerHTML, /<strong>你好<\/strong>/);
    assert.equal(type('is-reasoning').length, 0);
    assert.equal(ids.avatarSend.disabled, false);
    assert.equal(latestDrawer().open, false);
    assert.equal(latestDrawer().children[1].children[0].children[1].textContent, '分析中');
    const previousDrawer = latestDrawer();
    chunks = ['event: delta\ndata: "第二轮回答"\n\nevent: done\ndata: {}\n\n'];
    api.sendMessage('问题二');
    await settle();
    assert.equal(type('is-user').length, 2);
    assert.equal(type('is-assistant').length, 2);
    assert.equal(type('is-user')[1].children[1].textContent, '问题二');
    assert.doesNotMatch(type('is-assistant')[1].children[1].innerHTML, /你好/);
    frame('reasoning', {text: '第一步'});
    assert.notEqual(latestDrawer(), previousDrawer, 'each turn keeps a separate process drawer');
    assert.equal(previousDrawer.children[1].children[0].children[1].textContent, '分析中');
    frame('reasoning', {text: '第二步'});
    const retainedProcess = latestDrawer();
    assert.equal(retainedProcess.children[1].children.length, 1);
    assert.equal(retainedProcess.children[1].children[0].children[1].textContent, '第一步第二步');
    frame('delta', '完成');
    assert.equal(type('is-reasoning').length, 0);
    for (const terminal of ['done', 'error']) {
        frame('reasoning', '思考'); frame(terminal, {message:'失败'});
        assert.equal(type('is-reasoning').length, 0);
    }
    chunks = ['event: reasoning\ndata: "断流测试"\n\n'];
    api.sendMessage('问题三');
    await settle();
    assert.equal(type('is-reasoning').length, 0);
    assert.equal(latestDrawer().open, false, 'stream end collapses the process');
    const html = api.renderMarkdown('# 标题\n\n- 项目\n\n1. 步骤\n\n> 引用\n\n|甲|乙|\n|---|---|\n|一|二|\n\n```python\nprint("<test>")\n```\n\n`code` [链接](https://example.com) <script>alert(1)</script> [危险](javascript:alert(1))');
    for (const tag of ['h2','ul','ol','blockquote','table','pre','code','a']) assert.match(html, new RegExp('<'+tag+'[ >]'));
    assert.doesNotMatch(html, /<script>|href="javascript:/);
    assert.match(html, /&lt;script&gt;/);
    const body = ids.captionBody;
    api.bindCaptionScroll();
    body.scrollHeight = 1600; body.clientHeight = 400; body.scrollTop = 1200;
    body.listeners.scroll();
    body.scrollHeight = 1700;
    frame('delta', '跟随新内容');
    assert.equal(body.scrollTop, 1700);
    body.scrollTop = 300;
    body.listeners.scroll();
    body.scrollHeight = 1900;
    frame('delta', '用户在阅读历史');
    assert.equal(body.scrollTop, 300);
    frame('reasoning', '思考更新');
    frame('notice', '通知更新');
    assert.equal(body.scrollTop, 300);
    body.scrollTop = 1500;
    body.listeners.scroll();
    body.scrollHeight = 2000;
    frame('delta', '回到底部后继续跟随');
    assert.equal(body.scrollTop, 2000);
    frame('done', {});
    const chatFetch = sandbox.fetch;
    const agentA = {id: 11, name: '学业助理', description: '学业指导'};
    const agentB = {id: 12, name: '就业助理', description: '就业指导'};
    let failSelection = false, sentEmployee = null;
    sandbox.fetch = async (url, options) => {
        if (url === '/api/assistants') return {ok:true, json:async()=>({ok:true,list:[agentA,agentB],selected:agentA})};
        if (url === '/api/assistants/select') {
            assert.equal(JSON.parse(options.body).employee_id,12);
            return {ok:!failSelection,json:async()=>failSelection ? {detail:'已停用'} : {ok:true,selected:agentB}};
        }
        sentEmployee = JSON.parse(options.body).employee_id;
        return chatFetch(url,options);
    };
    await api.loadAgents();
    assert.equal(ids.avatarAgentSelect.children.length,2);
    assert.equal(ids.avatarAgentSelect.value,'11');
    assert.equal(ids.avatarAgentMenu.children.length,2);
    assert.equal(ids.avatarAgentCurrent.textContent,'学业助理');
    api.openAgentMenu(false);
    assert.equal(ids.avatarAgentMenu.hidden,false);
    assert.equal(ids.avatarAgentTrigger.attributes['aria-expanded'],'true');
    api.closeAgentMenu();
    assert.equal(ids.avatarAssistant.textContent,'学业助理 · 数字人');
    failSelection = true;
    await api.selectAgent(12);
    assert.equal(ids.avatarAgentSelect.value,'11','failed selection must retain previous agent');
    failSelection = false;
    await api.selectAgent(12);
    assert.equal(ids.avatarAgentSelect.value,'12');
    chunks = ['event: assistant\ndata: {"id":12,"name":"就业助理"}\n\nevent: delta\ndata: "就业回答"\n\nevent: done\ndata: {}\n\n'];
    api.sendMessage('就业问题');
    assert.equal(ids.avatarAgentSelect.disabled,true);
    assert.equal(ids.avatarAgentTrigger.disabled,true);
    assert.equal(ids.avatarAgentMenu.hidden,true);
    await settle();
    assert.equal(sentEmployee,12);
    api.openAgentMenu(false);
    ids.avatarAgentMenu.children[1].listeners.click();
    assert.equal(ids.avatarAgentMenu.hidden,true);
    assert.equal(ids.avatarAgentMenu.children[1].attributes['aria-selected'],'true');
    assert.equal(ids.avatarAgentSelect.disabled,false);
    assert.equal(type('is-assistant').at(-1).children[0].textContent,'就业助理');
    console.log('PASS: process drawers, Markdown, scroll follow, Agent loading/selection/rollback and chat identity');
})().catch(err => { console.error(err); process.exitCode = 1; });
