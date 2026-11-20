// Run: node tests/test_music_player.cjs — no packages or network.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
class Element {
    constructor(tag) {
        this.tag = tag; this.children = []; this.events = {}; this.dataset = {};
        this.attrs = {}; this.paused = true; this.isConnected = true;
        this.classList = {toggle(){}};
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(k,v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(k,fn) { (this.events[k] ||= []).push(fn); }
    fire(k) { (this.events[k] || []).forEach(fn => fn({preventDefault(){}})); }
    querySelector(selector) { return find(this, n => n.className === selector.slice(1)); }
    pause() { this.paused = true; this.fire('pause'); }
    play() { this.paused = false; this.fire('playing'); return Promise.resolve(); }
    load() {}
}
function find(node,predicate) {
    if (predicate(node)) return node;
    for (const child of node.children) { const match = find(child,predicate); if (match) return match; }
}
const tracks = [1,2,3].map(id => ({id,title:'曲目'+id,artist:'Studio',style:'轻音乐',tags:'钢琴',file:'/static/music/'+id+'.wav',duration:12}));
let posts = [], observers = [], intervals = [], now = 1000, online = false;
const remote = {id:'99',source:'jamendo',title:'Online Song',artist:'Real Artist',style:'Jamendo',tags:'Piano',duration:180,
    file:'https://prod-1.storage.jamendo.com/?trackid=99',cover:'https://usercontent.jamendo.com/?id=99',
    page_url:'https://www.jamendo.com/track/99',license_url:'https://creativecommons.org/licenses/by/3.0/'};
const sandbox = {
    URL, window:{}, document:{createElement:t=>new Element(t),getElementById:()=>new Element('div')},
    MutationObserver:class { constructor(fn){this.fn=fn;observers.push(this);} observe(){} disconnect(){this.done=true;} },
    Date:{now:()=>now}, setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){},
    fetch:async (url,opts)=>{
        if (opts) { posts.push(JSON.parse(opts.body)); return {}; }
        return {ok:true,json:async()=>({ok:true,source:online?'jamendo':'local',list:url.endsWith('missing')?[]:online?[remote,{...remote,id:'100',file:'https://evil.test/song.mp3'}]:tracks})};
    }
};
vm.runInNewContext(fs.readFileSync('app/static/js/music-player.js','utf8'),sandbox);
const flush = async()=>{for(let i=0;i<8;i++) await Promise.resolve();};
const get = (root,cls)=>root.querySelector('.'+cls);
(async()=>{
    const first = new Element('div'); sandbox.window.CampusMusic.mount(first,{xsrf:'token'}); await flush();
    const audio = get(first,'music-audio'), controls = get(first,'music-controls');
    assert.equal(posts.length,0,'opening a card must not count as playback');
    assert.equal(get(first,'music-list').children.length,3);
    controls.children[1].fire('click'); await flush();
    assert.equal(audio.paused,false); assert.equal(posts[0].id,1);
    controls.children[1].fire('click'); controls.children[1].fire('click'); await flush();
    assert.equal(posts.length,1,'resume must not count the same selection twice');
    audio.fire('ended'); await flush(); assert.equal(posts.at(-1).id,2);
    controls.children[3].fire('click'); // single-track repeat
    audio.fire('ended'); await flush(); assert.equal(posts.at(-1).id,2);
    const second = new Element('div'); sandbox.window.CampusMusic.mount(second,{xsrf:'token'}); await flush();
    get(second,'music-controls').children[1].fire('click'); await flush();
    assert.equal(audio.paused,true,'only one card may play');
    const timer = get(second,'music-timer').children[0]; timer.value='25'; timer.fire('change');
    now += 25*60000; intervals.at(-1)();
    assert.equal(get(second,'music-audio').paused,true,'timer pauses playback');
    const form = get(second,'music-search'); form.children[0].value='missing'; form.fire('submit'); await flush();
    assert.equal(get(second,'music-list').children.length,0);
    assert.equal(get(second,'music-controls').children[1].disabled,true);
    online = true;
    const third = new Element('div'); sandbox.window.CampusMusic.mount(third,{xsrf:'token'}); await flush();
    assert.equal(get(third,'music-local').textContent,'Jamendo 在线曲库');
    assert.equal(get(third,'music-list').children.length,1,'untrusted remote audio must be rejected');
    assert.equal(get(third,'music-attribution').children[0].href,remote.page_url);
    assert.equal(get(third,'music-attribution').children[1].href,remote.license_url);
    assert.equal(get(third,'music-cover').hidden,false);
    const before = posts.length;
    get(third,'music-controls').children[1].fire('click'); await flush();
    assert.equal(get(third,'music-audio').src,remote.file);
    assert.equal(posts.length,before,'remote IDs must never increment local play counts');
    first.isConnected=false; observers[0].fn(); assert.equal(observers[0].done,true);
    console.log('PASS: selection, actual-play counting, pause/resume, next/repeat, exclusive playback, timer, empty search, disposal');
})().catch(e=>{console.error(e);process.exitCode=1;});
