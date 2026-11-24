// Actual UI code with a tiny DOM harness: no comments request until reviewer clicks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
    constructor(tag) { this.tagName=tag;this.children=[];this.events={};this.isConnected=true; }
    appendChild(node) { this.children.push(node);return node; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children=nodes; }
    setAttribute(key,value) { this[key]=value; }
    addEventListener(event,callback) { this.events[event]=callback; }
    contains() { return false; }
    blur() {}
}
const requests=[];
const document={createElement:tag=>new Element(tag),getElementById:()=>new Element('div'),
    querySelector:()=>({value:'xsrf-test-token'}),activeElement:null};
const context={document,window:{},URL,setTimeout,clearTimeout,fetch:async(url,options={})=>{
    requests.push({url,options});
    return {ok:true,json:async()=>({ok:true,post_content:'读取的完整正文',post_is_excerpt:false,job:{status:'finished',message:'读取结束',progress:{scanned_comments:1,expected_comments:1}},
        items:{total:1,page_size:20,list:[{id:12,kind:'comment',author:'甲',content:'普通反馈',matched:[],review_status:'pending',metadata:{},url:'https://pd.qq.com/g/CWNUpindao/post/B_one'}]}})};
}};
let source=fs.readFileSync('app/static/js/qq-channel.js','utf8');
source=source.slice(0,source.indexOf("    $('qqForm').addEventListener"))+
    'window.test={renderItem,setRun:function(id){runId=id;}};})();';
vm.createContext(context);vm.runInContext(source,context);
context.window.test.setRun(7);
const card=context.window.test.renderItem({id:11,kind:'post',content:'腾讯搜索摘要',matched:['校园跑'],
    review_status:'pending',metadata:{is_excerpt:true,match_source:'tencent_channel_search',likes:1,comments:8,shares:2},
    heat:11,url:'https://pd.qq.com/g/CWNUpindao/post/B_one'});
assert.equal(requests.length,0,'rendering search results must not read comments');
const audit=card.children.find(node=>node.className==='qq-audit');
assert.equal(audit.hidden,true,'review controls stay collapsed');
const review=card.children.find(node=>node.textContent==='人工审核 · 加载本帖评论');
assert.ok(review);
review.events.click();
setImmediate(()=>{
    assert.equal(audit.hidden,false);
    assert.equal(requests.filter(r=>r.options.method==='POST').length,1);
    assert.ok(requests.every(r=>r.url.startsWith('/api/collect/qq/runs/7/items/11/comments')),
        'only the selected post may be requested');
    assert.equal(requests[0].options.headers['X-Xsrftoken'],'xsrf-test-token');
    const comments=audit.children.find(node=>node.className==='qq-comments');
    assert.ok(comments.children.some(node=>node.textContent==='当前帖评论与回复'));
    assert.ok(comments.children.some(node=>node.textContent==='读取的完整正文'));
    console.log('PASS: native search cards do not preload comments; review reads only the selected thread with XSRF');
});
