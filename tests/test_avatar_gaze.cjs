// No WebGL or browser required; exercise real stage event handlers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const THREE = require('../app/static/vendor/three/three.min.js');
const original = fs.readFileSync(path.join(__dirname, '../app/static/js/avatar.js'), 'utf8');
for (const pointerEvents of [true, false]) {
    const stageEvents = {}, windowEvents = {};
    const stage = {
        clientWidth: 800, clientHeight: 500,
        appendChild() {}, setPointerCapture() {},
        getBoundingClientRect: () => ({left: 30, top: 100, width: 800, height: 500}),
        addEventListener: (event, fn) => { stageEvents[event] = fn; }
    };
    class Renderer {
        constructor() { this.domElement = {}; }
        setPixelRatio() {} setSize() {}
    }
    const sandbox = {
        THREE: {...THREE, WebGLRenderer: Renderer},
        window: {PointerEvent: pointerEvents, addEventListener: (event, fn) => { windowEvents[event] = fn; }},
        document: {readyState: 'loading', getElementById: () => stage, addEventListener() {}},
        localStorage: {getItem: () => null}, setTimeout() {}
    };
    const source = original.replace('    if (document.readyState === "loading") {',
        '    window.testGaze = {initRenderer, updatePointerGaze, gaze: () => [pointerNX, pointerNY], target: () => [pointerTargetX, pointerTargetY], reset: () => {pointerNX=.8; pointerNY=-.6; pointerVelocityX=pointerVelocityY=pointerTargetX=pointerTargetY=0;}};\n    if (document.readyState === "loading") {');
    vm.createContext(sandbox); vm.runInContext(source, sandbox);
    const api = sandbox.window.testGaze;
    assert.equal(api.initRenderer(), true);
    const move = pointerEvents ? 'pointermove' : 'mousemove';
    const leave = pointerEvents ? 'pointerleave' : 'mouseleave';
    const down = pointerEvents ? 'pointerdown' : 'mousedown';
    const gaze = () => Array.from(api.gaze());
    const target = () => Array.from(api.target());
    const look = (x, y) => stageEvents[move]({clientX: x, clientY: y});
    look(630, 225);
    assert.deepEqual(target(), [0.5, -0.5], 'inside uses stage-relative coordinates');
    for (let frame=0;frame<180;frame++) api.updatePointerGaze(1/60);
    const beforeLeave = gaze();
    stageEvents[leave]({});
    assert.deepEqual(target(), [0, 0], 'leaving the stage targets the center');
    assert.deepEqual(gaze(), beforeLeave, 'exit must not snap the displayed gaze');
    let previous = beforeLeave[0];
    for (let frame=0;frame<60;frame++) {
        api.updatePointerGaze(1/60);
        const current = gaze()[0];
        assert(current <= previous + 1e-7 && current >= 0, 'return must be monotonic without overshoot');
        assert(previous-current < .025, 'return must not jump between frames');
        previous = current;
    }
    assert(previous < .003, 'gaze should settle near the center in one second');
    // Captured pointer movement still reaches the stage while dragging outside it.
    stageEvents[down]({button: 0, pointerType: 'mouse', pointerId: 1, clientX: 630});
    for (const [x, y] of [[29, 300], [831, 300], [430, 99], [430, 601]]) {
        look(630, 225); look(x, y);
        assert.deepEqual(target(), [0, 0], 'outside every edge targets the center');
    }
    look(630, 225);
    windowEvents.blur({});
    assert.deepEqual(target(), [0, 0], 'window focus loss targets the center');
    if (pointerEvents) {
        look(630, 225);
        windowEvents.pointercancel({type: 'pointercancel'});
        assert.deepEqual(target(), [0, 0]);
    }
    look(430, 350);
    assert.deepEqual(target(), [0, 0], 'stage center faces forward');
    const positions = [30,60,120].map(fps => {
        api.reset();
        for(let frame=0;frame<fps/2;frame++) api.updatePointerGaze(1/fps);
        return gaze();
    });
    for(const position of positions) assert(Math.abs(position[0]-positions[0][0])<1e-10, 'return timing must be frame-rate independent');
}
console.log('PASS: stage-only gaze, smooth return without snapping/overshoot, capture, blur and 30/60/120fps timing');
