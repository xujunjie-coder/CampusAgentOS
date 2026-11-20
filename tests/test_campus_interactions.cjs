// Run with: node tests/test_campus_interactions.cjs (uses local Three.js r128; no packages or live server).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('../app/static/vendor/three/three.min.js');

// -------- 1. 3D 华小竹动作机 + 数字员工身份光环联动 --------
const gradient = { addColorStop() {} };
const ctx = new Proxy({}, {
    get(target, key) {
        if (key in target) return target[key];
        if (String(key).startsWith('create') && String(key).endsWith('Gradient')) return () => gradient;
        if (key === 'measureText') return text => ({ width: String(text).length * 10 });
        return () => {};
    }
});
const pandaSandbox = {
    window: {},
    document: { createElement: () => ({ getContext: () => ctx }) },
    console
};
const origLoad = THREE.TextureLoader.prototype.load;
THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const tex = new THREE.Texture();
    if (onLoad) onLoad(tex);
    return tex;
};
vm.createContext(pandaSandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/static/js/avatar-cwnu-panda.js'), 'utf8'), pandaSandbox);
const panda = pandaSandbox.window.buildCwnuPandaAvatar(THREE, null);
THREE.TextureLoader.prototype.load = origLoad;

assert.equal(typeof panda.triggerGesture, 'function');
assert.equal(typeof panda.setPersona, 'function');
assert.equal(panda.triggerGesture('wave'), true);
assert.equal(panda.triggerGesture('unknown-gesture'), false);
assert.equal(panda.setPersona('career'), 'career');
assert.equal(panda.setPersona('mental'), 'mental');
assert.equal(panda.setPersona('unknown-role'), 'default');

const geometryIds = new Set();
panda.root.traverse(o => { if (o.geometry) geometryIds.add(o.geometry.uuid); });
const book = panda.root.getObjectByName('panda-holographic-book');

function assertPandaIntegrity() {
    panda.root.updateMatrixWorld(true);
    panda.root.traverse(obj => {
        assert(obj.matrixWorld.elements.every(Number.isFinite), 'non-finite matrix: ' + obj.name);
        if (!obj.isMesh) return;
        const pos = obj.geometry.attributes.position;
        assert(pos && pos.array.every(Number.isFinite), 'non-finite vertices: ' + obj.name);
        if (obj.geometry.attributes.normal) {
            assert(obj.geometry.attributes.normal.array.every(Number.isFinite), 'non-finite normals: ' + obj.name);
        }
    });
    const readingNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(book.quaternion);
    const toEyes = new THREE.Vector3(0, 1.74, 0.50).sub(book.position).normalize();
    assert(readingNormal.dot(toEyes) > 0.99, 'book must keep facing panda during gestures');
}

const gestures = ['wave', 'nod', 'book', 'celebrate'];
const personas = ['default', 'career', 'mental'];
let tickTime = 0;
for (let gi = 0; gi < gestures.length; gi++) {
    panda.setPersona(personas[gi % personas.length]);
    panda.triggerGesture(gestures[gi], 0.8);
    assert.equal(panda.getGesture(), gestures[gi]);
    for (let step = 0; step < 30; step++) {
        tickTime += 1 / 60;
        panda.update(tickTime, 1 / 60, {
            voiceActive: step % 2 === 0,
            mouthPulse: 0.7,
            audioLevel: 0.65,
            pointerNX: 0.25,
            pointerNY: -0.1,
            thinking: gi === 1
        });
    }
    assertPandaIntegrity();
}
// 推进到动作结束，验证状态自然复位
for (let step = 0; step < 40; step++) {
    tickTime += 1 / 60;
    panda.update(tickTime, 1 / 60, { voiceActive: false });
}
assert.equal(panda.getGesture(), null);
panda.root.traverse(o => {
    if (o.geometry) assert(geometryIds.has(o.geometry.uuid), 'geometry rebuilt during gesture animation');
});

// -------- 2. avatar.js sources SSE 引用卡片 + 语音识别空保护 --------
class MockEl {
    constructor() { this.children = []; this.className = ''; this.textContent = ''; this.innerHTML = ''; this.attributes = {}; this.listeners = {}; }
    replaceChildren() { this.children = []; }
    appendChild(child) { child.parentNode = this; this.children.push(child); }
    insertBefore(child, before) { child.parentNode = this; this.children.splice(this.children.indexOf(before), 0, child); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelector() { return null; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    focus() {}
}
const avatarIds = Object.fromEntries(['captionBody', 'avatarAssistant', 'avatarSend', 'avatarInput', 'avatarMicBtn', 'avatarGestureBar', 'avatarAgentSelect', 'avatarAgentTrigger', 'avatarAgentCurrent', 'avatarAgentMenu', 'avatarAgentPicker'].map(id => [id, new MockEl()]));
const avatarSandbox = {
    document: { readyState: 'loading', cookie: '', getElementById: id => avatarIds[id], createElement: () => new MockEl(), querySelector: () => null, addEventListener() {} },
    window: {},
    localStorage: { getItem: () => '0' },
    TextDecoder,
    setTimeout,
    fetch: async () => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) } })
};
let avatarSrc = fs.readFileSync(path.join(__dirname, '../app/static/js/avatar.js'), 'utf8');
avatarSrc = avatarSrc.replace('    if (document.readyState === "loading") {', '    window.testCampusAvatar = { handleFrame, setupAvatarAsr, bindGestureBar };\n    if (document.readyState === "loading") {');
vm.createContext(avatarSandbox);
vm.runInContext(avatarSrc, avatarSandbox);

