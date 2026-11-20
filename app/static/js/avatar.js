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

    // 与对话大厅保持一致的 Markdown 子集；先转义原始 HTML。
    // 占位符使用不可见控制字符包裹，避免与正文内容冲突
    var PH_CODE = "\u0000CODE", PH_ICODE = "\u0000ICODE", PH_TABLE = "\u0000TABLE";

    function formatInline(src) {
        return src
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
            .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }

    function splitTableRow(line, escaped) {
        var row = line.trim().replace(/\|\\$/, "|");
        if (escaped) row = row.replace(/\\\|/g, "|");
        var cells = row.split(/(?<!\\)\|/);
        if (cells.length === 1) return null;
        if (cells[0] === "") cells.shift();
        if (cells[cells.length - 1] === "") cells.pop();
        return cells.map(function (cell) { return cell.trim().replace(/\\\|/g, "|"); });
    }

    function extractTables(src, tables) {
        var lines = src.split("\n");
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var escaped = /^\s*\\\|/.test(lines[i]);
            var headers = splitTableRow(lines[i], escaped);
            var rules = i + 1 < lines.length ? splitTableRow(lines[i + 1], escaped) : null;
            if (!headers || !headers.length || !rules || headers.length !== rules.length ||
                !rules.every(function (rule) { return /^:?-{3,}:?$/.test(rule); })) {
                out.push(lines[i]);
                continue;
            }
            var align = rules.map(function (rule) {
                if (!rule.endsWith(":")) return "";
                return rule.startsWith(":") ? ' class="is-center"' : ' class="is-right"';
            });
            var head = headers.map(function (cell, column) {
                return '<th scope="col"' + align[column] + ">" + formatInline(cell) + "</th>";
            }).join("");
            var body = [];
            i += 1;
            while (i + 1 < lines.length) {
                var cells = splitTableRow(lines[i + 1], escaped);
                if (!cells || cells.length !== headers.length) break;
                body.push("<tr>" + cells.map(function (cell, column) {
                    return "<td" + align[column] + ">" + formatInline(cell) + "</td>";
                }).join("") + "</tr>");
                i += 1;
            }
            tables.push('<div class="chat-table-scroll"><table><thead><tr>' + head +
                "</tr></thead><tbody>" + body.join("") + "</tbody></table></div>");
            out.push("", PH_TABLE + (tables.length - 1) + "\u0000", "");
        }
        return out.join("\n");
    }

    // ---------- 轻量 Markdown 渲染 ----------
    function renderMarkdown(src) {
        if (src == null) return "";
        src = String(src).replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
        var codeBlocks = [], inlineCodes = [], tables = [];

        // 1. 先抽出围栏代码块 ```lang\n...\n```
        src = String(src).replace(/```(\w*)\r?\n?([\s\S]*?)```/g, function (m, lang, code) {
            codeBlocks.push(
                '<pre class="chat-code"><code>' +
                esc(code.replace(/\s+$/, "")) +
                "</code></pre>"
            );
            return PH_CODE + (codeBlocks.length - 1) + "\u0000";
        });

        // 2. 其余正文统一转义
        src = esc(src);

        // 3. 抽出行内代码 `code`
        src = src.replace(/`([^`\n]+)`/g, function (m, c) {
            inlineCodes.push('<code class="chat-icode">' + c + "</code>");
            return PH_ICODE + (inlineCodes.length - 1) + "\u0000";
        });

        src = extractTables(src, tables);

        // 4. 标题与引用各自成块，保留前后正文的段落结构。
        src = src
            .replace(/^(?:[ \t]{0,3}\\?&gt;[^\n]*(?:\n|$))+/gm, function (quote) {
                var lines = quote.replace(/\n$/, "").split("\n").map(function (line) {
                    return line.replace(/^[ \t]{0,3}\\?&gt;[ \t]?/, "");
                });
                var paragraphs = lines.join("\n").split(/\n{2,}/).map(function (part) {
                    return part ? "<p>" + part.replace(/\n/g, "<br>") + "</p>" : "";
                });
                return "\n\n<blockquote>" + paragraphs.join("") + "</blockquote>\n\n";
            })
            .replace(/^[ \t]{0,3}(#{1,6})[ \t]+(.+)$/gm, function (line, hashes, title) {
                var level = Math.min(6, hashes.length + 1);
                return "\n\n<h" + level + ">" + title + "</h" + level + ">\n\n";
            });

        // 5. 行内样式：加粗、斜体、链接
        src = formatInline(src);

        // 6. 列表
        src = processLists(src);

        // 6.5 分隔线：整行 --- / *** / ___
        src = src.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "\n\n<hr>\n\n");

        // 7. 段落：按空行分段，段内换行转 <br>
        src = src.split(/\n{2,}/).map(function (block) {
            var t = block.trim();
            if (!t) return "";
            if (t.indexOf(PH_TABLE) === 0) return t;
            if (/^<(h[2-6]|hr|ul|ol|pre|blockquote)\b/.test(t)) return t;
            if (t.indexOf(PH_CODE) !== -1) return block;
            return "<p>" + block.replace(/\n/g, "<br>") + "</p>";
        }).join("");

        // 8. 还原占位符
        src = src.replace(new RegExp(PH_TABLE + "(\\d+)\\u0000", "g"), function (m, i) { return tables[+i]; });
        src = src.replace(new RegExp(PH_ICODE + "(\\d+)\\u0000", "g"), function (m, i) { return inlineCodes[+i]; });
        src = src.replace(new RegExp(PH_CODE + "(\\d+)\\u0000", "g"), function (m, i) { return codeBlocks[+i]; });
        return src;
    }

    function processLists(src) {
        var lines = src.split("\n");
        var out = [], listType = null;
        function closeList() {
            if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>", ""); listType = null; }
        }
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            var ul = ln.match(/^\s*[-*]\s+(.*)$/);
            var ol = ln.match(/^\s*\d+\.\s+(.*)$/);
            if (ul) {
                if (listType !== "ul") { closeList(); out.push("", "<ul>"); listType = "ul"; }
                out.push("<li>" + ul[1] + "</li>");
            } else if (ol) {
                if (listType !== "ol") { closeList(); out.push("", "<ol>"); listType = "ol"; }
                out.push("<li>" + ol[1] + "</li>");
            } else {
                closeList();
                out.push(ln);
            }
        }
        closeList();
        return out.join("\n");
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
    var captionFollowLatest = true;

    function bindCaptionScroll() {
        var body = $("captionBody");
        body.addEventListener("scroll", function () {
            captionFollowLatest = body.scrollHeight - body.clientHeight - body.scrollTop <= 8;
        }, { passive: true });
    }

    function scrollCaptionToLatest() {
        if (!captionFollowLatest) return;
        var body = $("captionBody");
        body.scrollTop = body.scrollHeight;
    }

    function clearCaptionEmpty() {
        var empty = $("captionBody").querySelector(".avatar-caption-empty");
        if (empty) $("captionBody").innerHTML = "";
    }

    function appendCaption(who, text, cls) {
        clearCaptionEmpty();
        var row = document.createElement("div");
        row.className = "avatar-cap-line " + (cls || "");
        var label = document.createElement("b");
        label.textContent = who;
        var content = document.createElement("div");
        content.className = "avatar-cap-content";
        content.textContent = text;
        row.appendChild(label);
        row.appendChild(content);
        $("captionBody").appendChild(row);
        scrollCaptionToLatest();
        return content;
    }

    // ---------- three.js 场景 ----------
    var scene, camera, renderer, gridHelper, ambientLight, keyLight;
    var MODE = "none";              // panda | vrm | procedural
    var MODEL_CHOICE_KEY = "campusagent.avatar.model";
    var LEGACY_MODEL_CHOICE_KEY = "govcheck.avatar.model";
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
        function updateStageDrag(clientX, clientY) {
            var r = stage.getBoundingClientRect();
            pointerNX = ((clientX - r.left) / r.width - 0.5) * 2;
            pointerNY = ((clientY - r.top) / r.height - 0.5) * 2;
            if (dragging && MODE === "panda" && pandaAvatar) {
                var dx = clientX - dragLastX;
                dragLastX = clientX;
                pandaAvatar.addYaw(dx * 0.008);
            }
        }
        function stopStageDrag() { dragging = false; }

        if (window.PointerEvent) {
            stage.addEventListener("pointermove", function (e) {
                updateStageDrag(e.clientX, e.clientY);
            });
            stage.addEventListener("pointerdown", function (e) {
                if (e.pointerType === "mouse" && e.button !== 0) return;
                if (e.target && e.target.closest && e.target.closest(".avatar-stage-actions")) return;
                dragging = true;
                dragLastX = e.clientX;
                if (stage.setPointerCapture) {
                    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
                }
            });
            window.addEventListener("pointerup", stopStageDrag);
            window.addEventListener("pointercancel", stopStageDrag);
        } else {
            stage.addEventListener("mousemove", function (e) {
                updateStageDrag(e.clientX, e.clientY);
            });
            stage.addEventListener("mousedown", function (e) {
                if (e.button !== 0) return;
                if (e.target && e.target.closest && e.target.closest(".avatar-stage-actions")) return;
                dragging = true;
                dragLastX = e.clientX;
            });
            window.addEventListener("mouseup", stopStageDrag);
        }
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
        return !tts.paused && (tts.speaking || mouthPulse > 0.02);
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
            ? "西华师范大学 · 华小竹（拖拽旋转视角，双击复位）"
            : "虚拟主播 · VRM 实时驱动";
        var bar = $("avatarGestureBar");
        if (bar) bar.hidden = kind !== "cwnu-panda";
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
        syncPandaPersona(selectedAgent);
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
        on: true,
        supported: typeof window.speechSynthesis !== "undefined",
        speaking: false,
        paused: false,
        current: null,
        generation: 0,
        queue: [],
        buf: "",
        voice: null
    };

    // 固定华小竹音色，不读取此前声音选择缓存。
    function pickVoice() {
        if (!tts.supported) return;
        var vs = window.speechSynthesis.getVoices();
        tts.voice = vs.find(function (v) {
            return /yunyang/i.test(v.name) && /^zh/i.test(v.lang || "");
        }) || vs.find(function (v) {
            return /^zh-CN$/i.test(v.lang || "");
        }) || null;
    }
    if (tts.supported) {
        window.speechSynthesis.addEventListener("voiceschanged", pickVoice);
    }

    function cleanSentence(s) {
        return String(s).replace(/[#*`>_~\[\]()]/g, " ").replace(/\s+/g, " ").trim();
    }

    function renderPlaybackControls() {
        var btn = $("avatarPlaybackBtn");
        if (!btn) return;
        var hasText = !!(answerText && answerText.trim());
        var active = tts.on && (tts.current || tts.queue.length || (streaming && hasText));
        var label = tts.paused ? "继续播放" : (active ? "暂停" : "从头播放");
        var icon = !tts.paused && active ? "pause" : "play";
        btn.innerHTML = '<i class="fas fa-' + icon + '" aria-hidden="true"></i><span>' + label + '</span>';
        btn.disabled = !tts.supported || !hasText;
        btn.setAttribute("aria-label", label + "当前回答");
        btn.title = tts.supported ? label + "当前回答" : "当前浏览器不支持语音朗读";
        var restart = $("avatarRestartBtn");
        if (restart) {
            restart.hidden = !tts.paused;
            restart.disabled = !tts.supported || !hasText;
        }
    }

    function ttsPump() {
        if (!tts.on || !tts.supported || tts.paused || tts.speaking || !tts.queue.length) {
            renderPlaybackControls();
            return;
        }
        var text = tts.queue.shift();
        var u = new SpeechSynthesisUtterance(text);
        var generation = tts.generation;
        u.lang = tts.voice ? tts.voice.lang : "zh-CN";
        u.rate = 1.0;
        u.pitch = 1.0;
        if (tts.voice) u.voice = tts.voice;
        // Reserve the utterance before onstart, so streaming chunks cannot enqueue duplicates.
        tts.current = u;
        tts.speaking = true;
        u.onstart = function () {
            if (generation !== tts.generation) return;
            if (tts.paused) window.speechSynthesis.pause();
            renderPlaybackControls();
        };
        u.onboundary = function () {
            if (generation !== tts.generation) return;
            mouthPulse = Math.max(mouthPulse, 0.92);
        };
        u.onend = u.onerror = function () {
            if (generation !== tts.generation) return;
            tts.current = null;
            tts.speaking = false;
            renderPlaybackControls();
            setTimeout(function () {
                if (generation === tts.generation) ttsPump();
            }, 120);
        };
        window.speechSynthesis.speak(u);
        renderPlaybackControls();
    }

    // Keep receiving text while paused; only audio playback is suspended.
    function ttsFeed(chunk) {
        if (!tts.on || !tts.supported) return;
        tts.buf += chunk;
        var parts = tts.buf.split(/(?<=[。！？!?；;\n])/);
        tts.buf = /[。！？!?；;\n]$/.test(tts.buf) ? "" : (parts.pop() || "");
        parts.forEach(queueSentence);
        ttsPump();
    }

    function queueSentence(text) {
        var cleaned = cleanSentence(text);
        // Long paragraphs are split instead of silently dropping their tail.
        while (cleaned.length) {
            tts.queue.push(cleaned.slice(0, 220));
            cleaned = cleaned.slice(220);
        }
    }

    function ttsFlush() {
        if (!tts.on || !tts.supported) return;
        queueSentence(tts.buf);
        tts.buf = "";
        ttsPump();
    }

    function ttsStopAll() {
        tts.generation += 1;
        tts.queue = [];
        tts.buf = "";
        tts.current = null;
        tts.paused = false;
        tts.speaking = false;
        if (tts.supported) {
            window.speechSynthesis.cancel();
            window.speechSynthesis.resume();
        }
        renderPlaybackControls();
    }

    function replayAnswer() {
        if (!tts.supported || !answerText) return;
        ttsStopAll();
        tts.on = true;
        ttsFeed(answerText);
        ttsFlush();
    }

    function bindPlaybackControls() {
        var btn = $("avatarPlaybackBtn");
        if (!btn) return;
        btn.addEventListener("click", function () {
            if (tts.paused) {
                tts.paused = false;
                window.speechSynthesis.resume();
                ttsPump();
            } else if (tts.on && (tts.current || tts.queue.length || (streaming && answerText))) {
                tts.paused = true;
                window.speechSynthesis.pause();
            } else {
                replayAnswer();
            }
            renderPlaybackControls();
        });
        $("avatarRestartBtn").addEventListener("click", replayAnswer);
        renderPlaybackControls();
    }

    // Agent selection shares the chat hall's enabled-employee API and saved preference.
    var agentList = [];
    var selectedAgent = null;
    var agentBusy = false;

    function renderAgentSelect(message) {
        var select = $("avatarAgentSelect");
        if (!select) return;
        select.replaceChildren();
        if (!agentList.length) {
            var empty = document.createElement("option");
            empty.value = "";
            empty.textContent = message || "暂无可用 Agent";
            select.appendChild(empty);
        }
        agentList.forEach(function (agent) {
            var option = document.createElement("option");
            option.value = String(agent.id);
            option.textContent = agent.name;
            select.appendChild(option);
        });
        if (selectedAgent) select.value = String(selectedAgent.id);
        select.title = selectedAgent ? (selectedAgent.description || selectedAgent.name) : "选择对话 Agent";
        select.disabled = streaming || agentBusy || !agentList.length;
        $("avatarSend").disabled = streaming || agentBusy;
        renderAgentMenu(message);
    }

    function closeAgentMenu() {
        var menu = $("avatarAgentMenu"), trigger = $("avatarAgentTrigger");
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
    }

    function renderAgentMenu(message) {
        var menu = $("avatarAgentMenu"), trigger = $("avatarAgentTrigger");
        if (!menu || !trigger) return;
        trigger.disabled = streaming || agentBusy || !agentList.length;
        $("avatarAgentCurrent").textContent = selectedAgent ? selectedAgent.name : (message || "选择 Agent");
        trigger.title = selectedAgent ? (selectedAgent.description || selectedAgent.name) : (message || "选择 Agent");
        if (trigger.disabled) closeAgentMenu();
        menu.replaceChildren();
        agentList.forEach(function (agent) {
            var active = !!selectedAgent && Number(selectedAgent.id) === Number(agent.id);
            var option = document.createElement("button");
            option.type = "button";
            option.className = "avatar-agent-option" + (active ? " is-selected" : "");
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", active ? "true" : "false");
            option.tabIndex = -1;
            var icon = document.createElement("span");
            icon.className = "avatar-agent-option-icon";
            icon.innerHTML = '<i class="fas fa-robot" aria-hidden="true"></i>';
            var info = document.createElement("span");
            info.className = "avatar-agent-option-info";
            var name = document.createElement("strong");
            name.textContent = agent.name;
            var description = document.createElement("span");
            description.textContent = agent.description || "切换到此 Agent 对话";
            info.appendChild(name);
            info.appendChild(description);
            option.appendChild(icon);
            option.appendChild(info);
            var check = document.createElement("span");
            check.className = "avatar-agent-option-check";
            check.innerHTML = active ? '<i class="fas fa-check" aria-hidden="true"></i>' : "";
            option.appendChild(check);
            option.addEventListener("click", function () {
                closeAgentMenu();
                trigger.focus();
                if (!active) selectAgent(agent.id);
            });
            menu.appendChild(option);
        });
    }

    function openAgentMenu(focusOption) {
        var trigger = $("avatarAgentTrigger"), menu = $("avatarAgentMenu");
        if (!trigger || trigger.disabled) return;
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        if (focusOption) {
            var option = menu.querySelector('[aria-selected="true"]') || menu.querySelector('[role="option"]');
            if (option) option.focus();
        }
    }

    async function agentRequest(url, options) {
        var response = await fetch(url, Object.assign({ credentials: "same-origin" }, options));
        if (response.status === 401) {
            location.href = "/auth/login";
            throw new Error("请先登录");
        }
        var data = await response.json();
        if (!response.ok || data.ok === false) throw new Error(data.detail || data.error || "Agent 操作失败");
        return data;
    }

    function syncPandaPersona(agent) {
        if (!pandaAvatar || !pandaAvatar.setPersona) return;
        var name = (agent && agent.name) ? String(agent.name) : "";
        var key = "default";
        if (name.indexOf("心理") !== -1) key = "mental";
        else if (name.indexOf("就业") !== -1) key = "career";
        pandaAvatar.setPersona(key);
    }

    function triggerPandaAction(kind, duration) {
        if (MODE === "panda" && pandaAvatar && pandaAvatar.triggerGesture) {
            pandaAvatar.triggerGesture(kind, duration);
        }
    }

    async function loadAgents() {
        agentBusy = true;
        renderAgentSelect("加载中…");
        var errorMessage = "";
        try {
            var data = await agentRequest("/api/assistants");
            agentList = data.list || [];
            selectedAgent = data.selected && data.selected.id ? data.selected : null;
            if (selectedAgent) {
                assistantName = selectedAgent.name;
                $("avatarAssistant").textContent = assistantName + " · 数字人";
                syncPandaPersona(selectedAgent);
            }
        } catch (err) {
            errorMessage = "加载失败，请刷新重试";
        } finally {
            agentBusy = false;
            renderAgentSelect(errorMessage);
        }
    }

    async function selectAgent(id) {
        if (streaming || agentBusy) { renderAgentSelect(); return; }
        agentBusy = true;
        renderAgentSelect();
        try {
            var data = await agentRequest("/api/assistants/select", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Xsrftoken": xsrfToken() },
                body: JSON.stringify({ employee_id: Number(id) })
            });
            selectedAgent = data.selected && data.selected.id ? data.selected : null;
            assistantName = selectedAgent ? selectedAgent.name : "数字助理";
            $("avatarAssistant").textContent = assistantName + " · 数字人";
            syncPandaPersona(selectedAgent);
            triggerPandaAction("wave", 1.5);
        } catch (err) {
            appendCaption("系统", "切换 Agent 失败：" + err.message, "is-error");
        } finally {
            agentBusy = false;
            renderAgentSelect();
        }
    }

    function bindAgentSelect() {
        var select = $("avatarAgentSelect");
        if (!select) return;
        select.addEventListener("change", function () { selectAgent(select.value); });
        var trigger = $("avatarAgentTrigger"), menu = $("avatarAgentMenu"), picker = $("avatarAgentPicker");
        if (trigger && menu) {
            trigger.addEventListener("click", function () {
                if (menu.hidden) openAgentMenu(false); else closeAgentMenu();
            });
            trigger.addEventListener("keydown", function (event) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault(); openAgentMenu(true);
                }
            });
            menu.addEventListener("keydown", function (event) {
                var options = Array.from(menu.querySelectorAll('[role="option"]'));
                var index = options.indexOf(document.activeElement);
                var next = index;
                if (event.key === "ArrowDown") next = (index + 1) % options.length;
                else if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = options.length - 1;
                else return;
                event.preventDefault();
                if (options[next]) options[next].focus();
            });
            document.addEventListener("click", function (event) {
                if (!picker.contains(event.target)) closeAgentMenu();
            });
            document.addEventListener("keydown", function (event) {
                if (event.key === "Escape" && !menu.hidden) {
                    closeAgentMenu(); trigger.focus();
                } else if (event.key === "Tab") closeAgentMenu();
            });
        }
        loadAgents();
    }

    // ---------- 对话（复用 /api/chat SSE 契约） ----------
    var captionEl = null;
    var processPanel = null;
    var answerText = "";
    var assistantName = "华小竹";

    function ensureProcessPanel() {
        if (processPanel) return processPanel;
        clearCaptionEmpty();
        var drawer = document.createElement("details");
        drawer.className = "avatar-process";
        drawer.open = !gotDelta;
        var summary = document.createElement("summary");
        var body = document.createElement("div");
        body.className = "avatar-process-body";
        drawer.appendChild(summary);
        drawer.appendChild(body);
        // Late tool events still belong to this answer's process drawer.
        if (captionEl && captionEl.parentNode) {
            $("captionBody").insertBefore(drawer, captionEl.parentNode);
        } else {
            $("captionBody").appendChild(drawer);
        }
        processPanel = { drawer: drawer, summary: summary, body: body,
            reason: null, tools: 0, finished: gotDelta };
        updateProcessSummary();
        return processPanel;
    }

    function updateProcessSummary() {
        if (!processPanel) return;
        var parts = [processPanel.finished ? "执行过程" : "正在思考 / 调用工具"];
        if (processPanel.reason) parts.push("思考记录");
        if (processPanel.tools) parts.push(processPanel.tools + " 次工具调用");
        processPanel.summary.textContent = parts.join(" · ");
    }

    function appendProcessItem(label, text, cls) {
        var panel = ensureProcessPanel();
        var item = document.createElement("div");
        item.className = "avatar-process-item " + cls;
        var heading = document.createElement("b");
        heading.textContent = label;
        var content = document.createElement("div");
        content.className = "avatar-process-text";
        content.textContent = text;
        item.appendChild(heading);
        item.appendChild(content);
        panel.body.appendChild(item);
        return content;
    }

    function finishProcess() {
        // Collapse once, so users can reopen it while the answer is streaming.
        if (processPanel && !processPanel.finished) {
            processPanel.finished = true;
            processPanel.drawer.open = false;
            updateProcessSummary();
        }
        thinking = false;
    }

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

    function renderSourcesDrawer(items) {
        if (!Array.isArray(items) || !items.length) return;
        clearCaptionEmpty();
        var drawer = document.createElement("details");
        drawer.className = "avatar-sources";
        var summary = document.createElement("summary");
        summary.textContent = "参考来源 · " + items.length + " 篇知识库文档";
        var body = document.createElement("div");
        body.className = "avatar-sources-body";
        items.forEach(function (src) {
            if (!src) return;
            var item = document.createElement("div");
            item.className = "avatar-source-item";
            var title = document.createElement("b");
            var scoreTxt = (typeof src.score === "number" && src.score > 0)
                ? ("（相关度 " + Math.min(99, Math.round(src.score * 100)) + "%）") : "";
            title.textContent = (src.title || "知识库文档") + scoreTxt;
            item.appendChild(title);
            if (src.excerpt) {
                var excerpt = document.createElement("div");
                excerpt.className = "avatar-source-excerpt";
                excerpt.textContent = src.excerpt;
                item.appendChild(excerpt);
            }
            body.appendChild(item);
        });
        drawer.appendChild(summary);
        drawer.appendChild(body);
        $("captionBody").appendChild(drawer);
        scrollCaptionToLatest();
    }

    function handleFrame(frame) {
        var event = frame.event, data = frame.data;
        if (event === "notice") {
            appendCaption("系统", frameText(data), "");
        } else if (event === "sources") {
            renderSourcesDrawer((data && data.items) || []);
            triggerPandaAction("book", 2.0);
        } else if (event === "tool") {
            var panel = ensureProcessPanel();
            var args = data && typeof data === "object" ? data.arguments : null;
            var detail = args == null ? "" : (typeof args === "string" ? args : JSON.stringify(args, null, 2));
            appendProcessItem("工具：" + frameText(data, "name"), detail, "is-tool");
            panel.tools += 1;
            updateProcessSummary();
            scrollCaptionToLatest();
            triggerPandaAction("book", 1.8);
        } else if (event === "reasoning") {
            var process = ensureProcessPanel();
            if (!process.reason) process.reason = appendProcessItem("思考过程", "", "is-reasoning");
            process.reason.textContent += frameText(data);
            updateProcessSummary();
            scrollCaptionToLatest();
            thinking = !process.finished;
        } else if (event === "assistant") {
            var nm = (data && typeof data === "object" && data.name) ? data.name : "数字助理";
            assistantName = nm;
            if (data && data.id) {
                selectedAgent = data;
                renderAgentSelect();
            }
            $("avatarAssistant").textContent = nm + " · 数字人";
            syncPandaPersona(data && typeof data === "object" ? data : { name: nm });
        } else if (event === "delta") {
            finishProcess();
            var text = frameText(data);
            gotDelta = true;
            if (!captionEl || !captionEl.parentNode) captionEl = appendCaption(assistantName, "", "is-assistant");
            answerText += text;
            captionEl.innerHTML = renderMarkdown(answerText);
            scrollCaptionToLatest();
            mouthPulse = 1;               // 文字节奏兜底驱动口型（TTS 关闭时也张嘴）
            ttsFeed(text);                // 语音：按句排队朗读
        } else if (event === "error") {
            finishProcess();
            appendCaption("错误", frameText(data, "message"), "is-error");
        } else if (event === "done") {
            finishProcess();
            captionEl = null;
            if (/奖学金|恭喜|祝贺|太棒|加油/.test(answerText)) {
                triggerPandaAction("celebrate", 1.9);
            } else if (answerText) {
                triggerPandaAction("nod", 1.2);
            }
        }
    }

    function sendMessage(text) {
        if (streaming || agentBusy) return;
        ttsStopAll();
        streaming = true;
        finishProcess();
        processPanel = null;
        gotDelta = false;
        answerText = "";
        captionEl = null;
        renderPlaybackControls();
        appendCaption("我", text, "is-user");
        if (/你好|嗨|hi|hello|介绍|早安|晚上好/i.test(text)) {
            triggerPandaAction("wave", 1.7);
        }
        thinking = true;
        $("avatarSend").disabled = true;
        renderAgentSelect();

        // /api/chat 基线契约：JSON 请求体（与 chat.js 同口径），form 编码会被 400 拒收
        fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Xsrftoken": xsrfToken()
            },
            body: JSON.stringify({ message: text, session_id: SESSION_ID, employee_id: selectedAgent ? selectedAgent.id : null }),
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
                    if (r.done) {
                        bufStr += td.decode();
                        var tail = parseSseBlock(bufStr);
                        if (tail) handleFrame(tail);
                        return;
                    }
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
            finishProcess();
            captionEl = null;
            streaming = false;
            ttsFlush();
            renderPlaybackControls();
            $("avatarInput").focus();
            $("avatarSend").disabled = false;
            renderAgentSelect();
        });
    }

    // ---------- 语音提问（Web Speech ASR）与舞台互动 ----------
    function setupAvatarAsr() {
        var btn = $("avatarMicBtn");
        if (!btn) return;
        var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Ctor) {
            btn.addEventListener("click", function () {
                appendCaption("系统", "当前浏览器暂不支持语音识别（请使用新版 Chrome / Edge，或直接输入文字提问）。", "");
            });
            return;
        }
        var rec = new Ctor();
        rec.lang = "zh-CN";
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        var listening = false;
        function setListening(on) {
            listening = !!on;
            if (btn.classList) btn.classList.toggle("is-listening", listening);
            btn.title = listening ? "正在聆听…点击停止" : "语音提问（点击开始/停止）";
        }
        rec.onstart = function () { setListening(true); };
        rec.onend = function () { setListening(false); };
        rec.onerror = function (e) {
            setListening(false);
            appendCaption("系统", "语音识别未成功（" + (e && e.error ? e.error : "unknown") + "），请尝试打字输入。", "");
        };
        rec.onresult = function (e) {
            var text = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript) || "";
            text = text.trim();
            if (text && $("avatarInput")) {
                $("avatarInput").value = text;
                if (!streaming && !agentBusy) {
                    $("avatarInput").value = "";
                    sendMessage(text);
                }
            }
        };
        btn.addEventListener("click", function () {
            if (streaming || agentBusy) return;
            if (listening) { rec.stop(); return; }
            ttsStopAll();
            try { rec.start(); } catch (err) {
                appendCaption("系统", "无法启动语音输入：" + err.message, "");
            }
        });
    }

    function bindGestureBar() {
        var bar = $("avatarGestureBar");
        if (!bar) return;
        bar.addEventListener("click", function (e) {
            var btn = e.target.closest ? e.target.closest("[data-gesture]") : null;
            if (!btn || MODE !== "panda" || !pandaAvatar) return;
            var g = btn.getAttribute("data-gesture");
            if (g === "reset") {
                pandaAvatar.resetYaw();
                return;
            }
            if (pandaAvatar.triggerGesture) {
                pandaAvatar.triggerGesture(g);
            }
        });
    }

    // ---------- 事件绑定 ----------
    function bindEvents() {
        bindCaptionScroll();
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
        bindAgentSelect();
        bindPlaybackControls();
        setupAvatarAsr();
        bindGestureBar();
        pickVoice();
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
            var saved = localStorage.getItem(MODEL_CHOICE_KEY) || localStorage.getItem(LEGACY_MODEL_CHOICE_KEY);
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
