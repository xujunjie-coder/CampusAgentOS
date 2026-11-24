// Actual UI code with a tiny DOM harness: no comments request until reviewer clicks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
    constructor(tag) { this.tagName=tag;this.children=[];this.events={};this.isConnected=true;this.dataset={}; }
    appendChild(node) {
        if(node.parentNode) node.parentNode.children=node.parentNode.children.filter(child=>child!==node);
        this.children.push(node);node.parentNode=this;return node;
    }
    append(...nodes) { nodes.forEach(node=>this.appendChild(node)); }
    replaceChildren(...nodes) { this.children.forEach(node=>node.parentNode=null);this.children=[];this.append(...nodes); }
    setAttribute(key,value) { this[key]=value; }
    addEventListener(event,callback) { this.events[event]=callback; }
    contains() { return false; }
    blur() {}
    querySelector(selector) { return walk(this).find(node=>(node.className||'').split(' ').includes(selector.slice(1))) || null; }
    showModal() { this.open=true; }
}
function walk(node) { return node.children.flatMap(child=>[child,...walk(child)]); }
const requests=[];
const elements=new Map();
const document={createElement:tag=>new Element(tag),getElementById:id=>{
    if(!elements.has(id)) elements.set(id,new Element('div'));return elements.get(id);
},
    querySelector:()=>({value:'xsrf-test-token'}),activeElement:null};
const context={document,window:{},URL,setTimeout,clearTimeout,fetch:async(url,options={})=>{
    requests.push({url,options});
    return {ok:true,json:async()=>({ok:true,post_content:'读取的完整正文',post_is_excerpt:false,
        post_images:['https://example.com/post.jpg','javascript:alert(1)','https://example.com/post.jpg'],
        job:{status:'finished',message:'读取结束',progress:{scanned_comments:1,expected_comments:1}},
        items:{total:4,page_size:300,list:[
            {id:12,external_id:'c_one',kind:'comment',author:'甲',content:'普通反馈',metadata:{}},
            {id:13,external_id:'r_one',kind:'reply',parent_id:'c_one',author:'乙',content:'第一条回复',context:'不应重复的父帖子'},
            {id:14,external_id:'r_two',kind:'reply',parent_id:'c_one',author:'丙',content:'第二条回复'},
            {id:15,external_id:'r_orphan',kind:'reply',parent_id:'c_missing',author:'丁',content:'保留未读取父评论的回复'}
        ]}})};
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
const review=card.children.find(node=>node.textContent==='查看帖子与评论 →');
assert.ok(review);
review.events.click();
setImmediate(()=>{
    assert.equal(audit.hidden,false);
    assert.equal(requests.filter(r=>r.options.method==='POST').length,1);
    assert.ok(requests.every(r=>r.url.startsWith('/api/collect/qq/runs/7/items/11/comments')),
        'only the selected post may be requested');
    assert.equal(requests[0].options.headers['X-Xsrftoken'],'xsrf-test-token');
    const content=elements.get('qqReviewContent'), all=walk(content);
    const comments=all.find(node=>node.className==='qq-comments');
    assert.equal(all.filter(node=>node.textContent==='读取的完整正文').length,1,'full post body is displayed once');
    assert.ok(!all.some(node=>node.textContent==='腾讯搜索摘要'),'full text replaces the excerpt');
    assert.ok(!walk(comments).some(node=>['select','input'].includes(node.tagName)),'comments have no review forms');
    assert.ok(!walk(comments).some(node=>node.textContent==='不应重复的父帖子'),'comments omit repeated context');
    assert.equal(all.filter(node=>node.className==='qq-review-row').length,1,'one review form for the entire post');
    const gallery=all.find(node=>node.className==='qq-post-gallery');
    assert.equal(gallery.children.length,1,'deduplicate original images and reject unsafe URL schemes');
    const image=gallery.children[0].children[0];
    assert.equal(image.tagName,'img');
    assert.equal(image.src,'https://example.com/post.jpg');
    assert.equal(gallery.children[0].href,image.src,'image opens its original source');
    image.events.error();
    assert.ok(gallery.children[0].children[0].textContent.includes('图片加载失败'),'failed images have a usable original link');
    const list=comments.querySelector('.qq-reader-list');
    assert.equal(list.children.length,2,'a parent thread and an unmatched reply remain visible');
    assert.ok(walk(list.children[0]).some(node=>node.textContent==='第一条回复'),'reply is nested under its comment');
    const more=walk(list.children[0]).find(node=>node.className==='qq-reader-more');
    assert.ok(walk(more).some(node=>node.textContent==='第二条回复'),'additional replies are expandable');
    console.log('PASS: selected-thread requests, single full post, nested replies, and post-only review controls');
});
