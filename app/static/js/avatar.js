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
    var VRM_PRESETS = [
        { id: "vroid-b", label: "VRoid 学院女主播", url: "/static/vendor/three/models/vroid-sample-b.vrm" },
        { id: "classic", label: "经典三渲二主播", url: MODEL_URL }
    ];
    var LIVE2D_MODEL_URL = "/static/vendor/live2d/models/Haru/Haru.model3.json";
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

    // ---------- three.js & Live2D 场景 ----------
    var scene, camera, renderer, gridHelper, ambientLight, hemiLight, keyLight;
    var MODE = "none";              // panda | vrm | live2d | procedural
    var MODEL_CHOICE_KEY = "campusagent.avatar.model";
    var LEGACY_MODEL_CHOICE_KEY = "govcheck.avatar.model";
    var wantedModel = "cwnu-panda";
    var pandaAvatar = null;
    var live2dAvatar = null;
    var live2dLoading = false;
    var live2dFailed = false;
    var activeVrmPresetIndex = 0;
    var vrmCustomUrl = null;
    var vrmCustomLabel = "";
    var vrmLoading = false;
    var vrmReady = false;
    var vrmFailed = false;
    var vrmLoadToken = 0;
    var rig = {};                   // 程序化降级形象
    var vtuber = {
        root: null, faces: [], bones: {}, base: {}, arms: null, gridScale: 1, camPos: null, camLook: null,
        baseYaw: Math.PI, yaw: 0, idx: { a: 32, i: 33, u: 34, e: 35, o: 36, blink: 12, joy: 2 },
        gesture: { kind: null, start: 0, duration: 1.6 }
    };
    var thinking = false;
    var mouthPulse = 0;             // 文字驱动口型的脉冲强度
    var pointerNX = 0, pointerNY = 0; // 鼠标视线 [-1,1]
    var nextBlinkAt = 2, blinkPhase = -1;
    var dragging = false, dragLastX = 0, dragMoved = false;

    // 默认 blendShape 索引（动态 VRM 解析失败时兜底）
    var IDX = { a: 32, i: 33, u: 34, e: 35, o: 36, blink: 12, joy: 2 };

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
        hemiLight = new THREE.HemisphereLight(0xf6f9ff, 0x3a486e, 0.0);
        scene.add(hemiLight);
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
            if (renderer) {
                var w = stage.clientWidth, h = stage.clientHeight;
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
                renderer.setSize(w, h);
            }
            if (live2dAvatar) live2dAvatar.resize();
        });
        function updateStageDrag(clientX, clientY) {
            var r = stage.getBoundingClientRect();
            pointerNX = ((clientX - r.left) / r.width - 0.5) * 2;
            pointerNY = ((clientY - r.top) / r.height - 0.5) * 2;
            if (MODE === "live2d" && live2dAvatar) {
                live2dAvatar.focus(clientX, clientY);
                return;
            }
            if (dragging) {
                var dx = clientX - dragLastX;
                if (Math.abs(dx) > 2) dragMoved = true;
                dragLastX = clientX;
                if (MODE === "panda" && pandaAvatar) {
                    pandaAvatar.addYaw(dx * 0.008);
                } else if (MODE === "vrm" && vtuber.root) {
                    vtuber.yaw = Math.max(-1.4, Math.min(1.4, vtuber.yaw + dx * 0.008));
                }
            }
        }
        function stopStageDrag(e) {
            if (dragging && !dragMoved && MODE === "live2d" && live2dAvatar && e && typeof e.clientX === "number") {
                live2dAvatar.onTap(e.clientX, e.clientY);
            }
            dragging = false;
            dragMoved = false;
        }

        if (window.PointerEvent) {
            stage.addEventListener("pointermove", function (e) {
                updateStageDrag(e.clientX, e.clientY);
            });
            stage.addEventListener("pointerdown", function (e) {
                if (e.pointerType === "mouse" && e.button !== 0) return;
                if (e.target && e.target.closest && e.target.closest(".avatar-stage-actions")) return;
                dragging = true;
                dragMoved = false;
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
                dragMoved = false;
                dragLastX = e.clientX;
            });
            window.addEventListener("mouseup", stopStageDrag);
        }
        stage.addEventListener("dblclick", function () {
            if (MODE === "panda" && pandaAvatar) pandaAvatar.resetYaw();
            else if (MODE === "vrm") vtuber.yaw = 0;
            else if (MODE === "live2d" && live2dAvatar) live2dAvatar.triggerGesture("reset");
        });
        return true;
    }

    // ---------- 通用 Live3D (VRM 0.x / 1.0) 虚拟主播 ----------
    function disposeVrmRoot() {
        if (!vtuber.root) return;
        scene.remove(vtuber.root);
        vtuber.root.traverse(function (obj) {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                mats.forEach(function (m) {
                    if (!m) return;
                    if (m.map) m.map.dispose();
                    m.dispose();
                });
            }
        });
        vtuber.root = null;
        vtuber.faces = [];
        vtuber.bones = {};
        vtuber.base = {};
        vtuber.arms = null;
        vtuber.yaw = 0;
        vrmReady = false;
    }

    function currentVrmTarget() {
        if (vrmCustomUrl) return { label: vrmCustomLabel || "自定义 VRM 皮套", url: vrmCustomUrl };
        return VRM_PRESETS[activeVrmPresetIndex % VRM_PRESETS.length];
    }

    function loadVrmModel(url, onDone) {
        if (typeof url === "function") { onDone = url; url = currentVrmTarget().url; }
        if (!window.THREE || !THREE.GLTFLoader) { onDone(false); return; }
        var token = ++vrmLoadToken;
        var loader = new THREE.GLTFLoader();
        loader.load(url, function (gltf) {
            if (token !== vrmLoadToken) return;
            try {
                disposeVrmRoot();
                setupVrm(gltf);
                onDone(true);
            } catch (e) {
                console.error("VRM setup failed:", e);
                onDone(false);
            }
        }, undefined, function (err) {
            if (token !== vrmLoadToken) return;
            console.error("VRM load failed:", url, err);
            onDone(false);
        });
    }

    // 兼容 Unity Humanoid / VRoid / Mixamo 骨骼命名
    var BONE_ALIASES = {
        head: ["head", "J_Bip_C_Head", "Head"],
        neck: ["neck", "J_Bip_C_Neck", "Neck"],
        chest: ["chest", "J_Bip_C_Chest", "Chest"],
        upperChest: ["upperChest", "J_Bip_C_UpperChest", "UpperChest"],
        spine: ["spine", "J_Bip_C_Spine", "Spine"],
        hips: ["hips", "J_Bip_C_Hips", "Hips"],
        leftUpperArm: ["leftUpperArm", "J_Bip_L_UpperArm", "LeftUpperArm"],
        rightUpperArm: ["rightUpperArm", "J_Bip_R_UpperArm", "RightUpperArm"],
        leftLowerArm: ["leftLowerArm", "J_Bip_L_LowerArm", "LeftLowerArm"],
        rightLowerArm: ["rightLowerArm", "J_Bip_R_LowerArm", "RightLowerArm"],
        leftHand: ["leftHand", "J_Bip_L_Hand", "LeftHand"],
        rightHand: ["rightHand", "J_Bip_R_Hand", "RightHand"],
        leftMiddleProximal: ["leftMiddleProximal", "J_Bip_L_Middle1"],
        rightMiddleProximal: ["rightMiddleProximal", "J_Bip_R_Middle1"],
        leftIndexProximal: ["leftIndexProximal", "J_Bip_L_Index1"],
        rightIndexProximal: ["rightIndexProximal", "J_Bip_R_Index1"],
        leftLittleProximal: ["leftLittleProximal", "J_Bip_L_Little1"],
        rightLittleProximal: ["rightLittleProximal", "J_Bip_R_Little1"]
    };

    function boneCanonical(name) {
        for (var key in BONE_ALIASES) {
            if (BONE_ALIASES[key].indexOf(name) !== -1) return key;
        }
        return null;
    }

    function parseVrmBindings(gltf) {
        var json = (gltf.parser && gltf.parser.json) || {};
        var ext = json.extensions || {};
        var vrm0 = ext.VRM || null;
        var vrm1 = ext.VRMC_vrm || null;
        var idx = { a: -1, i: -1, u: -1, e: -1, o: -1, blink: -1, joy: -1 };
        var boneNodeNames = {};

        // 1. 解析 VRM 0.x blendShapeMaster 与 humanoid 骨骼名
        if (vrm0) {
            var groups = (vrm0.blendShapeMaster && vrm0.blendShapeMaster.blendShapeGroups) || [];
            groups.forEach(function (g) {
                var p = String(g.presetName || g.name || "").toLowerCase();
                var bind = (g.binds && g.binds[0]) || null;
                if (!bind || typeof bind.index !== "number") return;
                if (p === "a") idx.a = bind.index;
                else if (p === "i") idx.i = bind.index;
                else if (p === "u") idx.u = bind.index;
                else if (p === "e") idx.e = bind.index;
                else if (p === "o") idx.o = bind.index;
                else if (p === "blink") idx.blink = bind.index;
                else if (p === "joy" || p === "fun") { if (idx.joy < 0 || p === "joy") idx.joy = bind.index; }
            });
            var hb0 = (vrm0.humanoid && vrm0.humanoid.humanBones) || [];
            hb0.forEach(function (b) {
                var nodeDef = json.nodes && json.nodes[b.node];
                if (nodeDef && nodeDef.name) boneNodeNames[nodeDef.name] = b.bone;
            });
        }

        // 2. 解析 VRM 1.0 expressions 与 humanoid 骨骼名
        if (vrm1) {
            var presets = (vrm1.expressions && vrm1.expressions.preset) || {};
            var map1 = { aa: "a", ih: "i", ou: "u", ee: "e", oh: "o", blink: "blink", happy: "joy" };
            Object.keys(map1).forEach(function (k) {
                var expr = presets[k];
                var bind = expr && expr.morphTargetBinds && expr.morphTargetBinds[0];
                if (bind && typeof bind.index === "number") idx[map1[k]] = bind.index;
            });
            var hb1 = (vrm1.humanoid && vrm1.humanoid.humanBones) || {};
            Object.keys(hb1).forEach(function (boneKey) {
                var nodeIdx = hb1[boneKey] && hb1[boneKey].node;
                var nodeDef = typeof nodeIdx === "number" && json.nodes && json.nodes[nodeIdx];
                if (nodeDef && nodeDef.name) boneNodeNames[nodeDef.name] = boneKey;
            });
        }

        return { idx: idx, boneNodeNames: boneNodeNames, isVrm1: !!vrm1 && !vrm0 };
    }

    function setupVrm(gltf) {
        var root = gltf.scene || gltf;
        var parsed = parseVrmBindings(gltf);
        vtuber.root = root;
        vtuber.faces = [];
        vtuber.bones = {};
        vtuber.base = {};
        vtuber.yaw = 0;
        vtuber.baseYaw = parsed.isVrm1 ? 0 : Math.PI;
        vtuber.gesture = { kind: null, start: 0, duration: 1.6 };

        var resolvedIdx = Object.assign({}, parsed.idx);
        var maxMorphCount = 0;
        var candidateFaces = [];
        root.traverse(function (obj) {
            if (obj.isSkinnedMesh && obj.morphTargetInfluences && obj.morphTargetInfluences.length >= 6) {
                candidateFaces.push(obj);
                if (obj.morphTargetInfluences.length > maxMorphCount) {
                    maxMorphCount = obj.morphTargetInfluences.length;
                }
            }
            if (obj.isBone) {
                var canon = parsed.boneNodeNames[obj.name] || boneCanonical(obj.name);
                if (canon && !vtuber.bones[canon]) vtuber.bones[canon] = obj;
            }
        });

        // 兜底：若扩展里未解析出 morph 索引，则从 morphTargetDictionary 按名称匹配
        if (candidateFaces.length && (resolvedIdx.a < 0 || resolvedIdx.blink < 0)) {
            var dict = candidateFaces[0].morphTargetDictionary || {};
            var keys = Object.keys(dict);
            function findMorph(re) {
                for (var i = 0; i < keys.length; i++) {
                    if (re.test(keys[i])) return dict[keys[i]];
                }
                return -1;
            }
            if (resolvedIdx.a < 0) resolvedIdx.a = findMorph(/mth_a$|vrc\.v_aa|_a$|^aa$|^a$/i);
            if (resolvedIdx.i < 0) resolvedIdx.i = findMorph(/mth_i$|vrc\.v_ih|_i$|^ih$|^i$/i);
            if (resolvedIdx.u < 0) resolvedIdx.u = findMorph(/mth_u$|vrc\.v_ou|_u$|^ou$|^u$/i);
            if (resolvedIdx.e < 0) resolvedIdx.e = findMorph(/mth_e$|vrc\.v_e|_e$|^ee$|^e$/i);
            if (resolvedIdx.o < 0) resolvedIdx.o = findMorph(/mth_o$|vrc\.v_oh|_o$|^oh$|^o$/i);
            if (resolvedIdx.blink < 0) resolvedIdx.blink = findMorph(/eye_close$|blink$|^blink/i);
            if (resolvedIdx.joy < 0) resolvedIdx.joy = findMorph(/all_joy$|joy$|happy$|smile/i);
        }
        // 最后兜底到默认索引（仅当在合法范围内）
        Object.keys(IDX).forEach(function (k) {
            if (resolvedIdx[k] < 0 && IDX[k] < maxMorphCount) resolvedIdx[k] = IDX[k];
        });
        vtuber.idx = resolvedIdx;

        // 收集所有拥有最大 morph 集（脸部各材质 primitive）的 SkinnedMesh，同驱避免五官错位
        var minFaceMorphs = Math.max(6, Math.floor(maxMorphCount * 0.7));
        candidateFaces.forEach(function (mesh) {
            if (mesh.morphTargetInfluences.length >= minFaceMorphs) vtuber.faces.push(mesh);
        });

        scene.add(root);
        root.rotation.y = vtuber.baseYaw;

        // 按包围盒自适应机位：不同导出单位（米/厘米级）都能正确取景，脚底对齐网格
        var box = new THREE.Box3().setFromObject(root);
        var h = Math.max(0.01, box.max.y - box.min.y);
        root.position.x -= (box.min.x + box.max.x) / 2;
        root.position.z -= (box.min.z + box.max.z) / 2;
        root.position.y -= box.min.y;
        vtuber.gridScale = h / 1.5;
        if (gridHelper) gridHelper.scale.setScalar(vtuber.gridScale);

        root.updateMatrixWorld(true);
        vtuber.arms = bindVrmArms(root, vtuber.bones);
        applyVrmArmPose(1.0, 0, null, 0, 0, false);

        // 捕获头部/躯干基准欧拉角（仅用于呼吸、视线跟随与点头）
        for (var name in vtuber.bones) {
            var r = vtuber.bones[name].rotation;
            vtuber.base[name] = { x: r.x, y: r.y, z: r.z };
        }

        // 虚拟主播半身机位：留出两侧挥手空间，头顶到腰部舒适入镜
        var headY = h * 0.82;
        vtuber.camPos = [0, headY, h * 0.92];
        vtuber.camLook = [0, headY * 0.91, 0];
        applyVrmCamera();
        vrmReady = true;
        MODE = "vrm";
    }

    function setBoneQuat(bone, q, alpha) {
        if (alpha >= 0.999) bone.quaternion.copy(q);
        else bone.quaternion.slerp(q, alpha);
    }

    function armBasis(axis, hint, target, scratch) {
        var side = scratch.side.copy(hint).addScaledVector(axis, -axis.dot(hint));
        if (side.lengthSq() < 1e-6) {
            side.set(0, 0, 1).addScaledVector(axis, -axis.z);
            if (side.lengthSq() < 1e-6) side.set(0, 1, 0).addScaledVector(axis, -axis.y);
        }
        side.normalize();
        return target.setFromRotationMatrix(scratch.matrix.makeBasis(
            axis, side, scratch.normal.crossVectors(axis, side)));
    }

    function bindVrmArms(root, bones) {
        var scratch = {
            matrix: new THREE.Matrix4(), side: new THREE.Vector3(), normal: new THREE.Vector3(),
            upper: new THREE.Vector3(), lower: new THREE.Vector3(), hint: new THREE.Vector3(),
            forward: new THREE.Vector3(0, 0, 1),
            target: new THREE.Quaternion(), parent: new THREE.Quaternion(), facing: new THREE.Quaternion(),
            restFacing: root.getWorldQuaternion(new THREE.Quaternion()).invert(), limbs: []
        };
        var fwd = scratch.forward;

        function pos(bone) { return bone.getWorldPosition(new THREE.Vector3()); }
        function offset(bone, direction, hint) {
            return armBasis(direction, hint, new THREE.Quaternion(), scratch).invert()
                .multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
        }

        ["right", "left"].forEach(function (side) {
            var upper = bones[side + "UpperArm"], lower = bones[side + "LowerArm"], hand = bones[side + "Hand"];
            if (!upper || !lower || !hand) return;
            var elbow = pos(lower), wrist = pos(hand);
            var upperDir = elbow.clone().sub(pos(upper)).normalize();
            var lowerDir = wrist.clone().sub(elbow).normalize();
            var middle = bones[side + "MiddleProximal"];
            var index = bones[side + "IndexProximal"], little = bones[side + "LittleProximal"];
            var fingerDir = middle ? pos(middle).sub(wrist).normalize() : lowerDir;
            var thumbSide = index && little ? pos(index).sub(pos(little)).normalize() : fwd;
            var sign = side === "right" ? -1 : 1;
            var palm = thumbSide.clone().cross(fingerDir).multiplyScalar(-sign).normalize();
            scratch.limbs.push({
                sign: sign, upper: upper, lower: lower, hand: hand, wristRest: hand.quaternion.clone(),
                upperOffset: offset(upper, upperDir, fwd), lowerOffset: offset(lower, lowerDir, thumbSide),
                handOffset: offset(hand, fingerDir, palm)
            });
        });
        return scratch;
    }

    function aimVrmBone(bone, offset, direction, hint, alpha, scratch) {
        var target = armBasis(direction, hint, scratch.target, scratch).multiply(offset);
        var parent = bone.parent.getWorldQuaternion(scratch.parent).invert();
        target.premultiply(scratch.facing).premultiply(parent);
        setBoneQuat(bone, target, alpha);
    }

    function applyVrmArmPose(alpha, t, kind, envelope, phase, speaking) {
        var arm = vtuber.arms;
        if (!vtuber.root || !arm) return;
        // 求解在角色正面坐标系中进行；拖拽转身时，肩、肘与掌心随角色一起旋转。
        vtuber.root.getWorldQuaternion(arm.facing).multiply(arm.restFacing);
        arm.limbs.forEach(function (limb) {
            var side = limb.sign;
            var talk = speaking && kind !== "nod" ? 0.64 + 0.19 * Math.sin(t * 3 + side) : 0;
            var greeting = kind === "celebrate" || (kind === "wave" && side < 0) ? envelope : 0;
            var sway = Math.sin(phase * 9);
            var upper = arm.upper.set(side * (0.23 + 0.05 * talk), -1, 0.14 + 0.24 * talk);
            var lower = arm.lower.set(side * 0.10, -0.96 + talk * 0.55, 0.30 + talk * 0.54);
            upper.lerp(arm.hint.set(side * 0.93, -0.30, 0.38), greeting).normalize();
            lower.lerp(arm.hint.set(side * (-0.10 + sway * 0.29), 1, 0.19), greeting).normalize();
            // 连杆方向决定肘部的弯曲平面；手指与掌面使用独立的模型绑定基准。
            aimVrmBone(limb.upper, limb.upperOffset, upper, lower, alpha, arm);
            aimVrmBone(limb.lower, limb.lowerOffset, lower, arm.hint.copy(upper).negate(), alpha, arm);
            var wristTarget = arm.target.copy(limb.wristRest);
            // 等前臂抬起再翻掌，避免经过水平位置时手腕翻转。
            var palmBlend = THREE.MathUtils.smoothstep(greeting, 0.55, 0.90);
            if (palmBlend) {
                var handDir = arm.hint.copy(lower).addScaledVector(upper, sway * 0.11).normalize();
                armBasis(handDir, arm.forward, wristTarget, arm).multiply(limb.handOffset)
                    .premultiply(arm.facing).premultiply(limb.hand.parent.getWorldQuaternion(arm.parent).invert());
                wristTarget.slerp(limb.wristRest, 1 - palmBlend);
            }
            setBoneQuat(limb.hand, wristTarget, alpha);
        });
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
        if (idx == null || idx < 0) return;
        for (var i = 0; i < list.length; i++) {
            if (idx < list[i].morphTargetInfluences.length) {
                list[i].morphTargetInfluences[idx] = v;
            }
        }
    }

    function triggerVrmGesture(kind, duration) {
        vtuber.gesture = { kind: kind, start: last || (performance.now() / 1000), duration: duration || (kind === "wave" ? 2.4 : 1.7) };
    }

    function updateVrm(t, dt) {
        mouthPulse = Math.max(0, mouthPulse - dt * 3);   // 末字后约 0.3s 收敛，流式期间由 delta 持续重置
        if (vtuber.root) {
            vtuber.root.rotation.y += ((vtuber.baseYaw + vtuber.yaw) - vtuber.root.rotation.y) * Math.min(1, dt * 10);
        }
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

        // 处理 VRM 互动手势（挥手 / 点头 / 庆祝）
        var g = vtuber.gesture;
        var gEnv = 0, gPhase = 0;
        if (g && g.kind) {
            var elapsed = t - g.start;
            if (elapsed >= 0 && elapsed < g.duration) {
                var u = elapsed / g.duration;
                gEnv = Math.sin(Math.min(1, u * 4) * Math.PI * 0.5) * Math.sin(Math.min(1, (1 - u) * 3.5) * Math.PI * 0.5);
                gPhase = elapsed;
            } else if (elapsed >= g.duration) {
                g.kind = null;
            }
        }

        var head = b.head;
        if (head && base.head) {
            // 右手系验证：+Y 旋转使脸部转向屏幕右侧 (+pointerNX)；VRM 0.x(-Z 朝前) 俯首为 -X，VRM 1.0(+Z 朝前) 俯首为 +X
            var pitchSign = vtuber.baseYaw === 0 ? 1 : -1;
            var nodOff = (g && g.kind === "nod") ? pitchSign * (1 - Math.cos(gPhase * 7.8)) * 0.10 * gEnv : 0;
            var tiltOff = (g && g.kind === "wave") ? (vtuber.baseYaw === 0 ? -0.10 : 0.10) * gEnv : 0;
            var ty = base.head.y + pointerNX * 0.26 + Math.sin(t * 0.5) * 0.035;
            var tx = base.head.x + pitchSign * pointerNY * 0.14 + Math.sin(t * 0.9) * 0.014 + nodOff;
            var tz = base.head.z + tiltOff;
            head.rotation.y += (ty - head.rotation.y) * Math.min(1, dt * 6);
            head.rotation.x += (tx - head.rotation.x) * Math.min(1, dt * 7);
            head.rotation.z += (tz - head.rotation.z) * Math.min(1, dt * 6);
        }

        // 使用世界方向四元数求解双臂姿态（自然垂手 / 胸前挥手 / 庆祝 / 说话手势）
        applyVrmArmPose(Math.min(1, dt * 11), t, g ? g.kind : null, gEnv, gPhase, voiceActive());

        var faces = vtuber.faces;
        if (!faces.length) return;
        var infl = faces[0].morphTargetInfluences;
        var map = vtuber.idx;
        var visemes = [map.a, map.i, map.u, map.e, map.o];

        // 眨眼：每 2~5 秒一次，blink morph 0→1→0（全部面部网格同驱）
        if (t > nextBlinkAt && blinkPhase < 0) {
            blinkPhase = 0;
            nextBlinkAt = t + 2 + Math.random() * 3;
        }
        if (blinkPhase >= 0 && map.blink >= 0) {
            blinkPhase += dt / 0.14;
            setMorph(faces, map.blink, blinkPhase < 0.5 ? blinkPhase * 2 : Math.max(0, 2 - blinkPhase * 2));
            if (blinkPhase >= 1) { blinkPhase = -1; setMorph(faces, map.blink, 0); }
        }
        // 微笑表情：说话/挥手/庆祝时柔和展露 joy
        if (map.joy >= 0 && map.joy < infl.length) {
            var joyTarget = (g && (g.kind === "wave" || g.kind === "celebrate")) ? 0.62 * gEnv
                : (g && g.kind === "nod") ? 0.35 * gEnv
                : voiceActive() ? (tts.speaking ? 0.32 : 0.16) : 0.06;
            setMorph(faces, map.joy, infl[map.joy] + (joyTarget - infl[map.joy]) * Math.min(1, dt * 5));
        }
        // 口型：朗读/文字脉冲期间按 ~7.5 次/秒切元音 morph，其余归零
        var target = [0, 0, 0, 0, 0];
        if (voiceActive()) {
            visemeTick += dt * 7.5;
            var idx = Math.floor(visemeTick) % visemes.length;
            var open = 0.52 + 0.34 * Math.abs(Math.sin(visemeTick * 2.1)) + 0.22 * mouthPulse;
            target[idx] = Math.min(0.95, open);
        }
        for (var k = 0; k < visemes.length; k++) {
            var vi = visemes[k];
            if (vi < 0 || vi >= infl.length) continue;
            var cur = infl[vi];
            setMorph(faces, vi, cur + (target[k] - cur) * Math.min(1, dt * 14));
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
        if (tag) {
            if (kind === "cwnu-panda") {
                tag.textContent = "西华师大 · 华小竹（拖拽旋转，双击复位）";
            } else if (kind === "live2d") {
                tag.textContent = "Live2D 看板娘 · Haru（眼神跟随，点击互动）";
            } else {
                var target = currentVrmTarget();
                tag.textContent = "Live3D · " + target.label + "（拖拽旋转）";
            }
        }
        var stage = $("avatarStage");
        if (stage) {
            stage.classList.toggle("is-live3d", kind === "vrm");
            stage.classList.toggle("is-live2d", kind === "live2d");
        }
        var bar = $("avatarGestureBar");
        if (bar) bar.hidden = false;
        var specialBtn = $("avatarSpecialBtn");
        if (specialBtn) {
            if (kind === "cwnu-panda") {
                specialBtn.textContent = "📖 托书";
                specialBtn.title = "翻阅校园手册";
            } else if (kind === "live2d") {
                specialBtn.textContent = "✨ 换表情";
                specialBtn.title = "切换 Live2D 表情";
            } else {
                specialBtn.textContent = "🎭 换皮套";
                specialBtn.title = "在内置 Live3D VRM 皮套间切换";
            }
        }
        var uploadBtn = $("avatarVrmUploadBtn");
        if (uploadBtn) uploadBtn.hidden = kind !== "vrm";
    }

    function renderSwitcherUI(kind) {
        var box = $("avatarSwitcher");
        if (!box) return;
        Array.prototype.forEach.call(box.querySelectorAll("[data-avatar-model]"), function (btn) {
            var active = btn.getAttribute("data-avatar-model") === kind;
            btn.classList.toggle("is-active", active);
            btn.setAttribute("aria-selected", String(active));
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
            if (hemiLight) { hemiLight.intensity = 0.0; }
            if (keyLight) { keyLight.color.setHex(0xfffaf2); keyLight.intensity = 0.92; keyLight.position.set(-2.1, 4.1, 3.8); }
            scene.environment = (pandaAvatar && pandaAvatar.envMap) ? pandaAvatar.envMap : null;
        } else {
            if (THREE.NoToneMapping !== undefined) renderer.toneMapping = THREE.NoToneMapping;
            renderer.toneMappingExposure = 1.0;
            if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
            if (ambientLight) { ambientLight.color.setHex(0xffffff); ambientLight.intensity = 0.72; }
            if (hemiLight) { hemiLight.color.setHex(0xffffff); hemiLight.groundColor.setHex(0x6b7aa1); hemiLight.intensity = 0.45; }
            if (keyLight) { keyLight.color.setHex(0xfff8f0); keyLight.intensity = 0.75; keyLight.position.set(1.8, 3.2, 3.4); }
            scene.environment = null;
        }
    }

    function setThreeCanvasVisible(show) {
        if (renderer && renderer.domElement) renderer.domElement.hidden = !show;
        if (live2dAvatar) live2dAvatar.setVisible(!show);
    }

    function activatePanda() {
        if (!window.buildCwnuPandaAvatar) return false;
        if (!pandaAvatar) {
            pandaAvatar = window.buildCwnuPandaAvatar(THREE, renderer);
            scene.add(pandaAvatar.root);
        }
        syncPandaPersona(selectedAgent);
        setThreeCanvasVisible(true);
        hideAllAvatars();
        applyLightingMode(true);
        pandaAvatar.root.visible = true;
        if (gridHelper) { gridHelper.visible = true; gridHelper.scale.setScalar(1); }
        var cp = pandaAvatar.cameraPreset;
        camera.fov = cp.fov;
        camera.position.set(cp.pos[0], cp.pos[1], cp.pos[2]);
        camera.lookAt(cp.lookAt[0], cp.lookAt[1], cp.lookAt[2]);
        camera.updateProjectionMatrix();
        $("avatarLoading").hidden = true;
        MODE = "panda";
        return true;
    }

    function activateLive2D() {
        if (!window.createCampusLive2DAvatar) return false;
        if (!live2dAvatar) {
            live2dAvatar = window.createCampusLive2DAvatar($("avatarStage"), { modelUrl: LIVE2D_MODEL_URL });
        }
        hideAllAvatars();
        setThreeCanvasVisible(false);
        if (live2dAvatar.isReady()) {
            $("avatarLoading").hidden = true;
            MODE = "live2d";
            return true;
        }
        if (live2dLoading) {
            $("avatarLoading").hidden = false;
            return true;
        }
        live2dLoading = true;
        $("avatarLoading").hidden = false;
        live2dAvatar.load(function (ok, errMsg) {
            live2dLoading = false;
            if (!ok) {
                live2dFailed = true;
                appendCaption("系统", "Live2D 看板娘加载失败（" + (errMsg || "unknown") + "），已自动回退。", "is-error");
                if (wantedModel === "live2d") switchAvatarModel("vrm");
                return;
            }
            if (wantedModel !== "live2d") {
                live2dAvatar.setVisible(false);
                return;
            }
            setThreeCanvasVisible(false);
            $("avatarLoading").hidden = true;
            MODE = "live2d";
        });
        return true;
    }

    function loadAndShowVrm(url) {
        vrmLoading = true;
        vrmFailed = false;
        setThreeCanvasVisible(true);
        hideAllAvatars();
        applyLightingMode(false);
        $("avatarLoading").hidden = false;
        loadVrmModel(url, function (ok) {
            vrmLoading = false;
            if (!ok) {
                vrmFailed = true;
                if (!rig.group) buildProceduralRig();
            }
            if (wantedModel !== "vrm") {
                if (wantedModel === "live2d") activateLive2D();
                else activatePanda();
                return;
            }
            setThreeCanvasVisible(true);
            hideAllAvatars();
            if (ok && vtuber.root) {
                vtuber.root.visible = true;
                if (gridHelper) { gridHelper.visible = true; gridHelper.scale.setScalar(vtuber.gridScale || 1); }
                applyVrmCamera();
                updateModelTag("vrm");
                MODE = "vrm";
            } else if (rig.group) {
                rig.group.visible = true;
                MODE = "procedural";
            }
            $("avatarLoading").hidden = true;
        });
    }

    function switchAvatarModel(kind) {
        if (kind !== "vrm" && kind !== "live2d" && kind !== "cwnu-panda") kind = "cwnu-panda";
        wantedModel = kind;
        try { localStorage.setItem(MODEL_CHOICE_KEY, wantedModel); } catch (e) {}
        renderSwitcherUI(wantedModel);

        if (wantedModel === "cwnu-panda") {
            if (activatePanda()) return;
            wantedModel = "vrm";
            renderSwitcherUI("vrm");
        }

        if (wantedModel === "live2d") {
            if (activateLive2D()) return;
            wantedModel = "vrm";
            renderSwitcherUI("vrm");
        }

        // 切换到 Live3D VRM 虚拟主播
        setThreeCanvasVisible(true);
        applyLightingMode(false);
        if (vrmReady && vtuber.root) {
            hideAllAvatars();
            vtuber.root.visible = true;
            if (gridHelper) { gridHelper.visible = true; gridHelper.scale.setScalar(vtuber.gridScale || 1); }
            applyVrmCamera();
            $("avatarLoading").hidden = true;
            MODE = "vrm";
            return;
        }
        if (vrmFailed && rig.group) {
            hideAllAvatars();
            rig.group.visible = true;
            if (gridHelper) { gridHelper.visible = true; gridHelper.scale.setScalar(1); }
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
        loadAndShowVrm(currentVrmTarget().url);
    }

    function animate(tick) {
        var t = tick / 1000;
        var dt = Math.min(0.05, t - last || 0.016);
        last = t;
        if (MODE === "live2d") {
            mouthPulse = Math.max(0, mouthPulse - dt * 3);
            if (live2dAvatar) live2dAvatar.setVoice(voiceActive());
        } else {
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
        }
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
        return String(s)
            // Strip complete keycaps first so ordinary digits remain readable.
            .replace(/[#*0-9]\uFE0F?\u20E3/gu, " ")
            // Includes flags, skin tones and joiners used by compound emoji.
            .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu, "")
            .replace(/[#*`>_~\[\]()]/g, " ").replace(/\s+/g, " ").trim();
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
        } else if (MODE === "vrm" && vtuber.root) {
            triggerVrmGesture(kind === "book" ? "nod" : kind, duration || 1.6);
        } else if (MODE === "live2d" && live2dAvatar) {
            live2dAvatar.triggerGesture(kind);
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
        if (bar) {
            bar.addEventListener("click", function (e) {
                var btn = e.target.closest ? e.target.closest("[data-gesture]") : null;
                if (!btn) return;
                var g = btn.getAttribute("data-gesture");
                if (MODE === "panda" && pandaAvatar) {
                    if (g === "reset") pandaAvatar.resetYaw();
                    else if (pandaAvatar.triggerGesture) pandaAvatar.triggerGesture(g);
                } else if (MODE === "vrm") {
                    if (g === "reset") {
                        vtuber.yaw = 0;
                        vtuber.gesture.kind = null;
                    } else if (g === "book") {
                        // 在内置 Live3D VRM 皮套间切换
                        if (vrmCustomUrl) {
                            try { URL.revokeObjectURL(vrmCustomUrl); } catch (err) {}
                            vrmCustomUrl = null;
                            vrmCustomLabel = "";
                        } else {
                            activeVrmPresetIndex = (activeVrmPresetIndex + 1) % VRM_PRESETS.length;
                        }
                        loadAndShowVrm(currentVrmTarget().url);
                    } else {
                        triggerVrmGesture(g, g === "wave" ? 2.4 : 1.7);
                    }
                } else if (MODE === "live2d" && live2dAvatar) {
                    live2dAvatar.triggerGesture(g);
                }
            });
        }
        var uploadBtn = $("avatarVrmUploadBtn");
        var uploadInput = $("avatarVrmInput");
        if (uploadBtn && uploadInput) {
            uploadBtn.addEventListener("click", function () { uploadInput.click(); });
            uploadInput.addEventListener("change", function () {
                var file = uploadInput.files && uploadInput.files[0];
                uploadInput.value = "";
                if (!file) return;
                if (vrmCustomUrl) {
                    try { URL.revokeObjectURL(vrmCustomUrl); } catch (err) {}
                }
                vrmCustomUrl = URL.createObjectURL(file);
                vrmCustomLabel = file.name.replace(/\.(vrm|glb)$/i, "");
                wantedModel = "vrm";
                renderSwitcherUI("vrm");
                loadAndShowVrm(vrmCustomUrl);
            });
        }
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
            var qModel = (new URLSearchParams(window.location.search).get("model") || "").toLowerCase();
            var saved = localStorage.getItem(MODEL_CHOICE_KEY) || localStorage.getItem(LEGACY_MODEL_CHOICE_KEY);
            if (qModel === "vrm" || qModel === "live2d" || qModel === "cwnu-panda") initialModel = qModel;
            else if (saved === "vrm" || saved === "live2d" || saved === "cwnu-panda") initialModel = saved;
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
