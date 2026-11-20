// Run with node tests/test_collect_cards.cjs. No network or DOM packages.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.classList={toggle(){}};this.events={};}
    set innerHTML(v){this.html=v;this.children=[];}
    get innerHTML(){return this.html;}
    appendChild(el){this.children.push(el);}
    setAttribute(k,v){this[k]=v;}
    querySelector(){if(!this.html?.includes('<img '))return null;return this.image ||= {addEventListener:(event,fn)=>{this.events[event]=fn;}};}
}
const elements={showcase:new Element('div'),emptyTip:new Element('div')};
const context={window:{},URL,document:{getElementById:id=>elements[id],createElement:tag=>new Element(tag)}};
let source=fs.readFileSync(path.join(__dirname,'../app/static/js/collect.js'),'utf8');
source=source.slice(0,source.indexOf('    /* ---------- 事件绑定与初始化 ---------- */'))+'    window.test={renderShowcase};\n})();';
vm.createContext(context);vm.runInContext(source,context);
context.window.test.renderShowcase([
    {title:'有图标题',url:'https://example.com/正文',cover:'https://example.com/cover.png',source_name:'测试'},
    {title:'无图标题',url:'https://example.com/two',cover:''},
    {title:'不安全链接',url:'javascript:alert(1)',cover:'javascript:alert(2)'}
]);
const cards=elements.showcase.children;
assert.equal(cards[0].tagName,'a');assert.equal(cards[0].target,'_blank');assert.equal(cards[0].rel,'noopener noreferrer');
assert.match(cards[0].href,/^https:\/\/example.com\//);assert.match(cards[0].html,/<img /);assert.doesNotMatch(cards[0].html,/<a /,'whole-card anchor must not contain nested links');
assert.equal(cards[1].tagName,'a');assert.match(cards[1].html,/暂无配图/);
assert.equal(cards[2].tagName,'article');assert.equal(cards[2].href,undefined);assert.doesNotMatch(cards[2].html,/javascript:/);
let thumbnail;
cards[0].image.parentNode={classList:{toggle:(name,on)=>{thumbnail=on;}}};
cards[0].image.naturalWidth=128;cards[0].image.naturalHeight=128;cards[0].events.load();assert.equal(thumbnail,true);
cards[0].image.naturalWidth=1200;cards[0].image.naturalHeight=400;cards[0].events.load();assert.equal(thumbnail,false);
cards[0].events.error();assert.match(cards[0].image.outerHTML,/图片暂时无法加载/);
console.log('PASS: whole-card links, safe URLs, absent/failed image states, no nested anchors');