const capApi = avatarSandbox.window.testCampusAvatar;
capApi.setupAvatarAsr();
capApi.bindGestureBar();
assert.equal(typeof avatarIds.avatarMicBtn.listeners.click, 'function');
avatarIds.avatarMicBtn.listeners.click();
assert.match(avatarIds.captionBody.children.at(-1).children[1].textContent, /暂不支持语音识别/);

avatarIds.captionBody.children = [];
capApi.handleFrame({
    event: 'sources',
    data: {
        items: [
            { id: 1, title: '05-奖学金评定说明.md', excerpt: '国家奖学金要求专业排名前5%且无不及格。', score: 0.86 },
            { id: 2, title: '09-校园生活指南.md', excerpt: '华凤校区与北湖校区之间设有通勤校车。', score: 0.64 }
        ]
    }
});
const sourceDrawers = avatarIds.captionBody.children.filter(c => c.className === 'avatar-sources');
assert.equal(sourceDrawers.length, 1);
assert.match(sourceDrawers[0].children[0].textContent, /参考来源 · 2 篇知识库文档/);
assert.equal(sourceDrawers[0].children[1].children.length, 2);
assert.match(sourceDrawers[0].children[1].children[0].children[0].textContent, /05-奖学金评定说明\.md/);

// -------- 3. 大屏与对话代码合约静态断言 --------
const globeSrc = fs.readFileSync(path.join(__dirname, '../app/static/js/dashboard-globe.js'), 'utf8');
assert.match(globeSrc, /focusRegion:\s*focusRegion/);
assert.match(globeSrc, /onNodeClick/);

const dashSrc = fs.readFileSync(path.join(__dirname, '../app/static/js/dashboard.js'), 'utf8');
assert.match(dashSrc, /function renderCampusMap\(/);
assert.match(dashSrc, /function applyAskAction\(/);
assert.match(dashSrc, /openDrillDrawer/);

const chatSrc = fs.readFileSync(path.join(__dirname, '../app/static/js/chat.js'), 'utf8');
assert.match(chatSrc, /setSources:/);
assert.match(chatSrc, /ev === "sources"/);

console.log('PASS: panda gestures & persona halo, avatar sources drawer & ASR fallback, dashboard campus/drilldown contracts');
