// Run with: node tests/test_avatar_playback.cjs. Speech API mocked; no network or packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Button {
    constructor() { this.innerHTML = ''; this.listeners = {}; this.icon = {}; }
    addEventListener(event, fn) { this.listeners[event] = fn; }
    setAttribute() {}
    querySelector() { return this.icon; }
    click() { this.listeners.click(); }
}
const ids = Object.fromEntries(['avatarPlaybackBtn','avatarRestartBtn','avatarTtsBtn'].map(id=>[id,new Button()]));
const spoken = [], timers = [];
const synth = {paused:false, addEventListener(){}, getVoices:()=>[], speak(u){spoken.push(u);u.onstart();}, pause(){this.paused=true;}, resume(){this.paused=false;}, cancel(){this.cancelled=true;}};
const sandbox = {
    document:{readyState:'loading',getElementById:id=>ids[id],addEventListener(){}},
    window:{speechSynthesis:synth}, localStorage:{getItem:()=>null,setItem(){}},
    SpeechSynthesisUtterance:function(text){this.text=text;},
    setTimeout:fn=>timers.push(fn)
};
let src=fs.readFileSync(path.join(__dirname,'../app/static/js/avatar.js'),'utf8');
src=src.replace('    if (document.readyState === "loading") {', '    window.testAudio={ttsFeed,ttsFlush,ttsStopAll,bindPlaybackControls,replayAnswer,voiceActive,getState:()=>tts,setAnswer:(text,generating)=>{answerText=text;streaming=generating;}};\n    if (document.readyState === "loading") {');
vm.createContext(sandbox); vm.runInContext(src,sandbox);
const api=sandbox.window.testAudio, play=ids.avatarPlaybackBtn, restart=ids.avatarRestartBtn;
api.bindPlaybackControls(); assert.equal(play.disabled,true);
api.setAnswer('你好。后续内容。',true);
api.ttsFeed('你好。');
assert.equal(spoken.length,1); assert.match(play.innerHTML,/暂停/);
play.click();
assert.equal(synth.paused,true); assert.match(play.innerHTML,/继续播放/); assert.equal(restart.hidden,false);
assert.equal(api.voiceActive(),false);
api.ttsFeed('后续内容。'); api.ttsFlush();
assert.equal(spoken.length,1,'paused stream must queue without speaking');
play.click(); assert.equal(synth.paused,false); assert.match(play.innerHTML,/暂停/);
spoken[0].onend(); timers.splice(0).forEach(fn=>fn());
assert.equal(spoken.length,2); assert.equal(spoken[1].text,'后续内容。');
api.setAnswer('你好。后续内容。',false);
spoken[1].onend(); timers.splice(0).forEach(fn=>fn());
assert.match(play.innerHTML,/从头播放/);
play.click(); assert.equal(spoken[2].text,'你好。');
play.click(); assert.equal(api.getState().paused,true);
restart.click(); assert.equal(api.getState().paused,false); assert.equal(spoken[3].text,'你好。');
const old=spoken[3];
api.ttsStopAll(); api.setAnswer('新回复。',false); api.ttsFeed('新回复。');
const current=api.getState().current;
old.onend(); assert.equal(api.getState().current,current,'cancelled callbacks cannot reset new playback');
api.ttsStopAll();
api.setAnswer('长段落',false); api.ttsFeed('长'.repeat(500)); api.ttsFlush();
assert.equal(api.getState().current.text.length+api.getState().queue.join('').length,500);
api.ttsStopAll();
console.log('PASS: autoplay, pause while streaming, resume, replay, cancellation isolation, long-text preservation');
