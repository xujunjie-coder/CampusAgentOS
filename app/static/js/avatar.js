/*
 * avatar.js —— 3D 数字人交互页（成员 D，任务2 · 虚拟主播版）
 * 1. 主形象：pixiv three-vrm-girl（VRM/glTF，本地 vendor 2.6MB）——动漫风虚拟主播，
 *    自带 43 个表情 morph（口型 a/i/u/e/o=32~36、眨眼=12、joy=2），
 *    标准 humanoid 骨骼程序化驱动 idle 呼吸/头随鼠标/说话手势；GLTFLoader(r128) 本地加载
 * 2. 语音：浏览器原生 Web Speech API（离线零依赖），回复按句切分排队朗读，
 *    朗读期间口型 morph 随节奏切换；静音开关存 localStorage；
 *    关朗读时按文字增量节奏模拟张嘴（不出声）
 * 3. 降级链：GLB 加载失败 → 低多边形程序化数字人；WebGL 不可用 → 纯文字页
 * 4. 对话完全复用 /api/chat SSE 契约（与 chat.js 同帧格式），session_id=avatar3d
 */
(function () {
    "use strict";

    var SESSION_ID = "avatar3d";
    var MODEL_URL = "/static/vendor/three/models/three-vrm-girl.glb";
    var streaming = false;
    var gotDelta = false;

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function xsrfToken() {
        var hidden = document.querySelector('#xsrfBox input[name="_xsrf"]');
        if (hidden) return hidden.value;
        var m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : "";
    }

    // ---------- SSE 帧解析（与 chat.js 同口径） ----------
    function parseSseBlock(block) {
        var ev = (block.match(/^event:\s*(.+)$/m) || [])[1];
        var dataLine = block.split("\n").find(function (l) { return l.indexOf("data:") === 0; });
        if (!ev || dataLine == null) return null;
        var raw = dataLine.slice(5).trim();
        var data;
        try { data = JSON.parse(raw); } catch (e) { data = raw; }
        return { event: ev.trim(), data: data };
    }

    // ---------- 字幕 ----------
    function clearCaptionEmpty() {
        var empty = $("captionBody").querySelector(".avatar-caption-empty");
        if (empty) $("captionBody").innerHTML = "";
    }

    function appendCaption(who, text, cls) {
        clearCaptionEmpty();
        var row = document.createElement("div");
        row.className = "avatar-cap-line " + (cls || "");
        row.innerHTML = '<b>' + esc(who) + "</b><span></span>";
        row.querySelector("span").textContent = text;
        $("captionBody").appendChild(row);
        $("captionBody").scrollTop = $("captionBody").scrollHeight;
        return row.querySelector("span");
    }

    // ---------- three.js 场景 ----------
    var scene, camera, renderer, gridHelper, ambientLight, keyLight;
    var MODE = "none";              // panda | vrm | procedural
    var MODEL_CHOICE_KEY = "govcheck.avatar.model";
    var wantedModel = "cwnu-panda";
    var pandaAvatar = null;
    var vrmLoading = false;
    var vrmReady = false;
    var vrmFailed = false;
    var rig = {};                   // 程序化降级形象
    var vtuber = { root: null, faces: [], bones: {}, base: {}, gridScale: 1, camPos: null, camLook: null };
    var thinking = false;
    var mouthPulse = 0;             // 文字驱动口型的脉冲强度
    var pointerNX = 0, pointerNY = 0; // 鼠标视线 [-1,1]
    var nextBlinkAt = 2, blinkPhase = -1;
    var dragging = false, dragLastX = 0;

    // three-vrm-girl blendShape 索引（解析自模型 blendShapeMaster）
    var IDX = { a: 32, i: 33, u: 34, e: 35, o: 36, blink: 12, joy: 2 };
    var VISEME = [IDX.a, IDX.i, IDX.u, IDX.e, IDX.o];

    function initRenderer() {
        var stage = $("avatarStage");
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        } catch (e) {
            return false;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(stage.clientWidth, stage.clientHeight);
        stage.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(34, stage.clientWidth / stage.clientHeight, 0.05, 100);

        ambientLight = new THREE.AmbientLight(0xdde4ff, 1.0);
        scene.add(ambientLight);
        keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
        keyLight.position.set(2, 4, 3);
        scene.add(keyLight);

        var grid = new THREE.GridHelper(12, 24, 0x224a78, 0x16223c);
        grid.position.y = 0;
        if (grid.material) {
            if (Array.isArray(grid.material)) {
                grid.material.forEach(function (m) { m.transparent = true; m.opacity = 0.48; });
            } else {
                grid.material.transparent = true;
                grid.material.opacity = 0.48;
            }
        }
        scene.add(grid);
        gridHelper = grid;

        window.addEventListener("resize", function () {
            if (!renderer) return;
            var w = stage.clientWidth, h = stage.clientHeight;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        });
        stage.addEventListener("mousemove", function (e) {
            var r = stage.getBoundingClientRect();
            pointerNX = ((e.clientX - r.left) / r.width - 0.5) * 2;
            pointerNY = ((e.clientY - r.top) / r.height - 0.5) * 2;
            if (dragging && MODE === "panda" && pandaAvatar) {
                var dx = e.clientX - dragLastX;
                dragLastX = e.clientX;
                pandaAvatar.addYaw(dx * 0.008);
            }
        });
        stage.addEventListener("mousedown", function (e) {
            if (e.button === 0) {
                dragging = true;
                dragLastX = e.clientX;
            }
        });
        window.addEventListener("mouseup", function () { dragging = false; });
        stage.addEventListener("dblclick", function () {
            if (MODE === "panda" && pandaAvatar) pandaAvatar.resetYaw();
        });
        return true;
    }

    // ---------- 主形象：VRM 虚拟主播 ----------
    function loadVrmModel(onDone) {
        if (!window.THREE || !THREE.GLTFLoader) { onDone(false); return; }
        var loader = new THREE.GLTFLoader();
        loader.load(MODEL_URL, function (gltf) {
            try {
                setupVrm(gltf.scene);
                onDone(true);
            } catch (e) {
                onDone(false);
            }
        }, undefined, function () { onDone(false); });
    }

    // three-vrm-girl 节点名是 Unity Humanoid 风（J_Bip_L_UpperArm），与 VRM humanoid 映射名不同，
    // 故用别名表匹配，两种命名都能拿到同一批骨骼
    var BONE_ALIASES = {
        head: ["head", "J_Bip_C_Head"],
        neck: ["neck", "J_Bip_C_Neck"],
        chest: ["chest", "J_Bip_C_Chest"],
        upperChest: ["upperChest", "J_Bip_C_UpperChest"],
        spine: ["spine", "J_Bip_C_Spine"],
        hips: ["hips", "J_Bip_C_Hips"],
        leftUpperArm: ["leftUpperArm", "J_Bip_L_UpperArm"],
        rightUpperArm: ["rightUpperArm", "J_Bip_R_UpperArm"],
        leftLowerArm: ["leftLowerArm", "J_Bip_L_LowerArm"],
        rightLowerArm: ["rightLowerArm", "J_Bip_R_LowerArm"]
    };

    function boneCanonical(name) {
        for (var key in BONE_ALIASES) {
            if (BONE_ALIASES[key].indexOf(name) !== -1) return key;
        }
        return null;
    }

    function setupVrm(root) {
        vtuber.root = root;
        root.traverse(function (obj) {
            // Face 按材质拆成 8 个 primitive（皮肤/瞳孔/眉毛…）但共用同一套 43 morph，
            // 必须全部收集同驱，否则眨眼/口型只有皮肤动、五官掉队
            if (obj.isSkinnedMesh && obj.morphTargetInfluences &&
                obj.morphTargetInfluences.length > IDX.o) {
                vtuber.faces.push(obj);
            }
            if (obj.isBone) {
                var canon = boneCanonical(obj.name);
                if (canon) vtuber.bones[canon] = obj;
            }
        });
        scene.add(root);
        // 实测该模型面朝 -Z（背对 +Z 机位），转 180° 正对镜头
        root.rotation.y = Math.PI;

        // 按包围盒自适应机位：不同导出单位（米/厘米级）都能正确取景，脚底对齐网格
        var box = new THREE.Box3().setFromObject(root);
        var h = Math.max(0.01, box.max.y - box.min.y);
        root.position.x -= (box.min.x + box.max.x) / 2;
        root.position.z -= (box.min.z + box.max.z) / 2;
        root.position.y -= box.min.y;
        vtuber.gridScale = h / 1.5;
        if (gridHelper) gridHelper.scale.setScalar(vtuber.gridScale);

        // 绑定姿态是 T-pose 平举：用几何四元数把上臂旋到世界下方，免猜旋转符号
        root.updateMatrixWorld(true);
        lowerArm("leftUpperArm", "leftLowerArm");
        lowerArm("rightUpperArm", "rightLowerArm");

        // 基准姿态在垂手之后捕获，idle/手势叠加都以此为原点
        for (var name in vtuber.bones) {
            var r = vtuber.bones[name].rotation;
            vtuber.base[name] = { x: r.x, y: r.y, z: r.z };
        }

        // 虚拟主播半身机位：头顶到胸口入镜
        var headY = h * 0.86;
        vtuber.camPos = [0, headY, h * 0.8];
        vtuber.camLook = [0, headY * 0.96, 0];
        applyVrmCamera();
        vrmReady = true;
        MODE = "vrm";
    }

    function lowerArm(upperName, lowerName) {
        var upper = vtuber.bones[upperName], lower = vtuber.bones[lowerName];
        if (!upper || !lower || !lower.position.lengthSq()) return;
        // 肘方向（bone 局部→父空间）与世界下方（→父空间）的夹角四元数
        var elbow = new THREE.Vector3().copy(lower.position).normalize().applyQuaternion(upper.quaternion);
        var down = new THREE.Vector3(0, -1, 0);
        var pq = new THREE.Quaternion();
        if (upper.parent) { upper.parent.getWorldQuaternion(pq); down.applyQuaternion(pq.invert()); }
        var q = new THREE.Quaternion().setFromUnitVectors(elbow.normalize(), down.normalize());
        q.slerp(new THREE.Quaternion(), 0.12);   // 留余量，手臂不完全绷直
        upper.quaternion.premultiply(q);
    }

    // ---------- 降级形象：低多边形程序化数字人 ----------
    function buildProceduralRig() {
        var body = rig.group = new THREE.Group();
        scene.add(body);

        var skin = new THREE.MeshPhongMaterial({ color: 0x3f8cff, shininess: 60 });
        var dark = new THREE.MeshPhongMaterial({ color: 0x274b8f, shininess: 40 });
        var white = new THREE.MeshPhongMaterial({ color: 0xf2f6ff });
        var mouthMat = new THREE.MeshPhongMaterial({ color: 0x0b1226 });

        var head = new THREE.Mesh(new THREE.SphereGeometry(0.52, 32, 24), skin);
        head.position.y = 1.9;
        body.add(head);
        rig.head = head;

        rig.eyes = [-1, 1].map(function (sx) {
            var eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), white);
            eye.position.set(0.18 * sx, 2.02, 0.44);
            body.add(eye);
            return eye;
        });
        var mouth = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), mouthMat);
        mouth.position.set(0, 1.74, 0.45);
        mouth.scale.set(1.4, 0.4, 0.6);
        body.add(mouth);
        rig.mouth = mouth;

        var torso = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.46, 1.0, 24), dark);
        torso.position.y = 0.95;
        body.add(torso);
        rig.arms = [-1, 1].map(function (sx) {
            var pivot = new THREE.Group();
            pivot.position.set(0.52 * sx, 1.42, 0);
            var arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.075, 0.72, 16), skin);
            arm.position.y = -0.36;
            pivot.add(arm);
            body.add(pivot);
            return pivot;
        });

        var halo = new THREE.Mesh(
            new THREE.TorusGeometry(0.62, 0.05, 12, 48),
            new THREE.MeshBasicMaterial({ color: 0x54f0c8, transparent: true, opacity: 0.75 }));
        halo.rotation.x = Math.PI / 2;
        halo.position.y = -0.35;
        body.add(halo);
        rig.halo = halo;

        camera.fov = 38;
        camera.position.set(0, 1.7, 5.2);
        camera.lookAt(0, 1.35, 0);
        camera.updateProjectionMatrix();
        MODE = "procedural";
    }

    // ---------- 口型 / 表情 / idle 动画 ----------
    var last = 0, visemeTick = 0;

    function voiceActive() {
        return tts.speaking || mouthPulse > 0.02;
    }

    function setMorph(list, idx, v) {
        for (var i = 0; i < list.length; i++) list[i].morphTargetInfluences[idx] = v;
    }

    function updateVrm(t, dt) {
        mouthPulse = Math.max(0, mouthPulse - dt * 3);   // 末字后约 0.3s 收敛，流式期间由 delta 持续重置
        var b = vtuber.bones, base = vtuber.base;
        function osc(name, fx, amp, ph) {
            var bone = b[name];
            if (!bone || !base[name]) return;
            bone.rotation.x = base[name].x + Math.sin(t * fx + (ph || 0)) * amp;
        }
        // 呼吸与轻摆（说话时幅度加大）
        var boost = voiceActive() ? 2.2 : 1;
        osc("chest", 1.5, 0.012 * boost);
        osc("spine", 0.9, 0.008 * boost, 1.2);
        var head = b.head;
        if (head && base.head) {
            // root 已转 180°，局部 Y 轴在屏幕上反向，故 X 跟随取负
            var ty = base.head.y - pointerNX * 0.30 + Math.sin(t * 0.5) * 0.045;
            var tx = base.head.x - pointerNY * 0.16 + Math.sin(t * 0.9) * 0.015;
            head.rotation.y += (ty - head.rotation.y) * Math.min(1, dt * 6);
            head.rotation.x += (tx - head.rotation.x) * Math.min(1, dt * 6);
        }
        // 说话手势：手臂小幅摆动
        if (voiceActive()) {
            osc("leftUpperArm", 2.2, 0.05, 0.6);
            osc("rightUpperArm", 2.0, 0.06, Math.PI);
        }

        var faces = vtuber.faces;
        if (!faces.length) return;
        var infl = faces[0].morphTargetInfluences;
        // 眨眼：每 2~5 秒一次，blink morph 0→1→0（全部面部网格同驱）
        if (t > nextBlinkAt && blinkPhase < 0) {
            blinkPhase = 0;
            nextBlinkAt = t + 2 + Math.random() * 3;
        }
        if (blinkPhase >= 0) {
            blinkPhase += dt / 0.14;
            setMorph(faces, IDX.blink, blinkPhase < 0.5 ? blinkPhase * 2 : Math.max(0, 2 - blinkPhase * 2));
            if (blinkPhase >= 1) { blinkPhase = -1; setMorph(faces, IDX.blink, 0); }
        }
        // 口型：朗读/文字脉冲期间按 ~7.5 次/秒切元音 morph，其余归零
        var target = [0, 0, 0, 0, 0];
        if (voiceActive()) {
            visemeTick += dt * 7.5;
            var idx = Math.floor(visemeTick) % VISEME.length;
            var open = 0.55 + 0.35 * Math.abs(Math.sin(visemeTick * 2.1)) + 0.25 * mouthPulse;
            target[idx] = Math.min(1, open);
            setMorph(faces, IDX.joy, infl[IDX.joy] + ((tts.speaking ? 0.3 : 0.12) - infl[IDX.joy]) * Math.min(1, dt * 4));
        }
        for (var k = 0; k < VISEME.length; k++) {
            var cur = infl[VISEME[k]];
            setMorph(faces, VISEME[k], cur + (target[k] - cur) * Math.min(1, dt * 14));
        }
    }

    function updateProcedural(t) {
        mouthPulse = Math.max(0, mouthPulse - 0.05);
        var speakingAmt = Math.max(mouthPulse, tts.speaking ? 0.8 : 0);
        if (rig.group) rig.group.position.y = Math.sin(t * 1.2) * 0.05 + speakingAmt * 0.01;
        if (rig.head) {
            rig.head.rotation.y = Math.sin(t * 0.6) * 0.12 + pointerNX * 0.25;
            rig.head.rotation.x = Math.sin(t * 1.1) * 0.04 - pointerNY * 0.12;
        }
        if (rig.mouth) rig.mouth.scale.y = 0.4 + speakingAmt * (0.9 + Math.sin(t * 11) * 0.45);
        if (rig.eyes) rig.eyes.forEach(function (eye, i) {
            var blink = Math.sin(t * 0.7 + i * 0.2) > 0.985 ? 0.1 : 1;
            eye.scale.y = blink;
        });
        if (rig.arms) rig.arms.forEach(function (arm, i) {
            arm.rotation.x = Math.sin(t * (1.0 + i * 0.2) + i * 3.1) * (thinking ? 0.5 : 0.15);
        });
        if (rig.halo) { rig.halo.rotation.z += 0.01; rig.halo.material.opacity = 0.55 + Math.sin(t * 2) * 0.2; }
    }

    function applyVrmCamera() {
        if (!vtuber.camPos || !vtuber.camLook) return;
        camera.fov = 34;
        camera.position.set(vtuber.camPos[0], vtuber.camPos[1], vtuber.camPos[2]);
        camera.lookAt(vtuber.camLook[0], vtuber.camLook[1], vtuber.camLook[2]);
        camera.updateProjectionMatrix();
    }

    function hideAllAvatars() {
        if (pandaAvatar && pandaAvatar.root) pandaAvatar.root.visible = false;
        if (vtuber.root) vtuber.root.visible = false;
        if (rig.group) rig.group.visible = false;
    }

    function updateModelTag(kind) {
        var tag = $("avatarModelTag");
        if (!tag) return;
        tag.textContent = kind === "cwnu-panda"
            ? "西华师范大学 · 华小竹（按住左键可旋转视角，双击复位）"
            : "虚拟主播 · VRM 实时驱动";
    }

    function renderSwitcherUI(kind) {
        var box = $("avatarSwitcher");
        if (!box) return;
        Array.prototype.forEach.call(box.querySelectorAll("[data-avatar-model]"), function (btn) {
            btn.classList.toggle("is-active", btn.getAttribute("data-avatar-model") === kind);
        });
        updateModelTag(kind);
    }

    function applyLightingMode(isPanda) {
        if (!renderer || !scene) return;
        if (isPanda) {
            if (THREE.ACESFilmicToneMapping !== undefined) renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.04;
            if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
            if (ambientLight) { ambientLight.color.setHex(0x98b0da); ambientLight.intensity = 0.38; }
            if (keyLight) { keyLight.color.setHex(0xfffaf2); keyLight.intensity = 0.92; keyLight.position.set(-2.1, 4.1, 3.8); }
            scene.environment = (pandaAvatar && pandaAvatar.envMap) ? pandaAvatar.envMap : null;
        } else {
            if (THREE.NoToneMapping !== undefined) renderer.toneMapping = THREE.NoToneMapping;
            renderer.toneMappingExposure = 1.0;
            if (THREE.LinearEncoding !== undefined) renderer.outputEncoding = THREE.LinearEncoding;
            if (ambientLight) { ambientLight.color.setHex(0xdde4ff); ambientLight.intensity = 1.0; }
            if (keyLight) { keyLight.color.setHex(0xffffff); keyLight.intensity = 0.8; keyLight.position.set(2, 4, 3); }
            scene.environment = null;
        }
    }

    function activatePanda() {
        if (!window.buildCwnuPandaAvatar) return false;
        if (!pandaAvatar) {
            pandaAvatar = window.buildCwnuPandaAvatar(THREE, renderer);
            scene.add(pandaAvatar.root);
        }
        hideAllAvatars();
        applyLightingMode(true);
        pandaAvatar.root.visible = true;
        if (gridHelper) gridHelper.scale.setScalar(1);
        var cp = pandaAvatar.cameraPreset;
        camera.fov = cp.fov;
        camera.position.set(cp.pos[0], cp.pos[1], cp.pos[2]);
        camera.lookAt(cp.lookAt[0], cp.lookAt[1], cp.lookAt[2]);
        camera.updateProjectionMatrix();
        $("avatarLoading").hidden = true;
        MODE = "panda";
        return true;
    }

    function switchAvatarModel(kind) {
        wantedModel = kind === "vrm" ? "vrm" : "cwnu-panda";
        try { localStorage.setItem(MODEL_CHOICE_KEY, wantedModel); } catch (e) {}
        renderSwitcherUI(wantedModel);

        if (wantedModel === "cwnu-panda") {
            if (activatePanda()) return;
            wantedModel = "vrm";
            renderSwitcherUI("vrm");
        }

        // 切换到 VRM 虚拟主播
        applyLightingMode(false);
        if (vrmReady && vtuber.root) {
            hideAllAvatars();
            vtuber.root.visible = true;
            if (gridHelper) gridHelper.scale.setScalar(vtuber.gridScale || 1);
            applyVrmCamera();
            $("avatarLoading").hidden = true;
            MODE = "vrm";
            return;
        }
        if (vrmFailed && rig.group) {
            hideAllAvatars();
            rig.group.visible = true;
            if (gridHelper) gridHelper.scale.setScalar(1);
            camera.fov = 38;
            camera.position.set(0, 1.7, 5.2);
            camera.lookAt(0, 1.35, 0);
            camera.updateProjectionMatrix();
            $("avatarLoading").hidden = true;
            MODE = "procedural";
            return;
        }
        if (vrmLoading) {
            $("avatarLoading").hidden = false;
            return;
        }
        vrmLoading = true;
        hideAllAvatars();
        $("avatarLoading").hidden = false;
        loadVrmModel(function (ok) {
            vrmLoading = false;
            if (!ok) {
                vrmFailed = true;
                if (!rig.group) buildProceduralRig();
            }
            if (wantedModel !== "vrm") {
                activatePanda();
                return;
            }
            hideAllAvatars();
            if (ok && vtuber.root) {
                vtuber.root.visible = true;
                if (gridHelper) gridHelper.scale.setScalar(vtuber.gridScale || 1);
                applyVrmCamera();
                MODE = "vrm";
            } else if (rig.group) {
                rig.group.visible = true;
                MODE = "procedural";
            }
            $("avatarLoading").hidden = true;
        });
    }

    function animate(tick) {
        var t = tick / 1000;
        var dt = Math.min(0.05, t - last || 0.016);
        last = t;
        if (MODE === "panda" && pandaAvatar) {
            mouthPulse = Math.max(0, mouthPulse - dt * 3);
            pandaAvatar.update(t, dt, {
                voiceActive: voiceActive(),
                mouthPulse: mouthPulse,
                pointerNX: pointerNX,
                pointerNY: pointerNY,
                thinking: thinking
            });
        } else if (MODE === "vrm") updateVrm(t, dt);
        else if (MODE === "procedural") updateProcedural(t);
        if (renderer) renderer.render(scene, camera);
        requestAnimationFrame(animate);
    }

    // ---------- 语音朗读（Web Speech API，离线零依赖） ----------
    var tts = {
        on: localStorage.getItem("avatarTtsOn") !== "0",
        supported: typeof window.speechSynthesis !== "undefined",
        speaking: false,
        queue: [],
        buf: "",
        voice: null
    };

    function pickVoice() {
        if (!tts.supported) return;
        var vs = window.speechSynthesis.getVoices();
        if (!vs.length) return;
        var pref = ["Xiaoxiao", "XiaoYi", "Huihui", "Yaoyao", "Kangkang", "Google 普通话"];
        for (var i = 0; i < pref.length; i++) {
            for (var j = 0; j < vs.length; j++) {
                if (vs[j].name.indexOf(pref[i]) !== -1) { tts.voice = vs[j]; return; }
            }
        }
        tts.voice = vs.filter(function (v) { return (v.lang || "").toLowerCase().indexOf("zh") === 0; })[0] || null;
    }
    if (tts.supported) {
        pickVoice();
        window.speechSynthesis.onvoiceschanged = pickVoice;
    }

    function cleanSentence(s) {
        return String(s).replace(/[#*`>_~\[\]()]/g, " ").replace(/\s+/g, " ").trim();
    }

    function ttsPump() {
        if (!tts.on || !tts.supported || tts.speaking || !tts.queue.length) return;
        var text = tts.queue.shift();
        var u = new SpeechSynthesisUtterance(text);
        u.lang = "zh-CN";
        u.rate = 1.08;
        u.pitch = 1.15;
        if (tts.voice) u.voice = tts.voice;
        u.onstart = function () { tts.speaking = true; };
        u.onend = u.onerror = function () {
            tts.speaking = false;
            setTimeout(ttsPump, 120);
        };
        window.speechSynthesis.speak(u);
    }

    // 流式增量按句切分入队（。！？；\n 断句）
    function ttsFeed(chunk) {
        if (!tts.on) return;
        tts.buf += chunk;
        var parts = tts.buf.split(/(?=[。！？!?；;\n])/);
        tts.buf = parts.pop() || "";
        parts.forEach(function (p) {
            var c = cleanSentence(p);
            if (c.length >= 2 && c.length <= 220) tts.queue.push(c);
            else if (c.length > 220) tts.queue.push(c.slice(0, 220));
        });
        ttsPump();
    }

    function ttsFlush() {
        var c = cleanSentence(tts.buf);
        tts.buf = "";
        if (c.length >= 2) { tts.queue.push(c); ttsPump(); }
    }

    function ttsStopAll() {
        tts.queue = [];
        tts.buf = "";
        if (tts.supported) window.speechSynthesis.cancel();
        tts.speaking = false;
    }

    function renderTtsBtn() {
        var btn = $("avatarTtsBtn");
        if (!btn) return;
        var icon = btn.querySelector("i");
        // 仓内 FontAwesome 为 v5：fa-volume-high/xmark 是 v6 类名会渲染空白
        icon.className = tts.on ? "fas fa-volume-up" : "fas fa-volume-mute";
        btn.title = tts.on ? "语音朗读：开（点击关闭）" : "语音朗读：关（点击开启）";
        btn.setAttribute("aria-label", btn.title);
    }

    function bindTtsToggle() {
        var btn = $("avatarTtsBtn");
        if (!btn) return;
        if (!tts.supported) { btn.disabled = true; btn.title = "当前浏览器不支持语音朗读"; renderTtsBtn(); return; }
        renderTtsBtn();
        btn.addEventListener("click", function () {
            tts.on = !tts.on;
            localStorage.setItem("avatarTtsOn", tts.on ? "1" : "0");
            if (!tts.on) ttsStopAll(); else ttsPump();
            renderTtsBtn();
        });
    }

    // ---------- 对话（复用 /api/chat SSE 契约） ----------
    var captionEl = null;
    var reasonEl = null;   // 推理流合并到同一行，避免每个增量碎片刷一行

    // SSE 事件 data 形态兼容：旧纯串/新对象（{text}/{message}/{name}）统一抽成可读串
    function frameText(data, key) {
        if (data && typeof data === "object") {
            if (key && data[key] != null) return String(data[key]);
            if (data.text != null) return String(data.text);
            if (data.message != null) return String(data.message);
            return JSON.stringify(data);
        }
        return String(data);
    }

    function handleFrame(frame) {
        var event = frame.event, data = frame.data;
        if (event === "notice") {
            appendCaption("系统", frameText(data), "");
        } else if (event === "tool") {
            appendCaption("工具", frameText(data, "name"), "");
        } else if (event === "reasoning") {
            if (!reasonEl || !reasonEl.parentNode) reasonEl = appendCaption("思考", "", "");
            reasonEl.textContent += frameText(data);
            $("captionBody").scrollTop = $("captionBody").scrollHeight;
            thinking = true;
        } else if (event === "assistant") {
            reasonEl = null;
            var nm = (data && typeof data === "object" && data.name) ? data.name : "数字助理";
            $("avatarAssistant").textContent = nm + " · 数字人";
            thinking = false;
        } else if (event === "delta") {
            reasonEl = null;
            var text = typeof data === "string" ? data : (data && data.text != null ? String(data.text) : String(data));
            gotDelta = true;
            if (!captionEl || !captionEl.parentNode) captionEl = appendCaption("助手", "", "is-assistant");
            captionEl.textContent += text;
            $("captionBody").scrollTop = $("captionBody").scrollHeight;
            mouthPulse = 1;               // 文字节奏兜底驱动口型（TTS 关闭时也张嘴）
            ttsFeed(text);                // 语音：按句排队朗读
        } else if (event === "error") {
            thinking = false;
            appendCaption("错误", frameText(data, "message"), "is-error");
        } else if (event === "done") {
            thinking = false;
            captionEl = null;
            reasonEl = null;
        }
    }

    function sendMessage(text) {
        if (streaming) return;
        streaming = true;
        gotDelta = false;
        captionEl = appendCaption("我", text, "is-user");
        $("avatarSend").disabled = true;

        // /api/chat 基线契约：JSON 请求体（与 chat.js 同口径），form 编码会被 400 拒收
        fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Xsrftoken": xsrfToken()
            },
            body: JSON.stringify({ message: text, session_id: SESSION_ID }),
            credentials: "same-origin"
        }).then(function (resp) {
            if (resp.status === 401) { location.href = "/auth/login"; return null; }
            if (!resp.ok || !resp.body) {
                return resp.text().then(function (t) {
                    var msg = t;
                    try {
                        var j = JSON.parse(t);
                        msg = j.detail || j.error || t;
                    } catch (e) {}
                    appendCaption("错误", String(msg), "is-error");
                    return null;
                });
            }
            var reader = resp.body.getReader(), td = new TextDecoder(), bufStr = "";
            function step() {
                return reader.read().then(function (r) {
                    if (r.done) return;
                    bufStr += td.decode(r.value, { stream: true });
                    var blocks = bufStr.split("\n\n");
                    bufStr = blocks.pop();
                    blocks.forEach(function (b) {
                        var f = parseSseBlock(b);
                        if (f) handleFrame(f);
                    });
                    return step();
                });
            }
            return step();
        }).catch(function (err) {
            appendCaption("错误", String(err), "is-error");
        }).then(function () {
            if (!gotDelta) captionEl = null;
            ttsFlush();
            $("avatarInput").focus();
            streaming = false;
            $("avatarSend").disabled = false;
        });
    }

    // ---------- 事件绑定 ----------
    function bindEvents() {
        $("avatarSend").addEventListener("click", function () {
            var text = $("avatarInput").value.trim();
            if (!text) { $("avatarInput").focus(); return; }
            $("avatarInput").value = "";
            sendMessage(text);
        });
        $("avatarInput").addEventListener("keydown", function (e) {
            if (e.key === "Enter" && !e.isComposing && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                $("avatarSend").click();
            }
        });
        bindTtsToggle();
        var switcher = $("avatarSwitcher");
        if (switcher) {
            switcher.addEventListener("click", function (e) {
                var btn = e.target.closest("[data-avatar-model]");
                if (!btn) return;
                switchAvatarModel(btn.getAttribute("data-avatar-model"));
            });
        }
        var quickBar = $("avatarQuickBar");
        if (quickBar) {
            quickBar.addEventListener("click", function (e) {
                var chip = e.target.closest && e.target.closest(".avatar-quick-chip");
                if (!chip || streaming) return;
                var q = chip.getAttribute("data-q");
                if (q) sendMessage(q);
            });
        }
        $("avatarInput").focus();
    }

    // ---------- 启动 ----------
    function boot() {
        if (!initRenderer()) {              // WebGL 失败：纯文字降级
            $("avatarFallback").hidden = false;
            $("avatarLoading").hidden = true;
            bindEvents();
            return;
        }
        var initialModel = "cwnu-panda";
        try {
            var saved = localStorage.getItem(MODEL_CHOICE_KEY);
            if (saved === "vrm" || saved === "cwnu-panda") initialModel = saved;
        } catch (e) {}
        switchAvatarModel(initialModel);
        requestAnimationFrame(animate);
        bindEvents();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
