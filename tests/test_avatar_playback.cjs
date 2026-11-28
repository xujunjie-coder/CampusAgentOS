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
src=src.replace('    if (document.readyState === "loading") {', '    window.testAudio={ttsFeed,ttsFlush,ttsStopAll,bindPlaybackControls,replayAnswer,voiceActive,getReading:()=>reading,getState:()=>tts,setAnswer:(text,generating)=>{answerText=text;streaming=generating;}};\n    if (document.readyState === "loading") {');
vm.createContext(sandbox); vm.runInContext(src,sandbox);
const api=sandbox.window.testAudio, play=ids.avatarPlaybackBtn, restart=ids.avatarRestartBtn;
api.bindPlaybackControls(); assert.equal(play.disabled,true);
// The browser may wait before audio starts. Text arrival must never open the mouth.
const immediateSpeak = synth.speak;
synth.speak = u => spoken.push(u);
api.setAnswer('等待播放。',true);
api.ttsFeed('等待播放。');
assert.equal(api.voiceActive(),false,'queued audio has not started');
api.ttsFeed('第二句。');
assert.equal(spoken.length,1,'pending utterance must not be queued twice');
spoken[0].onstart();
assert.equal(api.voiceActive(),true);
assert.equal(api.getReading().u.text,'等待播放。');
assert.equal(api.getReading().index,0);
spoken[0].onboundary({name:'word',charIndex:1,charLength:2});
assert.equal(api.getReading().index,1);
assert.equal(api.getReading().length,2);
spoken[0].onpause();
assert.equal(api.voiceActive(),false);
assert.equal(api.getReading().index,1,'pause retains the reading position');
spoken[0].onresume();
assert.equal(api.voiceActive(),true);
assert.equal(api.getReading().index,1,'resume retains the reading position');
spoken[0].onend();
assert.equal(api.voiceActive(),false,'mouth must close between sentences');
assert.equal(api.getReading(),null);
api.ttsStopAll(); timers.length=0; spoken.length=0;
synth.speak = immediateSpeak;
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
const beforeEmoji = spoken.length;
api.ttsFeed('🐼😊🇨🇳👍🏽👨‍👩‍👧‍👦1️⃣'); api.ttsFlush();
assert.equal(spoken.length, beforeEmoji, 'emoji-only replies must not create utterances');
api.ttsFeed('你好🐼，请在2026年提交材料，');
api.ttsFeed('步骤1️⃣完成✅，得分100分。');
api.ttsFlush();
assert.equal(spoken.at(-1).text, '你好，请在2026年提交材料，步骤 完成，得分100分。');
api.ttsStopAll();
api.setAnswer('欢迎🎓同学🇨🇳！', false);
api.replayAnswer();
assert.equal(spoken.at(-1).text, '欢迎同学！', 'replay must also strip emoji');
api.ttsStopAll();
const speech = '我来帮你撰写一份演讲稿。先检索一下资料库，看看有没有可引用资料。\n\n'
    + '# 拥抱数字时代，从这里扬帆起航\n\n——计算机学院招生宣传演讲稿\n\n'
    + '尊敬的各位老师、亲爱的同学们：\n欢迎报考计算机学院（这部分不需要朗读。还有嵌套(来源说明)）。\n'
    + '五、选择计算机学院的三个理由\n'
    + '第一，平台扎实。学院成立于1993年（仅反映原文批次），现有58名教职员工。\n'
    + '**欢迎大家报考，我们在南充等你来！**\n谢谢大家！\n\n'
    + '**说明：**本演讲稿相关内容仅供参考，请以学校官方公告为准。\n'
    + '使用前建议结合学院招生材料核对与补充。\n\n以上信息仅供参考。';
const expected = '尊敬的各位老师、亲爱的同学们：欢迎报考计算机学院。第一，平台扎实。学院成立于1993年，现有58名教职员工。欢迎大家报考，我们在南充等你来！谢谢大家！';
for (const chunkSize of [1, 7, speech.length]) {
    const start = spoken.length;
    for (let i=0; i<speech.length; i+=chunkSize) api.ttsFeed(speech.slice(i,i+chunkSize));
    api.ttsFlush();
    const actual = spoken.slice(start).map(u=>u.text).concat(Array.from(api.getState().queue)).join('');
    assert.equal(actual, expected, 'only speech body is narrated, chunk size '+chunkSize);
    api.ttsStopAll();
}
api.setAnswer(speech, false);
const replayStart = spoken.length;
api.replayAnswer();
assert.equal(spoken.slice(replayStart).map(u=>u.text).concat(Array.from(api.getState().queue)).join(''), expected);
api.ttsStopAll();
console.log('PASS: playback controls, emoji, numbers, streamed preface/heading/parenthesis/disclaimer filtering and filtered replay');
