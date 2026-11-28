// Run: node tests/test_avatar_lipsync.cjs. Deterministic speech clock; no packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let now = 0;
const spoken = [], timers = [], frames = [];
const buttons = Object.fromEntries(['avatarPlaybackBtn', 'avatarRestartBtn'].map(id => [id, {
    addEventListener(event, fn) { this[event] = fn; },
    setAttribute() {}, innerHTML: ''
}]));
const synth = { getVoices: () => [], addEventListener() {}, speak(u) { spoken.push(u); },
    cancel() {}, pause() {}, resume() {} };
const sandbox = {
    window: { speechSynthesis: synth },
    document: { readyState: 'loading', addEventListener() {}, getElementById: id => buttons[id] },
    localStorage: { getItem: () => null }, performance: { now: () => now * 1000 },
    SpeechSynthesisUtterance: function(text) { this.text = text; },
    setTimeout: fn => timers.push(fn), requestAnimationFrame() {}
};
let source = fs.readFileSync(path.join(__dirname, '../app/static/js/avatar.js'), 'utf8');
source = source.replace('    if (document.readyState === "loading") {', `
    window.testLip = { ttsFeed, ttsFlush, ttsStopAll, speechMouth, bindPlaybackControls,
        state: () => tts, frame: () => animate(performance.now()),
        setup: (record) => { MODE = "panda"; pandaAvatar = { update: (t, dt, state) => record(state) }; answerText = "你好，世界。"; }
    };
    if (document.readyState === "loading") {`);
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const api = sandbox.window.testLip;
api.setup(state => frames.push(state));
api.bindPlaybackControls();
const open = () => { api.frame(); return frames.at(-1).mouthOpen; };
api.ttsFeed('你好，世界。');
assert.equal(open(), 0, 'queued text cannot move the mouth');
const first = spoken.at(-1);
now = 10; first.onstart();
now += 0.095;
assert.ok(open() > 0.5, 'syllable envelope reaches the panda renderer');
now = 10.19;
assert.ok(open() >= 0.18, 'adjacent syllables must not repeatedly snap fully closed');
now = 10.45;
assert.equal(open(), 0, 'comma has a closed-mouth interval');
first.onboundary({ name: 'sentence', charIndex: 0 });
assert.equal(open(), 0, 'sentence notifications must not rewind to the opening syllable');
// An actual speech boundary corrects accumulated timing drift.
now = 12; first.onboundary({ charIndex: 3 });
now += 0.095;
assert.ok(open() > 0.5, 'engine position re-anchors the envelope after a delay');
// UI pause/resume must freeze the clock even if the engine omits pause events.
buttons.avatarPlaybackBtn.click();
assert.equal(open(), 0);
now += 20;
buttons.avatarPlaybackBtn.click();
assert.ok(open() > 0.5, 'pause time must not advance the timeline');
first.onpause(); assert.equal(open(), 0);
now += 5; first.onresume();
assert.ok(open() > 0.5, 'native resume also preserves the timeline');
// Duplicate, invalid or stale boundaries must not rewind the current sentence.
const lip = api.state().lip;
const position = lip.position;
first.onboundary({ charIndex: 0 });
first.onboundary({ charIndex: -1 });
first.onboundary({ charIndex: NaN });
assert.equal(lip.position, position);
api.ttsFeed('下一句。');
first.onend();
assert.equal(open(), 0, 'sentence gap closes immediately');
timers.splice(0).forEach(fn => fn());
const second = spoken.at(-1);
second.onstart(); now += 0.095;
assert.ok(open() > 0.5);
first.onend(); first.onpause(); first.onboundary({ charIndex: 1 });
assert.equal(api.state().current, second, 'late events from a finished sentence cannot stop the next');
assert.ok(open() > 0.5);
second.onerror(); assert.equal(open(), 0);
api.ttsStopAll(); api.ttsFeed('重播。');
const third = spoken.at(-1); third.onstart(); now += 0.095;
assert.ok(open() > 0.5);
api.ttsStopAll();
third.onstart(); third.onresume(); third.onboundary({ charIndex: 1 });
assert.equal(open(), 0, 'cancelled speech cannot reopen the mouth');
// No boundary support: finite fallback, including punctuation and final closure.
api.ttsFeed('你好。');
const fallback = spoken.at(-1); fallback.onstart();
now += 0.095; assert.ok(open() > 0.5);
now += 1; assert.equal(open(), 0);
fallback.onend();
console.log('PASS: speech-driven mouth, punctuation, boundary correction, pause clocks, errors and stale callbacks');
