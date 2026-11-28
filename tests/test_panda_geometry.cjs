// Uses the project's own Three.js r128. No packages, WebGL or database needed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const THREE = require('../app/static/vendor/three/three.min.js');
const gradient = {addColorStop(){}};
const ctx = new Proxy({}, {get(target,key) {
    if (key in target) return target[key];
    if (String(key).startsWith('create') && String(key).endsWith('Gradient')) return ()=>gradient;
    if (key==='measureText') return text=>({width:String(text).length*10});
    return ()=>{};
}});
const sandbox = {window:{},document:{createElement:()=>({getContext:()=>ctx})},console};
const originalLoad = THREE.TextureLoader.prototype.load;
THREE.TextureLoader.prototype.load = function(url,onLoad) {const tex=new THREE.Texture(); if(onLoad)onLoad(tex);return tex;};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/static/js/avatar-cwnu-panda.js'),'utf8'),sandbox);
const avatar=sandbox.window.buildCwnuPandaAvatar(THREE,null);
THREE.TextureLoader.prototype.load=originalLoad;
function check(root) {
    let meshes=0,triangles=0,vertices=0;
    root.updateMatrixWorld(true);
    root.traverse(obj=>{
        assert(obj.matrixWorld.elements.every(Number.isFinite), 'invalid transform: '+obj.name);
        if(!obj.isMesh) return;
        meshes++;
        const geo=obj.geometry, pos=geo.attributes.position;
        assert(pos && pos.array.every(Number.isFinite),'invalid vertices: '+obj.name+' '+geo.type+' '+JSON.stringify(geo.parameters));
        vertices+=pos.count;
        if(geo.index) {
            assert(geo.index.array.every(i=>i>=0&&i<pos.count),'invalid indices: '+obj.name);
            triangles+=geo.index.count/3;
        } else triangles+=pos.count/3;
        if(geo.attributes.normal) assert(geo.attributes.normal.array.every(Number.isFinite),'invalid normals: '+obj.name);
    });
    return {meshes,vertices,triangles};
}
const blackEar=avatar.root.getObjectByName('panda-black-ear-1');
assert(blackEar.material.color.r < .01 && blackEar.material.color.g < .01 && blackEar.material.color.b < .01,'black fur must stay dark in linear space');
assert(blackEar.material.envMapIntensity <= .2);
const belly=avatar.root.getObjectByName('panda-white-belly');
const pelvis=avatar.root.getObjectByName('panda-black-pelvis');
assert(belly.position.z + belly.geometry.parameters.radius * belly.scale.z > pelvis.position.z + pelvis.geometry.parameters.radius * pelvis.scale.z + .03,'white belly must sit in front of black pelvis');
assert.notEqual(blackEar.material.customProgramCacheKey(),belly.material.customProgramCacheKey(),'dark and light fur must not share a rim shader program');
assert(avatar.root.getObjectByName('panda-right-thumb').position.x < 0, 'right thumb must be radial when fingers point down and palm faces local +Z');
assert(avatar.root.getObjectByName('panda-left-thumb').position.x > 0, 'left hand must mirror the right hand');
const book=avatar.root.getObjectByName('panda-holographic-book');
function checkReadingPose() {
    const readingNormal=new THREE.Vector3(0,0,1).applyQuaternion(book.quaternion);
    const toEyes=new THREE.Vector3(0,1.74,.50).sub(book.position).normalize();
    assert(readingNormal.dot(toEyes) > .99, 'book text must face the panda throughout animation');
}
checkReadingPose();
for(const sx of [-1,1]) assert.equal(avatar.root.getObjectByName('panda-book-reading-page-'+sx).material.side,THREE.FrontSide,'page text must not show mirrored through the back');
let sleeves=0, cuffs=0;
avatar.root.traverse(obj=>{
    const isSleeve=obj.name==='panda-cloth-sleeve';
    const isCuff=obj.name==='panda-cloth-cuff';
    const isLeg=obj.name.startsWith('panda-continuous-leg-');
    if(!isSleeve&&!isCuff&&!isLeg) return;
    const geo=obj.geometry, pos=geo.attributes.position, normal=geo.attributes.normal;
    let radialDot=0, samples=0;
    const points=geo.parameters.points;
    const minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
    const maxR=Math.max(...points.map(p=>p.x));
    for(let i=0;i<pos.count;i++) {
        const y=pos.getY(i), r=Math.hypot(pos.getX(i),pos.getZ(i));
        if(!isCuff && (y<=minY+(maxY-minY)*.3 || y>=minY+(maxY-minY)*.7))continue;
        if(isCuff&&r<maxR-.001)continue;
        radialDot+=pos.getX(i)*normal.getX(i)+pos.getZ(i)*normal.getZ(i);samples++;
    }
    assert(samples>0&&radialDot/samples>0,'outer fabric/leg normals must face outward: '+obj.name);
    if(isSleeve||isCuff)assert(!obj.material.transparent&&obj.material.opacity===1,'cloth must be opaque');
    if(isSleeve)sleeves++;
    if(isCuff)cuffs++;
});
assert.equal(sleeves,3);assert.equal(cuffs,2);
const before=check(avatar.root);
const geometryIds=new Set(); avatar.root.traverse(o=>{if(o.geometry)geometryIds.add(o.geometry.uuid);});
for(let frame=0;frame<720;frame++) {
    avatar.update(frame/60,1/60,{voiceActive:frame%180<90,mouthPulse:.6,pointerNX:Math.sin(frame/70),pointerNY:Math.cos(frame/90),thinking:frame%200<80});
    if(frame%90===0) { check(avatar.root); checkReadingPose(); }
}
avatar.addYaw(1); avatar.update(13,1/60,{}); avatar.resetYaw();
// Narration should produce restrained hand beats, then settle after audio stops.
const shoulder = avatar.root.getObjectByName('panda-left-shoulder');
let largestLift = 0;
for (let frame=0; frame<900; frame++) {
    avatar.update(14+frame/60,1/60,{voiceActive:true,mouthOpen:.4});
    largestLift = Math.max(largestLift,shoulder.rotation.z-.25);
    assert(shoulder.rotation.z >= .25 && shoulder.rotation.z <= .58, 'narration gesture must stay restrained');
}
assert(largestLift > .25, 'narration must automatically lift the free hand');
const beforeStop = shoulder.rotation.z;
avatar.update(29,1/60,{voiceActive:false});
assert(Math.abs(shoulder.rotation.z-beforeStop)<.04,'stopping narration must not snap the arm');
for(let frame=1;frame<=180;frame++) avatar.update(29+frame/60,1/60,{voiceActive:false});
assert(Math.abs(shoulder.rotation.z-.25)<.001,'paused/finished narration must return to rest');
avatar.root.traverse(o=>{if(o.geometry)assert(geometryIds.has(o.geometry.uuid),'geometry rebuilt during animation');});
assert(avatar.root.getObjectByName('panda-neck-transition'));
for(const sx of [-1,1]) {
    assert(avatar.root.getObjectByName('panda-eye-'+sx));
    assert(avatar.root.getObjectByName('panda-eyelid-'+sx));
    const collar=avatar.root.getObjectByName('panda-collar-'+sx);
    assert(collar,'collar missing');
    const edges=new Map(), indices=collar.geometry.index.array;
    for(let i=0;i<indices.length;i+=3) for(const [a,b] of [[indices[i],indices[i+1]],[indices[i+1],indices[i+2]],[indices[i+2],indices[i]]]) {
        const key=Math.min(a,b)+':'+Math.max(a,b);edges.set(key,(edges.get(key)||0)+1);
    }
    assert([...edges.values()].every(n=>n===2),'collar must be closed');
}
console.log('PASS: build, finite geometry/normals, closed collars, blink/speech/rotation, stable animation geometry',JSON.stringify(before));
