/*
 * avatar-cwnu-panda.js —— 西华师范大学「华小竹」3D 博士大熊猫数字人（高精度曲面雕刻 + 影棚级 PBR 版）
 * 核心工艺：
 *   1. PMREMGenerator 程序化影棚软箱环境光 (Studio IBL) + ACES 电影级色调映射 + 绒感边缘包裹光着色器
 *   2. 解析式连续顶点场雕刻（婴儿肥梨形圆脸 + 一体式柔和吻部 + 凹陷耳窝 + 锥形熊猫短腿 + 弧面全息书页）
 *   3. 2048px 等距球面/柱面烘焙贴图（柔边八字水滴黑眼圈、腮红、帽檐接触 AO、2K 斜纹呢学院马甲与领下阴影）
 *   4. 真实扇形放射叶脉立体银杏叶、无穿模外置贝塞尔丝带领结、1024px 官方西华师范大学珐琅金边校徽
 */
(function () {
    "use strict";

    var EMBLEM_URL = "/static/vendor/three/models/cwnu-emblem.png";

    function srgbColor(THREE, hex) {
        return new THREE.Color(hex).convertSRGBToLinear();
    }

    function createFurBumpTexture(THREE) {
        var S = 512;
        var c = document.createElement("canvas");
        c.width = c.height = S;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, S, S);

        var seed = 1337;
        function rand() {
            seed = (seed * 16807) % 2147483647;
            return (seed - 1) / 2147483646;
        }
        ctx.lineCap = "round";
        for (var i = 0; i < 4200; i++) {
            var x = rand() * S;
            var y = rand() * S;
            var len = 4 + rand() * 8;
            var ang = (rand() - 0.5) * 0.45;
            var shade = Math.floor(96 + rand() * 68);
            ctx.strokeStyle = "rgba(" + shade + "," + shade + "," + shade + ",0.32)";
            ctx.lineWidth = 0.9 + rand() * 1.1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.sin(ang) * len, y + Math.cos(ang) * len);
            ctx.stroke();
            if (x + len > S) {
                ctx.beginPath();
                ctx.moveTo(x - S, y);
                ctx.lineTo(x - S + Math.sin(ang) * len, y + Math.cos(ang) * len);
                ctx.stroke();
            }
        }
        var tex = new THREE.CanvasTexture(c);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(5, 3);
        tex.needsUpdate = true;
        return tex;
    }

    function srgbTex(THREE, tex, renderer) {
        if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
        if (renderer && renderer.capabilities) {
            tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        } else {
            tex.anisotropy = 4;
        }
        return tex;
    }

    // ---------- 1. 程序化影棚软箱 HDR 环境贴图（解决白毛死白与金属发黑） ----------
    function createStudioEnvMap(THREE, renderer) {
        if (!renderer || !THREE.PMREMGenerator) return null;
        try {
            var pmrem = new THREE.PMREMGenerator(renderer);
            if (pmrem.compileCubemapShader) pmrem.compileCubemapShader();
            var envScene = new THREE.Scene();
            envScene.background = new THREE.Color(0x16223b);

            function addSoftbox(color, w, h, pos, look) {
                var m = new THREE.Mesh(
                    new THREE.PlaneGeometry(w, h),
                    new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide })
                );
                m.position.set(pos[0], pos[1], pos[2]);
                m.lookAt(look[0], look[1], look[2]);
                envScene.add(m);
            }
            // 左前上方暖白主柔光箱（塑造圆润高光与金丝镜框质感）
            addSoftbox(0xfff6e8, 7.5, 6.0, [-5.0, 6.5, 6.0], [0, 1.2, 0]);
            // 正上方天光柔光带
            addSoftbox(0xdbe8ff, 8.0, 5.0, [0.0, 8.5, 1.0], [0, 0, 0]);
            // 右侧冷蓝轮廓补光板（还原设计图右侧脸颊冷蓝立体暗部过渡）
            addSoftbox(0x5b82c4, 6.0, 7.0, [7.5, 2.5, 1.5], [0, 1.2, 0]);
            // 左下方青色全息反射板（呼应全息书卷与底座青光）
            addSoftbox(0x3ce8ff, 4.5, 4.5, [-5.5, -1.0, 4.5], [0, 1.2, 0]);
            // 香槟金高光点缀条（让镜框和校徽金边呈现细腻金属拉丝高光）
            addSoftbox(0xffe7b0, 3.0, 1.2, [2.5, 4.8, 6.5], [0, 1.5, 0]);

            var rt = pmrem.fromScene(envScene, 0.04);
            pmrem.dispose();
            return rt.texture;
        } catch (e) {
            return null;
        }
    }

    // ---------- 2. 泡泡玛特级微绒毛/磨砂搪胶包裹光与双色边缘光着色增强 ----------
    function enhancePlushMaterial(mat, opts) {
        var rimCool = (opts && opts.rimCool) || "vec3(0.42, 0.68, 0.98)";
        var rimCyan = (opts && opts.rimCyan) || "vec3(0.22, 0.88, 0.98)";
        var rimStrength = (opts && opts.rimStrength != null) ? opts.rimStrength.toFixed(3) : "0.22";
        var rimMask = opts && opts.preserveDark
            ? "mix(0.08, 1.0, smoothstep(0.012, 0.16, dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))))"
            : "1.0";
        // Different fur colors use different rim strengths. Include them in the program
        // key so Three.js does not reuse the bright white-fur shader for black fur.
        mat.customProgramCacheKey = function () {
            return "panda-plush:" + rimCool + ":" + rimCyan + ":" + rimStrength + ":" + rimMask;
        };
        mat.onBeforeCompile = function (shader) {
            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <dithering_fragment>",
                [
                    "vec3 vNorm = normalize(vNormal);",
                    "vec3 vView = normalize(vViewPosition);",
                    "float fres = pow(1.0 - clamp(abs(dot(vNorm, vView)), 0.0, 1.0), 3.0);",
                    "float leftCyanMask = clamp(-vNorm.x * 0.65 + 0.35, 0.0, 1.0) * clamp(-vNorm.y * 0.4 + 0.7, 0.0, 1.0);",
                    "vec3 rimCol = mix(" + rimCool + ", " + rimCyan + ", leftCyanMask);",
                    "gl_FragColor.rgb += rimCol * fres * " + rimStrength + " * " + rimMask + ";",
                    "#include <dithering_fragment>"
                ].join("\n")
            );
        };
        return mat;
    }

    // ---------- 3. 2048×1024 头部等距球面烘焙贴图（奶白柔绒毛色 + 倾斜梨豆形黑眼圈 + 腮红 + 帽下 AO） ----------
    function createHeadTexture(THREE, renderer) {
        var W = 2048, H = 1024;
        var c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        var ctx = c.getContext("2d");

        // 奶白至暖象牙灰白柔渐变底色（自然大熊猫温暖绒毛，告别冰蓝假白）
        var baseGrad = ctx.createLinearGradient(0, 0, 0, H);
        baseGrad.addColorStop(0.00, "#ebe4d8");
        baseGrad.addColorStop(0.18, "#f8f4ec");
        baseGrad.addColorStop(0.58, "#fcf9f3");
        baseGrad.addColorStop(0.84, "#e5ddd0");
        baseGrad.addColorStop(1.00, "#c8bfb2");
        ctx.fillStyle = baseGrad;
        ctx.fillRect(0, 0, W, H);

        // 两侧脸颊与脑后柔和暖灰褐立体暗部（u=0.5 为正前脸）
        var sideLeft = ctx.createLinearGradient(0, 0, W * 0.40, 0);
        sideLeft.addColorStop(0.0, "rgba(178, 168, 154, 0.36)");
        sideLeft.addColorStop(0.72, "rgba(196, 186, 174, 0.14)");
        sideLeft.addColorStop(1.0, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = sideLeft;
        ctx.fillRect(0, 0, W * 0.42, H);

        var sideRight = ctx.createLinearGradient(W, 0, W * 0.60, 0);
        sideRight.addColorStop(0.0, "rgba(174, 164, 150, 0.40)");
        sideRight.addColorStop(0.72, "rgba(194, 184, 172, 0.16)");
        sideRight.addColorStop(1.0, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = sideRight;
        ctx.fillRect(W * 0.58, 0, W * 0.42, H);

        // 额头上方学士帽帽圈接触环境光遮蔽（Contact AO）
        var capAO = ctx.createLinearGradient(0, H * 0.11, 0, H * 0.25);
        capAO.addColorStop(0.0, "rgba(38, 28, 30, 0.42)");
        capAO.addColorStop(0.55, "rgba(68, 56, 54, 0.14)");
        capAO.addColorStop(1.0, "rgba(68, 56, 54, 0)");
        ctx.fillStyle = capAO;
        ctx.fillRect(0, 0, W, H * 0.26);

        // 下颌与颈部交界接触阴影
        var neckAO = ctx.createLinearGradient(0, H * 0.82, 0, H);
        neckAO.addColorStop(0.0, "rgba(136, 126, 114, 0)");
        neckAO.addColorStop(0.55, "rgba(112, 102, 92, 0.28)");
        neckAO.addColorStop(1.0, "rgba(78, 70, 64, 0.52)");
        ctx.fillStyle = neckAO;
        ctx.fillRect(0, H * 0.82, W, H * 0.18);

        // 额头、双颊与下巴细密短绒毛顺向笔触
        var hSeed = 2026;
        function hRand() {
            hSeed = (hSeed * 16807) % 2147483647;
            return (hSeed - 1) / 2147483646;
        }
        ctx.lineCap = "round";
        for (var fi = 0; fi < 1400; fi++) {
            var fx = W * (0.28 + hRand() * 0.44);
            var fy = H * (0.20 + hRand() * 0.62);
            var dx = fx - W * 0.5;
            var dy = fy - H * 0.55;
            var dist = Math.max(12, Math.sqrt(dx * dx + dy * dy));
            var flen = 8 + hRand() * 14;
            ctx.strokeStyle = hRand() > 0.45 ? "rgba(255, 252, 246, 0.16)" : "rgba(186, 174, 158, 0.11)";
            ctx.lineWidth = 1.2 + hRand() * 1.4;
            ctx.beginPath();
            ctx.moveTo(fx, fy);
            ctx.lineTo(fx + (dx / dist) * flen, fy + (dy / dist) * flen);
            ctx.stroke();
        }

        // 吻部下方柔和立体凹陷暗影
        var chinShade = ctx.createRadialGradient(W * 0.5, H * 0.70, 10, W * 0.5, H * 0.70, 140);
        chinShade.addColorStop(0.0, "rgba(148, 138, 126, 0.24)");
        chinShade.addColorStop(0.65, "rgba(166, 156, 144, 0.10)");
        chinShade.addColorStop(1.0, "rgba(166, 156, 144, 0)");
        ctx.fillStyle = chinShade;
        ctx.beginPath();
        ctx.ellipse(W * 0.5, H * 0.70, 155, 72, 0, 0, Math.PI * 2);
        ctx.fill();

        // 经典大熊猫「上收内倾、下圆外垂」倾斜梨豆形黑眼圈（八字垂感 + 绒毛柔羽化边界）
        function drawTeardropPatch(sx, blurPx, fillCol, scaleMul, withWisps) {
            ctx.save();
            ctx.translate(W * (0.5 + sx * 0.076), H * 0.502);
            ctx.rotate(-sx * 0.44);
            ctx.scale(sx * scaleMul, scaleMul);
            if (blurPx > 0 && typeof ctx.filter === "string") {
                ctx.filter = "blur(" + blurPx + "px)";
            }
            ctx.beginPath();
            ctx.moveTo(0, -116);
            ctx.bezierCurveTo(64, -116, 102, -52, 102, 22);
            ctx.bezierCurveTo(102, 94, 56, 132, 0, 128);
            ctx.bezierCurveTo(-58, 124, -100, 74, -98, 4);
            ctx.bezierCurveTo(-96, -64, -66, -116, 0, -116);
            ctx.closePath();
            ctx.fillStyle = fillCol;
            ctx.fill();

            if (withWisps) {
                ctx.lineCap = "round";
                for (var wi = 0; wi < 120; wi++) {
                    var ang = (wi / 120) * Math.PI * 2;
                    var rx = 96 + Math.sin(ang * 2) * 4;
                    var ry = 120 + (Math.sin(ang) > 0 ? 10 : -4);
                    var sx0 = Math.cos(ang) * (rx - 4);
                    var sy0 = Math.sin(ang) * (ry - 4);
                    var wLen = 7 + (wi % 5) * 2.2;
                    var jitter = ((wi % 3) - 1) * 0.12;
                    ctx.strokeStyle = wi % 2 === 0 ? "rgba(18, 19, 24, 0.65)" : "rgba(38, 36, 40, 0.35)";
                    ctx.lineWidth = 2.0;
                    ctx.beginPath();
                    ctx.moveTo(sx0, sy0);
                    ctx.lineTo(sx0 + Math.cos(ang + jitter) * wLen, sy0 + Math.sin(ang + jitter) * wLen);
                    ctx.stroke();
                }
            }
            ctx.restore();
        }
        [-1, 1].forEach(function (sx) {
            drawTeardropPatch(sx, 7, "rgba(28, 25, 28, 0.55)", 0.95, false);
            drawTeardropPatch(sx, 0, "#0e0f13", 0.91, true);
        });

        // 柔暖蜜桃腮红自然衔接于黑眼圈外下侧
        [-1, 1].forEach(function (sx) {
            var bx = W * (0.5 + sx * 0.118);
            var by = H * 0.602;
            var bg = ctx.createRadialGradient(bx, by, 6, bx, by, 82);
            bg.addColorStop(0.0, "rgba(252, 142, 152, 0.24)");
            bg.addColorStop(0.55, "rgba(252, 160, 168, 0.10)");
            bg.addColorStop(1.0, "rgba(252, 160, 168, 0)");
            ctx.fillStyle = bg;
            ctx.beginPath();
            ctx.arc(bx, by, 84, 0, Math.PI * 2);
            ctx.fill();
        });

        // 饱满奶白吻部柔光提亮
        var muzzleGlow = ctx.createRadialGradient(W * 0.5, H * 0.578, 8, W * 0.5, H * 0.588, 126);
        muzzleGlow.addColorStop(0.0, "rgba(255, 253, 248, 0.62)");
        muzzleGlow.addColorStop(0.7, "rgba(252, 248, 240, 0.24)");
        muzzleGlow.addColorStop(1.0, "rgba(252, 248, 240, 0)");
        ctx.fillStyle = muzzleGlow;
        ctx.beginPath();
        ctx.ellipse(W * 0.5, H * 0.588, 128, 88, 0, 0, Math.PI * 2);
        ctx.fill();

        return srgbTex(THREE, new THREE.CanvasTexture(c), renderer);
    }

    // ---------- 4. 2048×2048 学院马甲 + 白衬衫 + 接触阴影 AO 高清贴图 ----------
    function createVestTexture(THREE, renderer) {
        var W = 2048, H = 2048;
        var canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        var ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, W, H);
        var cx = W * 0.5;

        // 1) 内搭白衬衫区（仅上半胸口 V 领内可见，带柔和立体灰蓝布料明暗）
        var shirtGrad = ctx.createLinearGradient(cx - 260, 0, cx + 260, H * 0.48);
        shirtGrad.addColorStop(0.0, "#dce5f2");
        shirtGrad.addColorStop(0.45, "#f0f4fb");
        shirtGrad.addColorStop(1.0, "#cad6e8");
        ctx.fillStyle = shirtGrad;
        ctx.fillRect(W * 0.30, 0, W * 0.40, H * 0.52);

        // 衬衫门襟与领口下方接触阴影（AO）
        ctx.strokeStyle = "rgba(145, 160, 188, 0.55)";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(cx - 26, 30); ctx.lineTo(cx - 26, H * 0.46);
        ctx.moveTo(cx + 26, 30); ctx.lineTo(cx + 26, H * 0.46);
        ctx.stroke();

        // 丝带领结在白衬衫与马甲上的柔和投影
        var tieAO = ctx.createRadialGradient(cx, H * 0.30, 16, cx, H * 0.34, 210);
        tieAO.addColorStop(0.0, "rgba(18, 26, 46, 0.34)");
        tieAO.addColorStop(0.65, "rgba(18, 26, 46, 0.14)");
        tieAO.addColorStop(1.0, "rgba(18, 26, 46, 0)");
        ctx.fillStyle = tieAO;
        ctx.fillRect(W * 0.34, H * 0.10, W * 0.32, H * 0.40);

        // 2) 深藏青学院西装马甲主体（精准对照设计图：深 V 领 + 溜肩袖笼开口 + 双尖角燕尾前下摆）
        function traceVestBody() {
            ctx.beginPath();
            ctx.moveTo(0, H * 0.80);
            ctx.lineTo(W * 0.31, H * 0.81);
            // 右前下摆尖角（屏幕左侧）
            ctx.lineTo(W * 0.448, H * 0.945);
            // 正中倒 V 分叉缺口（露出下方一点柔和白肚皮）
            ctx.lineTo(cx, H * 0.835);
            // 左前下摆尖角（屏幕右侧）
            ctx.lineTo(W * 0.552, H * 0.945);
            ctx.lineTo(W * 0.69, H * 0.81);
            ctx.lineTo(W, H * 0.80);
            ctx.lineTo(W, 0);
            // 右肩带 -> 扣出右侧袖笼弧度 -> 左肩带 -> V 领
            ctx.lineTo(W * 0.79, 0);
            ctx.quadraticCurveTo(W * 0.725, H * 0.19, W * 0.765, H * 0.38);
            ctx.lineTo(W * 0.765, 0);
            ctx.closePath();
        }
        // 使用完整无裂缝闭合路径绘制马甲主体，再擦除两侧袖笼与正前 V 领
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, H * 0.80);
        ctx.lineTo(W * 0.31, H * 0.81);
        ctx.lineTo(W * 0.448, H * 0.945);
        ctx.lineTo(cx, H * 0.835);
        ctx.lineTo(W * 0.552, H * 0.945);
        ctx.lineTo(W * 0.69, H * 0.81);
        ctx.lineTo(W, H * 0.80);
        ctx.lineTo(W, 0);
        ctx.lineTo(W * 0.618, 0);
        ctx.lineTo(cx, H * 0.455);
        ctx.lineTo(W * 0.382, 0);
        ctx.lineTo(0, 0);
        ctx.closePath();

        var vestGrad = ctx.createLinearGradient(0, 0, 0, H);
        vestGrad.addColorStop(0.00, "#212e4a");
        vestGrad.addColorStop(0.48, "#18233a");
        vestGrad.addColorStop(0.88, "#121b2e");
        vestGrad.addColorStop(1.00, "#0e1525");
        ctx.fillStyle = vestGrad;
        ctx.fill();

        ctx.clip();
        // 细腻斜纹精纺学院呢纹理
        ctx.strokeStyle = "rgba(255, 255, 255, 0.020)";
        ctx.lineWidth = 3;
        for (var d = -H; d < W + H; d += 16) {
            ctx.beginPath();
            ctx.moveTo(d, 0);
            ctx.lineTo(d - H * 0.55, H);
            ctx.stroke();
        }

        // 左右两侧经典微斜嵌线袋（Welt Pockets）
        [W * 0.355, W * 0.565].forEach(function (px, idx) {
            var pw = W * 0.080, ph = 36, py = H * 0.665;
            var tilt = idx === 0 ? 18 : -18;
            ctx.fillStyle = "#131c30";
            ctx.strokeStyle = "rgba(7, 11, 22, 0.78)";
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px + pw, py + tilt);
            ctx.lineTo(px + pw, py + tilt + ph);
            ctx.lineTo(px, py + ph);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // 袋口上沿微弱受光细线
            ctx.strokeStyle = "rgba(120, 146, 196, 0.16)";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(px + 2, py + ph);
            ctx.lineTo(px + pw - 2, py + tilt + ph);
            ctx.stroke();
        });

        // 前门襟交叠暗缝线与立体折边阴影
        ctx.strokeStyle = "rgba(6, 10, 20, 0.68)";
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(cx - 4, H * 0.455);
        ctx.lineTo(cx - 4, H * 0.835);
        ctx.stroke();
        ctx.strokeStyle = "rgba(120, 145, 190, 0.14)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx + 3, H * 0.46);
        ctx.lineTo(cx + 3, H * 0.83);
        ctx.stroke();
        ctx.restore();

        // 3) 内敛沉稳的西华师大暗酒红滚边（#8b1f2b，带立体暗边与微高光，告别刺眼荧光红）
        function drawPiping(pathFn, outerW, mainW) {
            ctx.save();
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.beginPath(); pathFn();
            ctx.strokeStyle = "rgba(8, 12, 24, 0.65)";
            ctx.lineWidth = outerW + 8;
            ctx.stroke();

            ctx.beginPath(); pathFn();
            ctx.strokeStyle = "#68141e";
            ctx.lineWidth = outerW;
            ctx.stroke();

            ctx.beginPath(); pathFn();
            ctx.strokeStyle = "#8f202c";
            ctx.lineWidth = mainW;
            ctx.stroke();

            ctx.beginPath(); pathFn();
            ctx.strokeStyle = "rgba(214, 92, 104, 0.28)";
            ctx.lineWidth = Math.max(3, mainW * 0.24);
            ctx.stroke();
            ctx.restore();
        }

        drawPiping(function () {
            ctx.moveTo(W * 0.382, 4);
            ctx.lineTo(cx, H * 0.455);
            ctx.lineTo(W * 0.618, 4);
        }, 38, 28);

        drawPiping(function () {
            ctx.moveTo(0, H * 0.798);
            ctx.lineTo(W * 0.31, H * 0.808);
            ctx.lineTo(W * 0.448, H * 0.942);
            ctx.lineTo(cx, H * 0.832);
            ctx.lineTo(W * 0.552, H * 0.942);
            ctx.lineTo(W * 0.69, H * 0.808);
            ctx.lineTo(W, H * 0.798);
        }, 34, 24);

        // 左右袖笼弧形酒红滚边
        [W * 0.285, W * 0.715].forEach(function (ax, idx) {
            var dir = idx === 0 ? 1 : -1;
            drawPiping(function () {
                ctx.moveTo(ax + dir * 24, 6);
                ctx.quadraticCurveTo(ax + dir * 68, H * 0.22, ax - dir * 28, H * 0.44);
            }, 30, 22);
        });

        return srgbTex(THREE, new THREE.CanvasTexture(canvas), renderer);
    }

    // ---------- 5. 深邃暖棕黑大熊猫晶莹瞳仁贴图（乌溜饱满大眼 + 暖琥珀青微反光 + 双高光） ----------
    function createIrisTexture(THREE, renderer) {
        var S = 512;
        var c = document.createElement("canvas");
        c.width = c.height = S;
        var ctx = c.getContext("2d");
        var r = S * 0.5;

        // 熊猫标志性深邃浓咖啡黑虹膜（中央纯黑 -> 暖深栗棕过渡 -> 深黑瞳缘）
        var g = ctx.createRadialGradient(r, r * 1.06, S * 0.04, r, r, r * 0.98);
        g.addColorStop(0.00, "#050406");
        g.addColorStop(0.56, "#150f0d");
        g.addColorStop(0.79, "#2c1d16");
        g.addColorStop(0.92, "#181210");
        g.addColorStop(1.00, "#080607");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(r, r, r - 2, 0, Math.PI * 2);
        ctx.fill();

        // 上眼睑柔和投落暗影，增加眼神深邃水润感
        var lidGrad = ctx.createLinearGradient(0, 0, 0, S * 0.52);
        lidGrad.addColorStop(0.0, "rgba(4, 3, 5, 0.55)");
        lidGrad.addColorStop(1.0, "rgba(4, 3, 5, 0)");
        ctx.fillStyle = lidGrad;
        ctx.beginPath();
        ctx.arc(r, r, r - 2, 0, Math.PI * 2);
        ctx.fill();

        // 底部通透暖琥珀与冷天光双层微弱月牙反光
        ctx.strokeStyle = "rgba(200, 154, 106, 0.24)";
        ctx.lineWidth = 13;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(r, r * 1.01, r * 0.72, Math.PI * 0.18, Math.PI * 0.82);
        ctx.stroke();

        ctx.strokeStyle = "rgba(156, 180, 200, 0.16)";
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.arc(r, r * 1.01, r * 0.66, Math.PI * 0.24, Math.PI * 0.76);
        ctx.stroke();

        // 中央饱满乌黑瞳仁
        ctx.fillStyle = "#040305";
        ctx.beginPath();
        ctx.arc(r, r * 0.98, r * 0.58, 0, Math.PI * 2);
        ctx.fill();

        // 左上 10:30 方向主圆润亮白高光 + 右下 4:30 微星副高光
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(r * 0.60, r * 0.60, r * 0.165, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(255, 252, 246, 0.88)";
        ctx.beginPath();
        ctx.arc(r * 1.32, r * 1.28, r * 0.072, 0, Math.PI * 2);
        ctx.fill();

        return srgbTex(THREE, new THREE.CanvasTexture(c), renderer);
    }

    // Small convex iris surface; avoids a flat disc floating over the eyeball.
    function createIrisDomeGeometry(THREE, radius, depth) {
        var segments = 64, rings = 12;
        var positions = [], uvs = [], indices = [];
        for (var ring = 0; ring <= rings; ring++) {
            var r = ring / rings;
            for (var seg = 0; seg <= segments; seg++) {
                var angle = seg / segments * Math.PI * 2;
                var x = Math.cos(angle) * r;
                var y = Math.sin(angle) * r;
                positions.push(x * radius, y * radius, depth * (1 - r * r));
                uvs.push(x * 0.5 + 0.5, y * 0.5 + 0.5);
                if (ring < rings && seg < segments) {
                    var a = ring * (segments + 1) + seg;
                    var b = a + segments + 1;
                    indices.push(a, b, a + 1, b, b + 1, a + 1);
                }
            }
        }
        var geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        return geometry;
    }

    // Give the curved collar a closed edge instead of a paper-thin double-sided plane.
    function thickenClothGeometry(THREE, front, thickness) {
        var positions = Array.from(front.attributes.position.array);
        var count = front.attributes.position.count;
        var indices = Array.from(front.index.array);
        var edges = new Map();
        for (var i = 0; i < count; i++) {
            positions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2] - thickness);
        }
        for (var j = 0; j < front.index.count; j += 3) {
            var a = front.index.array[j], b = front.index.array[j + 1], c = front.index.array[j + 2];
            indices.push(c + count, b + count, a + count);
            [[a, b], [b, c], [c, a]].forEach(function (edge) {
                var key = Math.min(edge[0], edge[1]) + ":" + Math.max(edge[0], edge[1]);
                if (edges.has(key)) edges.delete(key); else edges.set(key, edge);
            });
        }
        edges.forEach(function (edge) {
            var a = edge[0], b = edge[1];
            indices.push(b, a, a + count, b, a + count, b + count);
        });
        var geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        return geometry;
    }

    function updatePandaEyelid(geometry, closed) {
        var positions = geometry.attributes.position;
        var widthSegments = geometry.parameters.widthSegments;
        var heightSegments = geometry.parameters.heightSegments;
        for (var row = 0; row <= heightSegments; row++) {
            for (var col = 0; col <= widthSegments; col++) {
                var nx = col / widthSegments * 2 - 1;
                var edge = Math.sqrt(Math.max(0, 1 - nx * nx));
                var ny = edge * (1 - 2 * closed * row / heightSegments);
                var z = 0.057 * Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) + 0.010;
                positions.setXYZ(row * (widthSegments + 1) + col, nx * 0.115, ny * 0.122, z);
            }
        }
        positions.needsUpdate = true;
        geometry.computeVertexNormals();
    }

    // ---------- 6. 真·扇形二裂放射叶脉银杏叶几何与纹理（彻底修复倒心形黄块） ----------
    function createGinkgoVeinTexture(THREE, renderer) {
        var S = 256;
        var c = document.createElement("canvas");
        c.width = c.height = S;
        var ctx = c.getContext("2d");

        var g = ctx.createLinearGradient(0, 0, 0, S);
        g.addColorStop(0.0, "#d8aa46");
        g.addColorStop(0.45, "#f0ca62");
        g.addColorStop(1.0, "#ffe48a");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);

        // 放射状银杏叶细密叶脉
        ctx.strokeStyle = "rgba(168, 118, 26, 0.36)";
        ctx.lineWidth = 2;
        for (var i = -18; i <= 18; i++) {
            var ang = (i / 18) * 1.05;
            ctx.beginPath();
            ctx.moveTo(S * 0.5, S * 0.10);
            ctx.lineTo(S * 0.5 + Math.sin(ang) * S * 0.92, S * 0.10 + Math.cos(ang) * S * 0.92);
            ctx.stroke();
        }
        return srgbTex(THREE, new THREE.CanvasTexture(c), renderer);
    }

    function createTrueGinkgoGeometry(THREE, scale) {
        var s = scale || 1;
        var shape = new THREE.Shape();
        // 纤细微弯叶柄（顶部 y = +0.068*s 挂点）+ 饱满 128° 宽扇形波浪叶缘 + 中央精致浅裂口
        shape.moveTo(-0.0045 * s, 0.068 * s);
        shape.quadraticCurveTo(-0.006 * s, 0.015 * s, -0.010 * s, -0.012 * s);
        // 左侧扇缘向外舒展张开
        shape.quadraticCurveTo(-0.088 * s, -0.058 * s, -0.178 * s, -0.145 * s);
        // 左半扇叶圆润波浪外缘
        shape.bezierCurveTo(-0.192 * s, -0.178 * s, -0.156 * s, -0.218 * s, -0.112 * s, -0.224 * s);
        shape.quadraticCurveTo(-0.064 * s, -0.242 * s, -0.018 * s, -0.232 * s);
        // 银杏叶标志性中央窄 V 小缺刻（不过深，保持完整扇形感）
        shape.lineTo(0.0, -0.178 * s);
        shape.lineTo(0.018 * s, -0.232 * s);
        // 右半扇叶圆润波浪外缘
        shape.quadraticCurveTo(0.064 * s, -0.242 * s, 0.112 * s, -0.224 * s);
        shape.bezierCurveTo(0.156 * s, -0.218 * s, 0.192 * s, -0.178 * s, 0.178 * s, -0.145 * s);
        // 右侧扇缘收拢回纤细叶柄
        shape.quadraticCurveTo(0.088 * s, -0.058 * s, 0.010 * s, -0.012 * s);
        shape.quadraticCurveTo(0.006 * s, 0.015 * s, 0.0045 * s, 0.068 * s);
        shape.closePath();

        var geo = new THREE.ExtrudeGeometry(shape, {
            depth: 0.007 * s,
            bevelEnabled: true,
            bevelSegments: 2,
            steps: 1,
            bevelSize: 0.003 * s,
            bevelThickness: 0.003 * s
        });
        var pos = geo.attributes.position;
        var uv = geo.attributes.uv;
        for (var i = 0; i < pos.count; i++) {
            var vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
            var bend = -0.10 * (vx * vx) / Math.max(0.04, s) + 0.022 * Math.sin((vy / Math.max(0.1, s)) * 4.0) * s;
            pos.setZ(i, vz + bend);
            if (uv) {
                uv.setXY(i, 0.5 + vx / (0.38 * s), 1.0 - (0.075 * s - vy) / (0.33 * s));
            }
        }
        geo.computeVertexNormals();
        return geo;
    }

    // ---------- 7. 全息书卷边缘发光纹理、星尘柔光光斑纹理与底座光晕 ----------
    function createHoloPageTexture(THREE) {
        var W = 384, H = 512;
        var c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        var ctx = c.getContext("2d");
        // Frosted paper is opaque enough to read; light belongs to the edge, not every pixel.
        var bg = ctx.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, "#e1f6f5");
        bg.addColorStop(0.52, "#bddfdf");
        bg.addColorStop(1, "#91c5cb");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(45, 113, 137, 0.30)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(19, 19, W - 38, H - 38);
        ctx.fillStyle = "#31617a";
        ctx.font = "600 17px Georgia, serif";
        ctx.textAlign = "center";
        ctx.fillText("CWNU · KNOWLEDGE", W * 0.5, 57);
        ctx.fillStyle = "rgba(38, 98, 125, 0.52)";
        ctx.fillRect(61, 73, W - 122, 1.5);
        ctx.fillStyle = "rgba(37, 89, 112, 0.65)";
        // Short groups with an indented first line suggest paragraphs, not a glowing barcode.
        for (var group = 0; group < 4; group++) {
            for (var line = 0; line < 4; line++) {
                var indent = line === 0 ? 15 : 0;
                var tail = line === 3 ? 45 + group * 11 : ((line + group) % 3) * 13;
                ctx.fillRect(43 + indent, 112 + group * 82 + line * 14, W - 86 - indent - tail, 2.2);
            }
        }
        ctx.fillStyle = "rgba(42, 109, 137, 0.62)";
        ctx.font = "13px Georgia, serif";
        ctx.fillText("—  01  —", W * 0.5, H - 36);
        var texture = new THREE.CanvasTexture(c);
        if (THREE.sRGBEncoding !== undefined) texture.encoding = THREE.sRGBEncoding;
        return texture;
    }

    function createSoftOrbTexture(THREE, innerRgba, midRgba) {
        var S = 128;
        var c = document.createElement("canvas");
        c.width = c.height = S;
        var ctx = c.getContext("2d");
        var r = S * 0.5;
        var g = ctx.createRadialGradient(r, r, 0, r, r, r);
        g.addColorStop(0.0, innerRgba || "rgba(235, 255, 255, 1)");
        g.addColorStop(0.32, midRgba || "rgba(86, 242, 255, 0.68)");
        g.addColorStop(0.70, "rgba(38, 210, 245, 0.16)");
        g.addColorStop(1.0, "rgba(38, 210, 245, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);
        return new THREE.CanvasTexture(c);
    }

    function createCurvedPageGeometry(THREE, w, h, sideSign, archAmt) {
        var geo = new THREE.PlaneGeometry(w, h, 24, 16);
        var pos = geo.attributes.position;
        for (var i = 0; i < pos.count; i++) {
            var x = pos.getX(i); // -w/2 .. +w/2
            var y = pos.getY(i);
            // u 从书脊(0) 到外书口(1)
            var u = Math.max(0, Math.min(1, sideSign > 0 ? (x / w + 0.5) : (0.5 - x / w)));
            // 经典翻开古籍的海鸥翼 S 形微拱曲面
            var z = Math.sin(u * Math.PI * 0.92) * archAmt - Math.pow(u, 2.2) * (archAmt * 0.42);
            z += Math.pow(y / h, 2) * 0.008;
            pos.setX(i, x + sideSign * w * 0.5);
            pos.setZ(i, z);
        }
        geo.computeVertexNormals();
        return geo;
    }

    // ---------- 8. 解析式连续顶点雕刻：奶胖婴儿肥大熊猫圆脸 + 饱满一体式熊吻 + 双上唇肉垫 ----------
    function createSculptedPandaHeadGeometry(THREE) {
        // phiStart = -PI/2 保证 u=0.5 精确落在 +Z 正脸中央，接缝隐藏在 -Z 后脑勺
        var geo = new THREE.SphereGeometry(1.0, 128, 96, -Math.PI * 0.5, Math.PI * 2);
        var pos = geo.attributes.position;

        for (var i = 0; i < pos.count; i++) {
            var nx = pos.getX(i);
            var ny = pos.getY(i);
            var nz = pos.getZ(i);

            // 圆润饱满的大熊猫球形萌脸基尺度（宽高比 ~1.09:1，饱满不扁）
            var sx = 0.610;
            var sy = 0.595;
            var sz = 0.585;

            // 1) 额角保持圆润饱满、两腮柔和圆弧微丰
            var crownTaper = ny > 0.15 ? Math.pow((ny - 0.15) / 0.85, 1.45) * 0.036 : 0.0;
            var cheekBand = Math.exp(-Math.pow((ny + 0.24) / 0.37, 2.0));
            var sideCheek = cheekBand * (0.038 + 0.016 * Math.max(0, nz));
            sx = sx - crownTaper + sideCheek;
            sz = sz - crownTaper * 0.55 + cheekBand * 0.022;

            var x = nx * sx;
            var y = ny * sy;
            var z = nz * sz;

            // 2) 下巴底部柔和托平微圆
            if (ny < -0.45) {
                var chinFlatten = Math.pow((-ny - 0.45) / 0.55, 1.7);
                y += chinFlatten * 0.016;
            }

            // 3) 眼窝微平缓凹槽 + 饱满圆润熊吻部 + 上唇双侧小肉垫与微弱人中沟
            if (nz > 0.25) {
                var eyeDistL = Math.pow((nx + 0.40) / 0.28, 2.0) + Math.pow((ny - 0.06) / 0.28, 2.0);
                var eyeDistR = Math.pow((nx - 0.40) / 0.28, 2.0) + Math.pow((ny - 0.06) / 0.28, 2.0);
                var socket = (Math.exp(-eyeDistL) + Math.exp(-eyeDistR)) * 0.018;
                z -= socket;

                // 一体式饱满小熊吻部隆起
                var muzR2 = Math.pow(nx / 0.36, 2.0) + Math.pow((ny + 0.27) / 0.28, 2.0);
                var muzSwelling = Math.exp(-muzR2 * 1.15) * Math.max(0, nz);
                z += muzSwelling * 0.112;
                y -= muzSwelling * 0.012;

                // 左右上唇肉垫 + 正中人中微凹
                var puffL = Math.exp(-(Math.pow((nx + 0.13) / 0.14, 2.0) + Math.pow((ny + 0.36) / 0.13, 2.0)));
                var puffR = Math.exp(-(Math.pow((nx - 0.13) / 0.14, 2.0) + Math.pow((ny + 0.36) / 0.13, 2.0)));
                var philtrum = Math.exp(-(Math.pow(nx / 0.055, 2.0) + Math.pow((ny + 0.36) / 0.14, 2.0))) * 0.007;
                z += ((puffL + puffR) * 0.017 - philtrum) * Math.max(0, nz);

                // 下唇下方微收颌沟
                var underLipR2 = Math.pow(nx / 0.30, 2.0) + Math.pow((ny + 0.56) / 0.14, 2.0);
                z -= Math.exp(-underLipR2) * 0.014;
            }

            pos.setXYZ(i, x, y, z);
        }
        geo.computeVertexNormals();
        return geo;
    }

    // 雕刻毛茸茸圆球耳窝的大熊猫绒球圆耳
    function createSculptedEarGeometry(THREE) {
        var geo = new THREE.SphereGeometry(0.218, 40, 32);
        var pos = geo.attributes.position;
        for (var i = 0; i < pos.count; i++) {
            var x = pos.getX(i) * 1.03;
            var y = pos.getY(i) * 0.99;
            var z = pos.getZ(i) * 0.80;
            if (z > 0) {
                var r2 = (x * x + (y + 0.015) * (y + 0.015)) / (0.145 * 0.145);
                if (r2 < 1.35) {
                    z -= Math.exp(-r2 * 1.4) * 0.036;
                }
            }
            pos.setXYZ(i, x, y, z);
        }
        geo.computeVertexNormals();
        return geo;
    }

    // 饱满宽阔倒圆角熊仔鼻几何
    function createPandaNoseGeometry(THREE) {
        var shape = new THREE.Shape();
        shape.moveTo(0, 0.040);
        shape.bezierCurveTo(0.064, 0.044, 0.096, 0.026, 0.090, -0.004);
        shape.bezierCurveTo(0.080, -0.032, 0.032, -0.056, 0, -0.060);
        shape.bezierCurveTo(-0.032, -0.056, -0.080, -0.032, -0.090, -0.004);
        shape.bezierCurveTo(-0.096, 0.026, -0.064, 0.044, 0, 0.040);
        var geo = new THREE.ExtrudeGeometry(shape, {
            depth: 0.030,
            bevelEnabled: true,
            bevelSegments: 5,
            steps: 1,
            bevelSize: 0.024,
            bevelThickness: 0.024
        });
        // 让鼻子前表面顺应吻部呈饱满圆弧球面凸起
        var pos = geo.attributes.position;
        for (var i = 0; i < pos.count; i++) {
            var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            var dome = Math.max(0, 1.0 - (x * x) / 0.013 - (y * y) / 0.007) * 0.020;
            pos.setZ(i, z + dome - x * x * 1.3);
        }
        geo.computeVertexNormals();
        return geo;
    }

    function buildLimbCapsule(THREE, rTop, rBot, len, mat) {
        var grp = new THREE.Group();
        var cyl = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, 32, 8), mat);
        cyl.position.y = -len * 0.5;
        grp.add(cyl);
        var capTop = new THREE.Mesh(new THREE.SphereGeometry(rTop, 28, 20), mat);
        grp.add(capTop);
        var capBot = new THREE.Mesh(new THREE.SphereGeometry(rBot, 28, 20), mat);
        capBot.position.y = -len;
        grp.add(capBot);
        return grp;
    }
    // 精确求取雕刻头部前表面任意 (x, y_rel) 处的 Z 坐标（与 createSculptedPandaHeadGeometry 公式严格保持一致！）
    function evalHeadFrontZ(xTarget, yRel) {
        var ny = Math.max(-0.96, Math.min(0.96, yRel / 0.595));
        var crownTaper = ny > 0.15 ? Math.pow((ny - 0.15) / 0.85, 1.45) * 0.036 : 0.0;
        var cheekBand = Math.exp(-Math.pow((ny + 0.24) / 0.37, 2.0));
        var nz = Math.sqrt(Math.max(0.04, 1.0 - ny * ny));
        var nx = 0;
        for (var k = 0; k < 4; k++) {
            var sx = 0.610 - crownTaper + cheekBand * (0.038 + 0.016 * Math.max(0, nz));
            nx = Math.max(-0.96, Math.min(0.96, xTarget / sx));
            nz = Math.sqrt(Math.max(0.02, 1.0 - nx * nx - ny * ny));
        }
        var sz = 0.585 - crownTaper * 0.55 + cheekBand * 0.022;
        var z = nz * sz;
        if (nz > 0.25) {
            var eyeDistL = Math.pow((nx + 0.40) / 0.28, 2.0) + Math.pow((ny - 0.06) / 0.28, 2.0);
            var eyeDistR = Math.pow((nx - 0.40) / 0.28, 2.0) + Math.pow((ny - 0.06) / 0.28, 2.0);
            z -= (Math.exp(-eyeDistL) + Math.exp(-eyeDistR)) * 0.018;
            var muzR2 = Math.pow(nx / 0.36, 2.0) + Math.pow((ny + 0.27) / 0.28, 2.0);
            z += Math.exp(-muzR2 * 1.15) * Math.max(0, nz) * 0.112;
            var puffL = Math.exp(-(Math.pow((nx + 0.13) / 0.14, 2.0) + Math.pow((ny + 0.36) / 0.13, 2.0)));
            var puffR = Math.exp(-(Math.pow((nx - 0.13) / 0.14, 2.0) + Math.pow((ny + 0.36) / 0.13, 2.0)));
            var philtrum = Math.exp(-(Math.pow(nx / 0.055, 2.0) + Math.pow((ny + 0.36) / 0.14, 2.0))) * 0.007;
            z += ((puffL + puffR) * 0.017 - philtrum) * Math.max(0, nz);
            var underLipR2 = Math.pow(nx / 0.30, 2.0) + Math.pow((ny + 0.56) / 0.14, 2.0);
            z -= Math.exp(-underLipR2) * 0.014;
        }
        return z;
    }

    // 柔和烘焙奶白肚皮贴图（上沿带马甲下摆暖灰接触阴影 AO）
    function createBellyTexture(THREE, renderer) {
        var S = 512;
        var c = document.createElement("canvas");
        c.width = c.height = S;
        var ctx = c.getContext("2d");
        var g = ctx.createLinearGradient(0, 0, 0, S);
        g.addColorStop(0.00, "#8f8980");
        g.addColorStop(0.28, "#c4bcb0");
        g.addColorStop(0.58, "#f3ede2");
        g.addColorStop(0.85, "#e5ddd0");
        g.addColorStop(1.00, "#b5ada0");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);
        return srgbTex(THREE, new THREE.CanvasTexture(c), renderer);
    }

    window.buildCwnuPandaAvatar = function (THREE, renderer) {
        var root = new THREE.Group();
        // 微朝镜头左方偏转 3.5°，还原设计图灵动的微侧立体站姿
        var basePoseYaw = -0.055;
        root.rotation.y = basePoseYaw;

        var bodyBob = new THREE.Group();
        root.add(bodyBob);

        var envMap = createStudioEnvMap(THREE, renderer);
        var furBumpTex = createFurBumpTexture(THREE);

        // ---------- PBR 影棚级定制材质库（sRGB -> Linear 准确校色 + 微绒 Bump） ----------
        var headFurMat = enhancePlushMaterial(new THREE.MeshStandardMaterial({
            map: createHeadTexture(THREE, renderer),
            bumpMap: furBumpTex,
            bumpScale: 0.0065,
            color: 0xffffff,
            roughness: 0.74,
            metalness: 0.01,
            envMapIntensity: 0.50
        }), { rimStrength: 0.22, preserveDark: true });

        var bellyFurMat = enhancePlushMaterial(new THREE.MeshStandardMaterial({
            map: createBellyTexture(THREE, renderer),
            bumpMap: furBumpTex,
            bumpScale: 0.006,
            color: 0xffffff,
            roughness: 0.78,
            metalness: 0.01,
            envMapIntensity: 0.42
        }), { rimStrength: 0.16 });

        var blackFurMat = enhancePlushMaterial(new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x101216),
            bumpMap: furBumpTex,
            bumpScale: 0.009,
            roughness: 0.94,
            metalness: 0,
            envMapIntensity: 0.18
        }), { rimCool: "vec3(0.28, 0.34, 0.42)", rimCyan: "vec3(0.23, 0.36, 0.40)", rimStrength: 0.028 });
        blackFurMat.name = "panda-black-fur";

        var innerEarMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x111216),
            bumpMap: furBumpTex,
            bumpScale: 0.008,
            roughness: 0.96,
            metalness: 0,
            envMapIntensity: 0.08
        });
        var padMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x3d3035),
            roughness: 0.88,
            metalness: 0,
            envMapIntensity: 0.16
        });
        var toeCreaseMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x141820),
            roughness: 0.85,
            metalness: 0.02
        });
        var noseMat = new THREE.MeshPhysicalMaterial
            ? new THREE.MeshPhysicalMaterial({
                color: srgbColor(THREE, 0x14171c),
                roughness: 0.30,
                metalness: 0.04,
                clearcoat: 0.32,
                clearcoatRoughness: 0.35,
                envMapIntensity: 0.35
            })
            : new THREE.MeshStandardMaterial({
                color: srgbColor(THREE, 0x14171c),
                roughness: 0.28,
                metalness: 0.06
            });
        var lipMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x1e1918),
            roughness: 0.48,
            metalness: 0.02
        });
        var shirtMat = enhancePlushMaterial(new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0xf0f2f5),
            roughness: 0.62,
            metalness: 0.01,
            envMapIntensity: 0.50
        }), { rimStrength: 0.16 });

        var crimsonCapMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x8e1f2b),
            roughness: 0.64,
            metalness: 0.04,
            envMapIntensity: 0.48
        });
        var crimsonDarkEdgeMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x66121c),
            roughness: 0.68,
            metalness: 0.04,
            envMapIntensity: 0.42
        });
        var ribbonMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x9c2130),
            roughness: 0.48,
            metalness: 0.06,
            envMapIntensity: 0.58
        });
        var navyBandMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x1b2640),
            roughness: 0.62,
            metalness: 0.05,
            envMapIntensity: 0.50
        });
        var goldMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0xe4bc62),
            roughness: 0.22,
            metalness: 0.86,
            envMapIntensity: 1.25
        });
        var ginkgoMat = new THREE.MeshStandardMaterial({
            map: createGinkgoVeinTexture(THREE, renderer),
            color: srgbColor(THREE, 0xf0c654),
            emissive: srgbColor(THREE, 0x261802),
            roughness: 0.42,
            metalness: 0.18,
            envMapIntensity: 0.75,
            side: THREE.DoubleSide
        });
        var buttonMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x2f2d28),
            roughness: 0.38,
            metalness: 0.42,
            envMapIntensity: 0.80
        });

        // ---------- 1. 底座双层发光青蓝全息光环（r = 0.72 / 0.61） ----------
        var haloGroup = new THREE.Group();
        root.add(haloGroup);

        var additive = THREE.AdditiveBlending || 2;
        var outerRingCore = new THREE.Mesh(
            new THREE.TorusGeometry(0.72, 0.017, 16, 112),
            new THREE.MeshBasicMaterial({ color: 0x96fcff, transparent: true, opacity: 0.95 })
        );
        outerRingCore.rotation.x = Math.PI / 2;
        outerRingCore.position.y = 0.018;
        haloGroup.add(outerRingCore);

        var outerRingBloom = new THREE.Mesh(
            new THREE.RingGeometry(0.65, 0.79, 96),
            new THREE.MeshBasicMaterial({
                color: 0x2ce8ff,
                transparent: true,
                opacity: 0.34,
                blending: additive,
                side: THREE.DoubleSide,
                depthWrite: false
            })
        );
        outerRingBloom.rotation.x = -Math.PI / 2;
        outerRingBloom.position.y = 0.012;
        haloGroup.add(outerRingBloom);

        var innerRing = new THREE.Mesh(
            new THREE.TorusGeometry(0.60, 0.0085, 12, 96),
            new THREE.MeshBasicMaterial({ color: 0x7ef6ff, transparent: true, opacity: 0.78 })
        );
        innerRing.rotation.x = Math.PI / 2;
        innerRing.position.y = 0.017;
        haloGroup.add(innerRing);

        var floorGlow = new THREE.Mesh(
            new THREE.PlaneGeometry(2.1, 2.1),
            new THREE.MeshBasicMaterial({
                map: createSoftOrbTexture(THREE, "rgba(42, 224, 255, 0.24)", "rgba(32, 190, 240, 0.14)"),
                transparent: true,
                blending: additive,
                depthWrite: false
            })
        );
        floorGlow.rotation.x = -Math.PI / 2;
        floorGlow.position.y = 0.005;
        haloGroup.add(floorGlow);

        // 底座向上投射微弱青色环境反射光（照亮脚背与小腿边缘）
        var floorBounceLight = new THREE.PointLight(0x72c6d4, 0.18, 1.6);
        floorBounceLight.position.set(0, 0.12, 0.35);
        root.add(floorBounceLight);

        // ---------- 2. 一体雕刻短腿与圆润趾峰熊掌脚 ----------
        [-1, 1].forEach(function (sx) {
            var leg = new THREE.Group();
            leg.name = "panda-leg-" + sx;
            leg.position.set(0.232 * sx, 0.43, 0.0);
            leg.rotation.z = -0.045 * sx;
            bodyBob.add(leg);

            // A closed, smoothly sampled profile replaces cylinder/cap intersections.
            var legProfile = new THREE.SplineCurve([
                new THREE.Vector2(0, 0.105),
                new THREE.Vector2(0.142, 0.055),
                new THREE.Vector2(0.205, -0.025),
                new THREE.Vector2(0.197, -0.140),
                new THREE.Vector2(0.159, -0.245),
                new THREE.Vector2(0.144, -0.315),
                new THREE.Vector2(0, -0.355)
            ]).getPoints(42);
            // Clamp endpoint interpolation to the rotation axis.
            legProfile.forEach(function (point) { point.x = Math.max(0, point.x); });
            // The leg uses the same bottom-to-top exterior winding as the sleeves.
            legProfile.reverse();
            var thigh = new THREE.Mesh(new THREE.LatheGeometry(legProfile, 48), blackFurMat);
            thigh.name = "panda-continuous-leg-" + sx;
            thigh.scale.z = 0.94;
            leg.add(thigh);

            // Toe lobes are part of the same vertex field as the foot, not separate balls.
            var footGeo = new THREE.SphereGeometry(0.168, 56, 36);
            var footPos = footGeo.attributes.position;
            for (var fi = 0; fi < footPos.count; fi++) {
                var fx = footPos.getX(fi) * 1.13;
                var fy = footPos.getY(fi) * 0.64;
                var fz = footPos.getZ(fi) * 1.18;
                var frontWeight = Math.pow(Math.max(0, fz / 0.212), 4);
                var toeContour = 0;
                [-0.082, 0, 0.082].forEach(function (toeX) {
                    toeContour += Math.exp(-Math.pow((fx - toeX) / 0.031, 2));
                });
                fz += frontWeight * toeContour * 0.015;
                // Round into a stable sole while preserving a soft outer silhouette.
                fy = Math.max(-0.079, fy);
                footPos.setXYZ(fi, fx, fy, fz);
            }
            footGeo.computeVertexNormals();
            var foot = new THREE.Mesh(footGeo, blackFurMat);
            foot.name = "panda-sculpted-foot-" + sx;
            foot.position.set(0, -0.345, 0.048);
            leg.add(foot);

            [-0.043, 0.043].forEach(function (seamX) {
                var toeCrease = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
                    new THREE.Vector3(seamX, -0.333, 0.263),
                    new THREE.Vector3(seamX, -0.313, 0.249),
                    new THREE.Vector3(seamX, -0.303, 0.230)
                ]), 12, 0.002, 6, false), toeCreaseMat);
                leg.add(toeCrease);
            });
        });

        // ---------- 3. 躯干（y = 0.36 .. 1.13，精确匹配设计图 1:0.80 头宽肩宽比） ----------
        var spinePivot = new THREE.Group();
        spinePivot.position.set(0, 0.36, 0);
        bodyBob.add(spinePivot);

        // 骨盆暗黑底座与圆润下垂白肚皮（严格收在马甲内侧 z=0 杜绝下摆穿模，仅在马甲下沿露出柔和白肚皮！）
        var pelvisBack = new THREE.Mesh(new THREE.SphereGeometry(0.435, 36, 28), blackFurMat);
        pelvisBack.name = "panda-black-pelvis";
        pelvisBack.scale.set(1.02, 0.60, 0.70);
        pelvisBack.position.set(0, 0.03, -0.045);
        spinePivot.add(pelvisBack);

        var whiteBelly = new THREE.Mesh(new THREE.SphereGeometry(0.438, 44, 32), bellyFurMat);
        whiteBelly.name = "panda-white-belly";
        whiteBelly.scale.set(0.96, 0.70, 0.86);
        whiteBelly.position.set(0, 0.125, 0.0);
        spinePivot.add(whiteBelly);

        // 修身学院马甲车削曲面（局部 y = 0.00 .. 0.77 -> 世界 y = 0.36 .. 1.13，半宽 0.495）
        var lathePts = [
            new THREE.Vector2(0.455, 0.00),
            new THREE.Vector2(0.501, 0.12),
            new THREE.Vector2(0.517, 0.26),
            new THREE.Vector2(0.504, 0.41),
            new THREE.Vector2(0.470, 0.55),
            new THREE.Vector2(0.422, 0.67),
            new THREE.Vector2(0.365, 0.75),
            new THREE.Vector2(0.310, 0.78)
        ];
        // Uniform-height Hermite sampling: smooth shoulders/waist and consistent cloth UVs.
        var bodyProfileKeys = lathePts;
        lathePts = [];
        for (var profileStep = 0; profileStep <= 56; profileStep++) {
            var profileY = 0.78 * profileStep / 56;
            var profileIndex = 0;
            while (profileIndex < bodyProfileKeys.length - 2 && profileY > bodyProfileKeys[profileIndex + 1].y) profileIndex++;
            var keyA = bodyProfileKeys[profileIndex], keyB = bodyProfileKeys[profileIndex + 1];
            var keyPrev = bodyProfileKeys[Math.max(0, profileIndex - 1)];
            var keyNext = bodyProfileKeys[Math.min(bodyProfileKeys.length - 1, profileIndex + 2)];
            var slopeA = (keyB.x - keyPrev.x) / (keyB.y - keyPrev.y);
            var slopeB = (keyNext.x - keyA.x) / (keyNext.y - keyA.y);
            var sectionH = keyB.y - keyA.y;
            var sectionT = Math.max(0, Math.min(1, (profileY - keyA.y) / sectionH));
            var t2 = sectionT * sectionT, t3 = t2 * sectionT;
            var radius = (2 * t3 - 3 * t2 + 1) * keyA.x + (t3 - 2 * t2 + sectionT) * sectionH * slopeA +
                (-2 * t3 + 3 * t2) * keyB.x + (t3 - t2) * sectionH * slopeB;
            radius = Math.max(Math.min(keyA.x, keyB.x), Math.min(Math.max(keyA.x, keyB.x), radius));
            lathePts.push(new THREE.Vector2(radius, profileY));
        }
        var vestGeo = new THREE.LatheGeometry(lathePts, 80, Math.PI, Math.PI * 2);
        var vestMat = new THREE.MeshStandardMaterial({
            map: createVestTexture(THREE, renderer),
            transparent: true,
            alphaTest: 0.35,
            roughness: 0.62,
            metalness: 0.03,
            envMapIntensity: 0.52,
            side: THREE.DoubleSide
        });
        var vestMesh = new THREE.Mesh(vestGeo, vestMat);
        vestMesh.name = "panda-tailored-vest";
        vestMesh.scale.set(1.02, 1.0, 0.86);
        spinePivot.add(vestMesh);

        // 辅助函数：求取马甲前胸椭圆曲面在局部 (x, y) 处的外法线表面 Z
        function evalChestZ(xLocal, yLocal) {
            yLocal = Math.max(lathePts[0].y, Math.min(lathePts[lathePts.length - 1].y, yLocal));
            var rProfile = lathePts[0].x;
            for (var li = 0; li < lathePts.length - 1; li++) {
                var p0 = lathePts[li], p1 = lathePts[li + 1];
                if (yLocal >= p0.y && yLocal <= p1.y) {
                    var t = (yLocal - p0.y) / Math.max(0.001, p1.y - p0.y);
                    rProfile = p0.x + (p1.x - p0.x) * t;
                    break;
                }
            }
            var rx = rProfile * 1.02;
            var rz = rProfile * 0.86;
            var ratio = Math.min(0.95, Math.abs(xLocal) / rx);
            return rz * Math.sqrt(Math.max(0.05, 1.0 - ratio * ratio));
        }

        // Two inset, stitched buttons; soft edge highlights replace the flat cylinder ends.
        var stitchMat = new THREE.MeshStandardMaterial({ color: srgbColor(THREE, 0x3e4f6e), roughness: 0.91, metalness: 0 });
        var buttonInsetMat = new THREE.MeshStandardMaterial({ color: srgbColor(THREE, 0x1b2232), roughness: 0.61, metalness: 0.12 });
        [0.315, 0.175].forEach(function (by, index) {
            var bz = evalChestZ(0, by);
            var buttonGroup = new THREE.Group();
            buttonGroup.name = "panda-vest-button-" + index;
            buttonGroup.position.set(-0.004, by, bz + 0.009);
            spinePivot.add(buttonGroup);
            var button = new THREE.Mesh(new THREE.SphereGeometry(0.023, 24, 16), buttonMat);
            button.scale.set(1, 1, 0.32);
            buttonGroup.add(button);
            var inset = new THREE.Mesh(new THREE.CircleGeometry(0.014, 24), buttonInsetMat);
            inset.position.z = 0.0073;
            buttonGroup.add(inset);
            var threadCurve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(-0.006, -0.002, 0.008),
                new THREE.Vector3(0, 0.001, 0.0095),
                new THREE.Vector3(0.006, -0.002, 0.008)
            ]);
            buttonGroup.add(new THREE.Mesh(new THREE.TubeGeometry(threadCurve, 8, 0.0015, 5, false), stitchMat));
        });
        // Low-relief paired front seams follow the actual chest rather than float in front of it.
        [-1, 1].forEach(function (sx) {
            var seamPoints = [];
            for (var i = 0; i <= 16; i++) {
                var sy = 0.13 + i / 16 * 0.23;
                var sxLocal = sx * 0.023;
                seamPoints.push(new THREE.Vector3(sxLocal, sy, evalChestZ(sxLocal, sy) + 0.0018));
            }
            var seam = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seamPoints), 24, 0.0011, 5, false), stitchMat);
            seam.name = "panda-vest-front-seam-" + sx;
            spinePivot.add(seam);
        });

        // Continuous shoulder-to-neck profile, overlapped by the chin during head turns.
        var neckProfile = new THREE.SplineCurve([
            new THREE.Vector2(0.354, 0.590),
            new THREE.Vector2(0.345, 0.650),
            new THREE.Vector2(0.312, 0.710),
            new THREE.Vector2(0.274, 0.770),
            new THREE.Vector2(0.235, 0.835),
            new THREE.Vector2(0.205, 0.915)
        ]).getPoints(36);
        // The belly AO map does not belong on the neck: it created a dark horizontal band.
        var neckTransitionMat = bellyFurMat.clone();
        neckTransitionMat.map = null;
        neckTransitionMat.bumpMap = furBumpTex;
        neckTransitionMat.bumpScale = 0.0055;
        neckTransitionMat.color.copy(srgbColor(THREE, 0xf7f2e8));
        var neckFur = new THREE.Mesh(new THREE.LatheGeometry(neckProfile, 64), neckTransitionMat);
        neckFur.name = "panda-neck-transition";
        neckFur.scale.z = 0.94;
        neckFur.position.z = -0.005;
        spinePivot.add(neckFur);

        // 圆滚蓬松奶白大熊猫短尾巴（背面转动可见标志性小团尾）
        var pandaTail = new THREE.Mesh(new THREE.SphereGeometry(0.118, 28, 22), neckTransitionMat);
        pandaTail.name = "panda-tail";
        pandaTail.scale.set(1.06, 0.96, 1.04);
        pandaTail.position.set(0, 0.055, -0.345);
        spinePivot.add(pandaTail);

        [-1, 1].forEach(function (sx) {
            var collarY = 0.672;
            var segU = 18, segV = 8;
            var cGeo = new THREE.PlaneGeometry(1, 1, segU, segV);
            var cp = cGeo.attributes.position;
            for (var ci = 0; ci < cp.count; ci++) {
                var u = Math.max(0, Math.min(1, cp.getX(ci) + 0.5));
                var v = Math.max(0, Math.min(1, cp.getY(ci) + 0.5));

                var topX = (0.006 + u * 0.228) * sx;
                var topY = collarY + Math.pow(u, 0.85) * 0.092;

                var tipFactor = Math.exp(-Math.pow((u - 0.64) / 0.28, 2.0));
                var botX = (0.008 + u * 0.215) * sx;
                var botY = collarY - 0.010 + u * 0.055 - tipFactor * 0.092;

                var px = botX + (topX - botX) * v;
                var py = botY + (topY - botY) * v;
                var surfZ = evalChestZ(px, Math.min(0.755, py));
                var lift = 0.020 + (1.0 - v) * 0.012 + tipFactor * (1.0 - v) * 0.008;
                cp.setXYZ(ci, px, py, surfZ + lift);
            }
            if (sx < 0 && cGeo.index) {
                var idxArr = cGeo.index.array;
                for (var ii = 0; ii < idxArr.length; ii += 3) {
                    var tmp = idxArr[ii + 1];
                    idxArr[ii + 1] = idxArr[ii + 2];
                    idxArr[ii + 2] = tmp;
                }
            }
            cGeo.computeVertexNormals();
            var collar = new THREE.Mesh(thickenClothGeometry(THREE, cGeo, 0.009), shirtMat);
            collar.name = "panda-collar-" + sx;
            spinePivot.add(collar);
            cGeo.dispose();
        });

        // ---------- 3B. 外置无穿模 3D 学院酒红丝带蝴蝶结（沿胸前曲面弧线自然垂落！） ----------
        var tieY = 0.645;
        var tieZ = evalChestZ(0, tieY) + 0.026;
        var tieGroup = new THREE.Group();
        tieGroup.position.set(0, tieY, tieZ);
        spinePivot.add(tieGroup);

        // Rounded fabric knot with a pinched middle, instead of a faceted box.
        var knotShape = new THREE.Shape();
        knotShape.moveTo(-0.026, -0.025);
        knotShape.quadraticCurveTo(-0.037, -0.022, -0.030, -0.010);
        knotShape.quadraticCurveTo(-0.024, 0, -0.031, 0.015);
        knotShape.quadraticCurveTo(-0.034, 0.028, -0.022, 0.028);
        knotShape.lineTo(0.022, 0.028);
        knotShape.quadraticCurveTo(0.034, 0.028, 0.031, 0.015);
        knotShape.quadraticCurveTo(0.024, 0, 0.030, -0.010);
        knotShape.quadraticCurveTo(0.037, -0.022, 0.026, -0.025);
        knotShape.closePath();
        var knotGeo = new THREE.ExtrudeGeometry(knotShape, {
            depth: 0.022, bevelEnabled: true, bevelSize: 0.005, bevelThickness: 0.005,
            bevelSegments: 3, curveSegments: 8, steps: 1
        });
        var knotMesh = new THREE.Mesh(knotGeo, ribbonMat);
        knotMesh.position.z = 0.010;
        knotMesh.name = "panda-ribbon-rounded-knot";
        tieGroup.add(knotMesh);

        [-1, 1].forEach(function (sx) {
            // 向两侧斜下方舒展的饱满立体蝴蝶翼（复刻设计图 40° 垂感丝带环）
            var loopShape = new THREE.Shape();
            loopShape.moveTo(0, 0.012);
            loopShape.bezierCurveTo(0.08 * sx, 0.008, 0.165 * sx, -0.055, 0.195 * sx, -0.118);
            loopShape.lineTo(0.145 * sx, -0.152);
            loopShape.bezierCurveTo(0.095 * sx, -0.105, 0.042 * sx, -0.048, 0, -0.022);
            loopShape.closePath();

            var loopGeo = new THREE.ExtrudeGeometry(loopShape, {
                depth: 0.015,
                bevelEnabled: true,
                bevelSegments: 3,
                steps: 1,
                bevelSize: 0.006,
                bevelThickness: 0.006
            });
            var lp = loopGeo.attributes.position;
            for (var lpi = 0; lpi < lp.count; lpi++) {
                var lx = lp.getX(lpi), ly = lp.getY(lpi), lz = lp.getZ(lpi);
                // 随胸前凸起向外微拱再贴回衣面，绝不穿模
                var chestDelta = evalChestZ(lx, tieY + ly) - (tieZ - 0.026);
                lp.setZ(lpi, lz + chestDelta + 0.014 + Math.sin(Math.min(1, Math.abs(lx) / 0.19) * Math.PI) * 0.016);
            }
            loopGeo.computeVertexNormals();
            tieGroup.add(new THREE.Mesh(loopGeo, ribbonMat));
            var ribbonFoldMat = new THREE.MeshStandardMaterial({color: srgbColor(THREE, 0x63131f), roughness: 0.65, metalness: 0.01});
            var foldPoints = [];
            for (var fi = 0; fi <= 10; fi++) {
                var fu = fi / 10;
                var fx = sx * (0.025 + fu * 0.118);
                var fy = -0.015 - fu * 0.084;
                var foldChest = evalChestZ(fx, tieY + fy) - (tieZ - 0.026);
                var foldBulge = Math.sin(Math.min(1, Math.abs(fx) / 0.19) * Math.PI) * 0.016;
                foldPoints.push(new THREE.Vector3(fx, fy, foldChest + foldBulge + 0.035));
            }
            tieGroup.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(foldPoints), 20, 0.0015, 5, false), ribbonFoldMat));

            // 跨越酒红 V 领边、垂落胸前的修长斜切飘带（复刻设计图至 y≈0.69 的双飘带！）
            var tailShape = new THREE.Shape();
            tailShape.moveTo(0.004 * sx, -0.015);
            tailShape.bezierCurveTo(0.038 * sx, -0.085, 0.078 * sx, -0.185, 0.096 * sx, -0.285);
            tailShape.lineTo(0.069 * sx, -0.287);
            tailShape.lineTo(0.042 * sx, -0.305);
            tailShape.bezierCurveTo(0.028 * sx, -0.195, 0.006 * sx, -0.095, -0.006 * sx, -0.022);
            tailShape.closePath();

            var tailGeo = new THREE.ExtrudeGeometry(tailShape, {
                depth: 0.012,
                bevelEnabled: true,
                bevelSegments: 3,
                steps: 1,
                bevelSize: 0.004,
                bevelThickness: 0.004
            });
            var tp = tailGeo.attributes.position;
            for (var tpi = 0; tpi < tp.count; tpi++) {
                var txv = tp.getX(tpi), tyv = tp.getY(tpi), tzv = tp.getZ(tpi);
                var chestDeltaT = evalChestZ(txv, tieY + tyv) - (tieZ - 0.026);
                tp.setZ(tpi, tzv + chestDeltaT + 0.008);
            }
            tailGeo.computeVertexNormals();
            tieGroup.add(new THREE.Mesh(tailGeo, ribbonMat));
        });

        // ---------- 4. 左胸：1024px 高对比度西华师范大学官方珐琅金边校徽 ----------
        var badgeX = 0.258, badgeY = 0.445; // 世界 y = 0.36 + 0.445 = 0.805（与设计图 y=0.80 分毫不差！）
        var badgeZ = evalChestZ(badgeX, badgeY);
        var badgeGroup = new THREE.Group();
        badgeGroup.position.set(badgeX, badgeY, badgeZ + 0.008);
        // 精确贴合椭球胸面法线朝向
        badgeGroup.lookAt(badgeX + 0.56, badgeY + 0.14, badgeZ + 1.0);
        spinePivot.add(badgeGroup);

        // 背面接触投影暗环（让校徽稳稳镶嵌在藏青呢料上）
        var badgeShadow = new THREE.Mesh(
            new THREE.CircleGeometry(0.122, 48),
            new THREE.MeshBasicMaterial({ color: 0x070b16, transparent: true, opacity: 0.42, depthWrite: false })
        );
        badgeShadow.position.z = -0.003;
        badgeGroup.add(badgeShadow);

        // 双阶斜切哑光拉丝金金属外框
        var bezelPts = [
            new THREE.Vector2(0.00, -0.004),
            new THREE.Vector2(0.114, -0.004),
            new THREE.Vector2(0.115, 0.006),
            new THREE.Vector2(0.109, 0.012),
            new THREE.Vector2(0.104, 0.012)
        ];
        var badgeBezel = new THREE.Mesh(new THREE.LatheGeometry(bezelPts, 64), goldMat);
        badgeBezel.rotation.x = Math.PI / 2;
        badgeGroup.add(badgeBezel);

        var emblemFaceMat = new THREE.MeshStandardMaterial({
            color: 0xf7f7f7,
            roughness: 0.44,
            metalness: 0.02,
            envMapIntensity: 0.32,
            transparent: true
        });
        var texLoader = new THREE.TextureLoader();
        texLoader.load(EMBLEM_URL, function (tex) {
            srgbTex(THREE, tex, renderer);
            emblemFaceMat.map = tex;
            emblemFaceMat.needsUpdate = true;
        });
        var badgeFace = new THREE.Mesh(new THREE.CircleGeometry(0.107, 64), emblemFaceMat);
        badgeFace.position.z = 0.0125;
        badgeGroup.add(badgeFace);

        // ---------- 5. 连续袖型、翻折袖口与嵌合式熊掌指腹 ----------
        function createSoftSleeve(topRadius, bottomRadius, length) {
            var profile = new THREE.SplineCurve([
                new THREE.Vector2(0, 0.080),
                new THREE.Vector2(topRadius * 0.70, 0.055),
                new THREE.Vector2(topRadius, 0.005),
                new THREE.Vector2(topRadius * 1.025, -length * 0.34),
                new THREE.Vector2(bottomRadius * 0.995, -length * 0.76),
                new THREE.Vector2(bottomRadius * 0.96, -length),
                new THREE.Vector2(0, -length - 0.025)
            ]).getPoints(36);
            profile.forEach(function (point) { point.x = Math.max(0, point.x); });
            profile.reverse();
            var sleeve = new THREE.Mesh(new THREE.LatheGeometry(profile, 40), shirtMat);
            sleeve.name = "panda-cloth-sleeve";
            return sleeve;
        }
        var cuffShadowMat = new THREE.MeshStandardMaterial({ color: srgbColor(THREE, 0x9eaac0), roughness: 0.82 });
        function createTailoredCuff(radius, height) {
            var group = new THREE.Group();
            // Closed wall section gives the opening a visible fabric thickness.
            var cuffProfile = [
                new THREE.Vector2(radius - 0.011, height * 0.5),
                new THREE.Vector2(radius - 0.003, height * 0.5 + 0.002),
                new THREE.Vector2(radius, height * 0.5 - 0.005),
                new THREE.Vector2(radius, -height * 0.5 + 0.006),
                new THREE.Vector2(radius - 0.003, -height * 0.5),
                new THREE.Vector2(radius - 0.011, -height * 0.5),
                new THREE.Vector2(radius - 0.011, height * 0.5)
            ];
            cuffProfile.reverse();
            var cuff = new THREE.Mesh(new THREE.LatheGeometry(cuffProfile, 40), shirtMat);
            cuff.name = "panda-cloth-cuff";
            group.add(cuff);
            var seam = new THREE.Mesh(new THREE.TorusGeometry(radius - 0.0005, 0.0018, 6, 40), cuffShadowMat);
            seam.rotation.x = Math.PI / 2;
            seam.position.y = height * 0.5 - 0.009;
            group.add(seam);
            var cuffButton = new THREE.Mesh(new THREE.SphereGeometry(0.009, 14, 10), buttonMat);
            cuffButton.scale.z = 0.35;
            cuffButton.position.set(0.036, 0, radius - 0.003);
            group.add(cuffButton);
            return group;
        }
        function createSoftPalm(radius, scale) {
            var geometry = new THREE.SphereGeometry(radius, 40, 28);
            var pos = geometry.attributes.position;
            for (var pi = 0; pi < pos.count; pi++) {
                var px = pos.getX(pi), py = pos.getY(pi), pz = pos.getZ(pi);
                // Gentle metacarpal arch, no hard wrist/palm ridge.
                var palmArch = Math.exp(-Math.pow(px / (radius * 0.75), 2) - Math.pow((py + radius * 0.2) / radius, 2));
                pos.setXYZ(pi, px * scale[0], py * scale[1], pz * scale[2] + Math.max(0, pz / radius) * palmArch * 0.007);
            }
            geometry.computeVertexNormals();
            return new THREE.Mesh(geometry, blackFurMat);
        }

        var leftShoulder = new THREE.Group();
        leftShoulder.position.set(0.415, 0.65, 0.0);
        leftShoulder.rotation.z = 0.25;
        leftShoulder.rotation.x = 0.04;
        spinePivot.add(leftShoulder);
        var leftSleeve = createSoftSleeve(0.126, 0.138, 0.39);
        leftShoulder.add(leftSleeve);
        var leftCuff = createTailoredCuff(0.141, 0.062);
        leftCuff.position.y = -0.405;
        leftShoulder.add(leftCuff);

        var leftPawGroup = new THREE.Group();
        leftPawGroup.name = "panda-left-paw";
        leftPawGroup.position.set(-0.01, -0.50, 0.015);
        leftPawGroup.rotation.z = -0.22;
        leftShoulder.add(leftPawGroup);
        var leftPaw = createSoftPalm(0.118, [1.02, 1.05, 0.98]);
        leftPawGroup.add(leftPaw);
        // The short fingers sink well into the palm; only their rounded tips protrude.
        [-0.046, 0, 0.046].forEach(function (fx, index) {
            var finger = new THREE.Mesh(new THREE.SphereGeometry(0.035, 24, 18), blackFurMat);
            finger.scale.set(1.02, 1.25, 1.02);
            finger.position.set(fx, -0.092 + Math.abs(index - 1) * 0.009, 0.021);
            finger.rotation.z = -fx * 0.8;
            leftPawGroup.add(finger);
        });
        var leftThumb = new THREE.Mesh(new THREE.SphereGeometry(0.042, 24, 18), blackFurMat);
        leftThumb.scale.set(0.95, 1.18, 0.93);
        leftThumb.name = "panda-left-thumb";
        leftThumb.position.set(0.083, -0.026, 0.041);
        leftThumb.rotation.z = 0.45;
        leftPawGroup.add(leftThumb);

        var rightShoulder = new THREE.Group();
        rightShoulder.position.set(-0.415, 0.65, 0.03);
        rightShoulder.rotation.z = -0.56;
        rightShoulder.rotation.x = -0.42;
        spinePivot.add(rightShoulder);
        var rightUpperSleeve = createSoftSleeve(0.126, 0.132, 0.22);
        rightShoulder.add(rightUpperSleeve);
        var rightElbow = new THREE.Group();
        rightElbow.position.set(0, -0.22, 0);
        rightElbow.rotation.x = -1.36;
        rightElbow.rotation.z = -0.22;
        rightElbow.rotation.y = 0.28;
        rightShoulder.add(rightElbow);
        var rightForeSleeve = createSoftSleeve(0.132, 0.138, 0.21);
        rightElbow.add(rightForeSleeve);
        var rightCuff = createTailoredCuff(0.142, 0.056);
        rightCuff.position.y = -0.215;
        rightElbow.add(rightCuff);

        var rightPawGroup = new THREE.Group();
        rightPawGroup.name = "panda-right-supporting-paw";
        rightPawGroup.position.set(0, -0.32, 0.01);
        rightPawGroup.rotation.x = 0.22;
        rightPawGroup.rotation.z = 0.36;
        rightPawGroup.rotation.y = 0.35;
        rightElbow.add(rightPawGroup);
        var rightPaw = createSoftPalm(0.122, [1.10, 0.94, 1.04]);
        rightPawGroup.add(rightPaw);

        var mainPalmPad = new THREE.Mesh(new THREE.SphereGeometry(0.062, 28, 20), padMat);
        mainPalmPad.scale.set(1.12, 0.76, 0.25);
        mainPalmPad.position.set(-0.020, -0.012, 0.107);
        mainPalmPad.rotation.z = 0.22;
        rightPawGroup.add(mainPalmPad);
        // Three cupped fingertips plus a clearly separated radial thumb.
        [
            { x: 0.070, y: -0.075, z: 0.038, rz: 0.14 },
            { x: 0.020, y: -0.090, z: 0.047, rz: 0 },
            { x: -0.030, y: -0.080, z: 0.039, rz: -0.14 }
        ].forEach(function (fd) {
            var digit = new THREE.Mesh(new THREE.SphereGeometry(0.035, 24, 18), blackFurMat);
            digit.scale.set(1.04, 1.22, 1.02);
            digit.position.set(fd.x, fd.y, fd.z);
            digit.rotation.x = -0.34;
            digit.rotation.z = fd.rz;
            rightPawGroup.add(digit);
            var dPad = new THREE.Mesh(new THREE.SphereGeometry(0.018, 18, 14), padMat);
            dPad.scale.set(0.88, 1.20, 0.34);
            dPad.position.set(fd.x, fd.y - 0.010, fd.z + 0.033);
            dPad.rotation.x = -0.34;
            rightPawGroup.add(dPad);
        });
        var rightThumb = new THREE.Mesh(new THREE.SphereGeometry(0.041, 24, 18), blackFurMat);
        rightThumb.scale.set(1.10, 1.19, 0.94);
        rightThumb.name = "panda-right-thumb";
        rightThumb.position.set(-0.092, -0.010, 0.042);
        rightThumb.rotation.z = -0.55;
        rightPawGroup.add(rightThumb);
        var thumbPad = new THREE.Mesh(new THREE.SphereGeometry(0.018, 18, 14), padMat);
        thumbPad.scale.set(0.85, 1.08, 0.34);
        thumbPad.position.set(-0.100, -0.015, 0.076);
        thumbPad.rotation.z = -0.55;
        rightPawGroup.add(thumbPad);

        // ---------- 6. 圆滚奶胖球形大熊猫头部、深邃晶莹大眼、精致金丝眼镜与 ω 微笑唇 ----------
        var headPivot = new THREE.Group();
        headPivot.position.set(0, 0.755, 0.012);
        spinePivot.add(headPivot);

        var HC_Y = 0.565;
        var headMesh = new THREE.Mesh(createSculptedPandaHeadGeometry(THREE), headFurMat);
        headMesh.position.set(0, HC_Y, 0);
        headPivot.add(headMesh);

        // 带凹陷耳窝的圆滚大熊猫绒球圆耳（自然嵌入圆润头顶曲线）
        var earGeo = createSculptedEarGeometry(THREE);
        var ears = [];
        [-1, 1].forEach(function (sx) {
            var earPivot = new THREE.Group();
            earPivot.position.set(0.455 * sx, HC_Y + 0.455, -0.022);
            earPivot.rotation.z = -0.34 * sx;
            earPivot.rotation.y = 0.14 * sx;
            headPivot.add(earPivot);

            var earOuter = new THREE.Mesh(earGeo, blackFurMat);
            earOuter.name = "panda-black-ear-" + sx;
            earPivot.add(earOuter);

            var earInner = new THREE.Mesh(new THREE.SphereGeometry(0.132, 28, 20), innerEarMat);
            earInner.scale.set(1.04, 1.02, 0.34);
            earInner.position.set(0, -0.012, 0.068);
            earPivot.add(earInner);

            ears.push({ pivot: earPivot, baseZ: earPivot.rotation.z, sx: sx });
        });

        // 深嵌八字黑眼圈中上部的大熊猫晶莹乌溜大眼 + 上睑纤细睫毛弧
        var irisTex = createIrisTexture(THREE, renderer);
        var irisMat = new THREE.MeshPhysicalMaterial({
            map: irisTex, roughness: 0.27, metalness: 0,
            clearcoat: 0.78, clearcoatRoughness: 0.14, envMapIntensity: 0.55
        });
        var scleraMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0xeee9e0), roughness: 0.46, metalness: 0, envMapIntensity: 0.40
        });
        var eyeRimMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x161414), roughness: 0.90, metalness: 0
        });
        var eyelidMat = new THREE.MeshStandardMaterial({
            color: srgbColor(THREE, 0x141214), roughness: 0.90, metalness: 0, side: THREE.DoubleSide
        });
        var eyelids = [], eyes = [];
        [-1, 1].forEach(function (sx) {
            var ex = 0.244 * sx;
            var eyRel = 0.038;
            var ez = evalHeadFrontZ(ex, eyRel) - 0.016;
            var eyeGroup = new THREE.Group();
            eyeGroup.name = "panda-eye-" + sx;
            eyeGroup.position.set(ex, HC_Y + eyRel, ez);
            eyeGroup.rotation.y = 0.28 * sx;
            eyeGroup.rotation.x = -0.02;
            headPivot.add(eyeGroup);

            var socketRim = new THREE.Mesh(new THREE.TorusGeometry(0.111, 0.0042, 12, 64), eyeRimMat);
            socketRim.scale.set(1, 1.065, 0.72);
            socketRim.position.z = 0.002;
            eyeGroup.add(socketRim);

            var lashPts = [
                new THREE.Vector3(-0.088 * sx, 0.044, 0.036),
                new THREE.Vector3(-0.024 * sx, 0.094, 0.044),
                new THREE.Vector3(0.054 * sx, 0.088, 0.038),
                new THREE.Vector3(0.102 * sx, 0.044, 0.024)
            ];
            eyeGroup.add(new THREE.Mesh(
                new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lashPts), 16, 0.0045, 6, false),
                eyeRimMat
            ));

            var sclera = new THREE.Mesh(new THREE.SphereGeometry(0.110, 40, 28), scleraMat);
            sclera.scale.set(1.0, 1.06, 0.46);
            eyeGroup.add(sclera);

            var gaze = new THREE.Group();
            gaze.position.set(-0.004 * sx, 0.004, 0);
            eyeGroup.add(gaze);
            var iris = new THREE.Mesh(createIrisDomeGeometry(THREE, 0.104, 0.018), irisMat);
            iris.name = "panda-iris-" + sx;
            iris.position.z = 0.037;
            gaze.add(iris);
            eyes.push({ gaze: gaze, sx: sx });

            var lidGeometry = new THREE.PlaneGeometry(1, 1, 40, 16);
            updatePandaEyelid(lidGeometry, 0);
            var lid = new THREE.Mesh(lidGeometry, eyelidMat);
            lid.name = "panda-eyelid-" + sx;
            lid.visible = false;
            eyeGroup.add(lid);
            eyelids.push(lid);
        });

        // ---------- 6B. 精致香槟金纤细圆框眼镜（轻盈衬托倾斜熊猫黑眼圈，绝不遮挡萌感轮廓） ----------
        var glassesGroup = new THREE.Group();
        glassesGroup.position.set(0, HC_Y + 0.032, 0);
        headPivot.add(glassesGroup);

        var lensMat = new THREE.MeshPhysicalMaterial
            ? new THREE.MeshPhysicalMaterial({
                color: srgbColor(THREE, 0xe6f6ff),
                transparent: true,
                opacity: 0.055,
                roughness: 0.06,
                metalness: 0.0,
                clearcoat: 1.0,
                envMapIntensity: 0.9,
                depthWrite: false
            })
            : new THREE.MeshStandardMaterial({
                color: srgbColor(THREE, 0xe6f6ff),
                transparent: true,
                opacity: 0.06,
                roughness: 0.08,
                depthWrite: false
            });

        var gFrontZ = evalHeadFrontZ(0.24, -0.14) + 0.042;
        [-1, 1].forEach(function (sx) {
            var rimWrap = new THREE.Group();
            rimWrap.position.set(0.270 * sx, 0, gFrontZ);
            rimWrap.rotation.y = 0.21 * sx;
            glassesGroup.add(rimWrap);

            var rim = new THREE.Mesh(new THREE.TorusGeometry(0.172, 0.0072, 24, 96), goldMat);
            rimWrap.add(rim);

            var lens = new THREE.Mesh(new THREE.CircleGeometry(0.165, 48), lensMat);
            rimWrap.add(lens);

            var templeCurve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(0.168 * sx, 0.020, -0.006),
                new THREE.Vector3(0.204 * sx, 0.042, -0.15),
                new THREE.Vector3(0.198 * sx, 0.068, -0.34)
            ]);
            var temple = new THREE.Mesh(new THREE.TubeGeometry(templeCurve, 16, 0.0052, 10, false), goldMat);
            rimWrap.add(temple);
        });

        var bridgeCurve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(-0.098, -0.004, gFrontZ + 0.030),
            new THREE.Vector3(-0.048, 0.028, gFrontZ + 0.054),
            new THREE.Vector3(0.0, 0.038, gFrontZ + 0.060),
            new THREE.Vector3(0.048, 0.028, gFrontZ + 0.054),
            new THREE.Vector3(0.098, -0.004, gFrontZ + 0.030)
        ]);
        var bridgeMesh = new THREE.Mesh(new THREE.TubeGeometry(bridgeCurve, 24, 0.0070, 12, false), goldMat);
        glassesGroup.add(bridgeMesh);

        // ---------- 6C. 饱满小熊鼻 + 鼻翼小纹 + 正宗大熊猫「人中 + ω 绒唇」萌系笑颜 ----------
        var noseYRel = -0.142;
        var noseSurfZ = evalHeadFrontZ(0, noseYRel);
        var noseMesh = new THREE.Mesh(createPandaNoseGeometry(THREE), noseMat);
        noseMesh.position.set(0, HC_Y + noseYRel, noseSurfZ - 0.010);
        noseMesh.rotation.x = 0.06;
        headPivot.add(noseMesh);

        // 鼻翼两侧精致微凹鼻孔弧纹
        [-1, 1].forEach(function (sx) {
            var nosPts = [
                new THREE.Vector3(0.032 * sx, HC_Y + noseYRel - 0.034, noseSurfZ + 0.022),
                new THREE.Vector3(0.052 * sx, HC_Y + noseYRel - 0.024, noseSurfZ + 0.016),
                new THREE.Vector3(0.064 * sx, HC_Y + noseYRel - 0.006, noseSurfZ + 0.006)
            ];
            headPivot.add(new THREE.Mesh(
                new THREE.TubeGeometry(new THREE.CatmullRomCurve3(nosPts), 10, 0.0036, 6, false),
                eyeRimMat
            ));
        });

        var closedMouth = new THREE.Group();
        headPivot.add(closedMouth);

        // 鼻下垂直人中短线（|）
        var philtrumPts = [];
        for (var pi = 0; pi < 6; pi++) {
            var pyPhil = -0.185 - (pi / 5) * 0.073; // -0.185 -> -0.258
            philtrumPts.push(new THREE.Vector3(0, HC_Y + pyPhil, evalHeadFrontZ(0, pyPhil) + 0.0055));
        }
        closedMouth.add(new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3(philtrumPts), 12, 0.0072, 10, false),
            lipMat
        ));

        // 标志性熊猫 ω 对称柔润双唇弧 + 嘴角温柔酒窝
        [-1, 1].forEach(function (sx) {
            var lobePts = [];
            var lobeSamples = 9;
            for (var li = 0; li < lobeSamples; li++) {
                var u = li / (lobeSamples - 1);
                var lx = sx * u * 0.138;
                var lyRel = -0.258 - Math.sin(u * Math.PI) * 0.034 + Math.pow(u, 2.2) * 0.008;
                lobePts.push(new THREE.Vector3(lx, HC_Y + lyRel, evalHeadFrontZ(lx, lyRel) + 0.006));
            }
            closedMouth.add(new THREE.Mesh(
                new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lobePts), 20, 0.0078, 10, false),
                lipMat
            ));

            var dimplePts = [
                new THREE.Vector3(0.136 * sx, HC_Y - 0.250, evalHeadFrontZ(0.136 * sx, -0.250) + 0.005),
                new THREE.Vector3(0.145 * sx, HC_Y - 0.244, evalHeadFrontZ(0.145 * sx, -0.244) + 0.005),
                new THREE.Vector3(0.152 * sx, HC_Y - 0.238, evalHeadFrontZ(0.152 * sx, -0.238) + 0.004)
            ];
            closedMouth.add(new THREE.Mesh(
                new THREE.TubeGeometry(new THREE.CatmullRomCurve3(dimplePts), 8, 0.0046, 8, false),
                lipMat
            ));
        });

        // 说话动态张合口腔与粉红小舌头（贴合 ω 微笑中心下方）
        var mouthYRel = -0.285;
        var mouthSurfZ = evalHeadFrontZ(0, mouthYRel);
        var mouthCavity = new THREE.Group();
        mouthCavity.position.set(0, HC_Y + mouthYRel, mouthSurfZ + 0.004);
        mouthCavity.rotation.x = 0.22;
        mouthCavity.scale.set(1, 0.01, 1);
        mouthCavity.visible = false;
        headPivot.add(mouthCavity);

        var mouthInner = new THREE.Mesh(
            new THREE.SphereGeometry(0.084, 24, 18),
            new THREE.MeshBasicMaterial({ color: srgbColor(THREE, 0x48141f) })
        );
        mouthInner.scale.set(1.24, 0.78, 0.32);
        mouthCavity.add(mouthInner);

        var tongue = new THREE.Mesh(
            new THREE.SphereGeometry(0.054, 18, 14),
            new THREE.MeshBasicMaterial({ color: srgbColor(THREE, 0xe86f86) })
        );
        tongue.scale.set(1.16, 0.52, 0.34);
        tongue.position.set(0, -0.022, 0.012);
        mouthCavity.add(tongue);

        // ---------- 7. 西华师大暗酒红学士帽：软布帽冠、圆角包边帽板与编织流苏 ----------
        var hatGroup = new THREE.Group();
        hatGroup.name = "panda-academic-hat";
        hatGroup.position.set(0, HC_Y + 0.532, -0.005);
        hatGroup.rotation.x = 0.095;
        hatGroup.rotation.z = -0.025;
        headPivot.add(hatGroup);

        var hatClothMat = crimsonCapMat.clone();
        hatClothMat.roughness = 0.82;
        hatClothMat.metalness = 0.0;
        var hatSeamMat = new THREE.MeshStandardMaterial({ color: srgbColor(THREE, 0x5c141e), roughness: 0.88 });
        var hatThreadMat = new THREE.MeshStandardMaterial({ color: srgbColor(THREE, 0xb24a58), roughness: 0.84 });
        var tasselThreadMat = new THREE.MeshStandardMaterial({ color: srgbColor(THREE, 0xd6ab4e), roughness: 0.58, metalness: 0.30 });

        // Rounded rolled band: no sharp cylinder caps at the forehead.
        var bandProfile = new THREE.SplineCurve([
            new THREE.Vector2(0.329, -0.021), new THREE.Vector2(0.344, -0.014),
            new THREE.Vector2(0.349, 0.009), new THREE.Vector2(0.344, 0.040),
            new THREE.Vector2(0.329, 0.059), new THREE.Vector2(0.321, 0.054)
        ]).getPoints(28);
        var bandGeo = new THREE.LatheGeometry(bandProfile, 64);
        var bp = bandGeo.attributes.position;
        for (var bi = 0; bi < bp.count; bi++) {
            var bx = bp.getX(bi), bz = bp.getZ(bi), byv = bp.getY(bi);
            var lowerWeight = Math.max(0, Math.min(1, (0.06 - byv) / 0.08));
            var frontPeak = Math.exp(-Math.pow(bx / 0.16, 2)) * Math.max(0, bz / 0.35) * 0.019;
            bp.setY(bi, byv - frontPeak * lowerWeight);
        }
        bandGeo.computeVertexNormals();
        var hatBand = new THREE.Mesh(bandGeo, navyBandMat);
        hatBand.name = "panda-hat-rolled-band";
        hatGroup.add(hatBand);

        // Gently bowed crown with shallow cloth fullness, rather than a straight bucket wall.
        var crownProfile = new THREE.SplineCurve([
            new THREE.Vector2(0.323, 0.040), new THREE.Vector2(0.335, 0.064),
            new THREE.Vector2(0.352, 0.115), new THREE.Vector2(0.363, 0.177),
            new THREE.Vector2(0.364, 0.222), new THREE.Vector2(0.353, 0.253)
        ]).getPoints(36);
        var crownGeo = new THREE.LatheGeometry(crownProfile, 64);
        var crownPos = crownGeo.attributes.position;
        for (var ci = 0; ci < crownPos.count; ci++) {
            var cx = crownPos.getX(ci), cz = crownPos.getZ(ci), cy = crownPos.getY(ci);
            var theta = Math.atan2(cx, cz);
            var fullness = Math.sin((cy - 0.040) / 0.213 * Math.PI);
            var pleat = 1 + Math.cos(theta * 8) * fullness * 0.005;
            crownPos.setXYZ(ci, cx * pleat, cy, cz * pleat);
        }
        crownGeo.computeVertexNormals();
        var hatCrown = new THREE.Mesh(crownGeo, hatClothMat);
        hatCrown.name = "panda-hat-cloth-crown";
        hatGroup.add(hatCrown);
        // Four restrained stitched panel seams, kept under the board.
        for (var hs = 0; hs < 4; hs++) {
            var seamAngle = Math.PI * 0.25 + hs * Math.PI * 0.5;
            var seamPts = crownProfile.map(function (v) {
                return new THREE.Vector3(Math.sin(seamAngle) * (v.x + 0.0012), v.y, Math.cos(seamAngle) * (v.x + 0.0012));
            });
            hatGroup.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seamPts), 24, 0.0015, 5, false), hatSeamMat));
        }

        var boardYaw = 0.66;
        var mortarBoardGroup = new THREE.Group();
        mortarBoardGroup.name = "panda-hat-beveled-board";
        mortarBoardGroup.position.y = 0.258;
        mortarBoardGroup.rotation.y = boardYaw;
        hatGroup.add(mortarBoardGroup);
        function roundedHatBoard(half, radius, depth, bevel) {
            var shape = new THREE.Shape();
            shape.moveTo(-half + radius, -half);
            shape.lineTo(half - radius, -half);
            shape.quadraticCurveTo(half, -half, half, -half + radius);
            shape.lineTo(half, half - radius);
            shape.quadraticCurveTo(half, half, half - radius, half);
            shape.lineTo(-half + radius, half);
            shape.quadraticCurveTo(-half, half, -half, half - radius);
            shape.lineTo(-half, -half + radius);
            shape.quadraticCurveTo(-half, -half, -half + radius, -half);
            var geo = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: true,
                bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, steps: 1, curveSegments: 5 });
            geo.rotateX(-Math.PI / 2);
            return { geometry: geo, outline: shape.getPoints(8) };
        }
        var bottomBoard = roundedHatBoard(0.469, 0.025, 0.014, 0.005);
        var boardBottom = new THREE.Mesh(bottomBoard.geometry, crimsonDarkEdgeMat);
        boardBottom.position.y = -0.006;
        mortarBoardGroup.add(boardBottom);
        var topBoard = roundedHatBoard(0.481, 0.026, 0.016, 0.005);
        var boardTop = new THREE.Mesh(topBoard.geometry, hatClothMat);
        boardTop.position.y = 0.013;
        mortarBoardGroup.add(boardTop);
        var pipingPts = topBoard.outline.map(function (v) {
            return new THREE.Vector3(v.x * 0.979, 0.035, -v.y * 0.979);
        });
        var boardPiping = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pipingPts, true), 96, 0.0017, 5, true), hatThreadMat);
        mortarBoardGroup.add(boardPiping);

        var topButton = new THREE.Mesh(new THREE.SphereGeometry(0.031, 24, 14), goldMat);
        topButton.scale.set(1, 0.42, 1);
        topButton.position.y = 0.304;
        hatGroup.add(topButton);

        // Cord reaches the rotated board's actual near edge before hanging freely.
        var rimDropX = 0.429, rimDropZ = 0.265;
        var topCordCurve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.0, 0.313, 0.0),
            new THREE.Vector3(rimDropX * 0.42, 0.309, rimDropZ * 0.44),
            new THREE.Vector3(rimDropX * 0.87, 0.306, rimDropZ * 0.88),
            new THREE.Vector3(rimDropX, 0.291, rimDropZ)
        ]);
        var cordAcross = new THREE.Mesh(new THREE.TubeGeometry(topCordCurve, 32, 0.0065, 8, false), tasselThreadMat);
        hatGroup.add(cordAcross);
        var tasselPivot = new THREE.Group();
        tasselPivot.name = "panda-hat-tassel";
        tasselPivot.position.set(rimDropX, 0.291, rimDropZ);
        hatGroup.add(tasselPivot);
        // Three slender twisted strands read as braided thread without a heavy metallic rod.
        for (var strand = 0; strand < 3; strand++) {
            var cordPts = [];
            for (var cs = 0; cs <= 28; cs++) {
                var tCord = cs / 28;
                var angleCord = strand * Math.PI * 2 / 3 + tCord * Math.PI * 7;
                cordPts.push(new THREE.Vector3(Math.cos(angleCord) * 0.0031, -tCord * 0.225, Math.sin(angleCord) * 0.0031));
            }
            tasselPivot.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cordPts), 56, 0.0026, 5, false), tasselThreadMat));
        }
        var tasselBead = new THREE.Mesh(new THREE.SphereGeometry(0.020, 20, 16), goldMat);
        tasselBead.scale.set(1, 1.18, 1);
        tasselBead.position.y = -0.232;
        tasselPivot.add(tasselBead);
        var beadCap = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.019, 0.014, 20), goldMat);
        beadCap.position.y = -0.252;
        tasselPivot.add(beadCap);
        var ginkgoCharm = new THREE.Mesh(createTrueGinkgoGeometry(THREE, 0.64), ginkgoMat);
        ginkgoCharm.position.set(0, -0.285, 0.004);
        ginkgoCharm.rotation.y = 0.16;
        ginkgoCharm.rotation.z = -0.06;
        tasselPivot.add(ginkgoCharm);

        // ---------- 8. 右掌上方：有书脊、压边书封和层叠纸芯的柔光全息书 ----------
        var holoBookGroup = new THREE.Group();
        holoBookGroup.name = "panda-holographic-book";
        holoBookGroup.position.set(-0.72, 1.33, 0.66);
        root.add(holoBookGroup);
        // Local +Z is the readable page side; point it at the panda's eyes.
        var bookReaderPosition = new THREE.Vector3(0, 1.74, 0.50);
        var bookAimMatrix = new THREE.Matrix4();
        var bookUp = new THREE.Vector3(0, 1, 0);
        var bookRoll = new THREE.Quaternion();
        var bookRollAxis = new THREE.Vector3(0, 0, 1);
        function orientBookForReader(t) {
            bookAimMatrix.lookAt(bookReaderPosition, holoBookGroup.position, bookUp);
            holoBookGroup.quaternion.setFromRotationMatrix(bookAimMatrix);
            bookRoll.setFromAxisAngle(bookRollAxis, Math.sin(t * 1.1) * 0.035);
            holoBookGroup.quaternion.multiply(bookRoll);
        }
        orientBookForReader(0);

        var pageTex = createHoloPageTexture(THREE);
        var pageFrontMat = new THREE.MeshStandardMaterial({
            map: pageTex, color: 0xe6f5f4,
            roughness: 0.70, metalness: 0,
            emissive: 0x15373b, emissiveIntensity: 0.16,
            side: THREE.FrontSide
        });
        var pageBackMat = new THREE.MeshStandardMaterial({
            color: 0xc4dfe0, roughness: 0.79, metalness: 0, side: THREE.BackSide
        });
        var pageInnerMat = pageFrontMat;
        var paperEdgeMat = new THREE.MeshStandardMaterial({
            color: 0xb9d9db, roughness: 0.79, metalness: 0,
            side: THREE.DoubleSide
        });
        var coverMat = new THREE.MeshStandardMaterial({
            color: 0x225266, roughness: 0.40, metalness: 0.12,
            emissive: 0x123b48, emissiveIntensity: 0.22,
            side: THREE.DoubleSide
        });
        var bookEdgeMat = new THREE.LineBasicMaterial({
            color: 0x83d6df, transparent: true, opacity: 0.68,
            depthWrite: false
        });
        // A single line loop traces the curved cover rather than a bright filled rectangle.
        function addBookPageEdge(parent, geometry, zOffset) {
            var pos = geometry.attributes.position;
            var nx = geometry.parameters.widthSegments;
            var ny = geometry.parameters.heightSegments;
            var points = [];
            function push(col, row) {
                var i = row * (nx + 1) + col;
                points.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i) + zOffset));
            }
            for (var col = 0; col <= nx; col++) push(col, 0);
            for (var row = 1; row <= ny; row++) push(nx, row);
            for (var col = nx - 1; col >= 0; col--) push(col, ny);
            for (var row = ny - 1; row > 0; row--) push(0, row);
            parent.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), bookEdgeMat));
        }

        [-1, 1].forEach(function (sx) {
            var openLeaf = new THREE.Group();
            openLeaf.rotation.y = -0.32 * sx;
            holoBookGroup.add(openLeaf);

            var coverSurface = createCurvedPageGeometry(THREE, 0.236, 0.308, sx, 0.027);
            var coverPage = new THREE.Mesh(thickenClothGeometry(THREE, coverSurface, 0.008), coverMat);
            coverPage.name = "panda-book-cover-" + sx;
            coverPage.position.z = -0.018;
            openLeaf.add(coverPage);
            addBookPageEdge(openLeaf, coverSurface, -0.016);
            coverSurface.dispose();

            // A closed paper block gives an actual fore-edge, even in the side view.
            var paperSurface = createCurvedPageGeometry(THREE, 0.224, 0.295, sx, 0.032);
            var paperBlock = new THREE.Mesh(thickenClothGeometry(THREE, paperSurface, 0.009), paperEdgeMat);
            paperBlock.name = "panda-book-paper-block-" + sx;
            paperBlock.position.z = -0.003;
            openLeaf.add(paperBlock);
            paperSurface.dispose();
            [0.000, 0.004].forEach(function (offset) {
                var leaf = new THREE.Mesh(createCurvedPageGeometry(THREE, 0.224, 0.295, sx, 0.033 + offset * 0.3), paperEdgeMat);
                leaf.position.z = offset;
                openLeaf.add(leaf);
            });
            var mainPage = new THREE.Mesh(createCurvedPageGeometry(THREE, 0.224, 0.295, sx, 0.036), pageFrontMat);
            mainPage.name = "panda-book-reading-page-" + sx;
            mainPage.position.z = 0.009;
            openLeaf.add(mainPage);
            var mainPageBack = new THREE.Mesh(mainPage.geometry, pageBackMat);
            mainPageBack.position.copy(mainPage.position);
            openLeaf.add(mainPageBack);
        });

        // Two light pages keep the existing flutter animation contract and stay close to the binding.
        var flutterPages = [];
        [0.46, 0.70].forEach(function (ang, fi) {
            var fLeaf = new THREE.Group();
            fLeaf.rotation.y = ang;
            var fMesh = new THREE.Mesh(createCurvedPageGeometry(THREE, 0.218, 0.290, -1, 0.040), pageInnerMat);
            fMesh.position.z = 0.016 + fi * 0.008;
            fLeaf.add(fMesh);
            var flutterBack = new THREE.Mesh(fMesh.geometry, pageBackMat);
            flutterBack.position.copy(fMesh.position);
            fLeaf.add(flutterBack);
            holoBookGroup.add(fLeaf);
            flutterPages.push({ group: fLeaf, baseY: ang, ph: fi * 1.4 });
        });

        var spineMat = new THREE.MeshStandardMaterial({
            color: 0x244f60, roughness: 0.44, metalness: 0.10,
            emissive: 0x12343b, emissiveIntensity: 0.22
        });
        var spineGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.310, 20), spineMat);
        spineGlow.position.z = -0.014;
        holoBookGroup.add(spineGlow);
        [-0.113, 0.113].forEach(function (y) {
            var band = new THREE.Mesh(new THREE.TorusGeometry(0.0135, 0.0018, 6, 20), goldMat);
            band.rotation.x = Math.PI * 0.5;
            band.position.set(0, y, -0.014);
            holoBookGroup.add(band);
        });

        var bookHaloSprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: createSoftOrbTexture(THREE, "rgba(72, 210, 229, 0.16)", "rgba(28, 145, 180, 0.06)"),
            transparent: true, opacity: 0.42, blending: additive, depthWrite: false
        }));
        bookHaloSprite.position.z = -0.030;
        bookHaloSprite.scale.set(0.66, 0.66, 1);
        holoBookGroup.add(bookHaloSprite);

        var orbTex = createSoftOrbTexture(THREE, "rgba(220, 252, 255, 0.80)", "rgba(96, 210, 230, 0.38)");
        var sparkCount = 12;
        var sparkPos = new Float32Array(sparkCount * 3);
        var sparkSeeds = [];
        for (var si = 0; si < sparkCount; si++) {
            var sx0 = (Math.random() - 0.5) * 0.45;
            var sy0 = (Math.random() - 0.3) * 0.38;
            var sz0 = (Math.random() - 0.5) * 0.22;
            sparkPos[si * 3] = sx0;
            sparkPos[si * 3 + 1] = sy0;
            sparkPos[si * 3 + 2] = sz0;
            sparkSeeds.push({ x: sx0, y: sy0, z: sz0, ph: Math.random() * Math.PI * 2 });
        }
        var sparkGeo = new THREE.BufferGeometry();
        sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
        var sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
            map: orbTex, color: 0x8bcfdc, size: 0.038,
            transparent: true, opacity: 0.58, blending: additive, depthWrite: false
        }));
        holoBookGroup.add(sparks);

        var bookLight = new THREE.PointLight(0x70c1d3, 0.24, 1.7);
        bookLight.position.set(-0.76, 1.35, 0.52);
        root.add(bookLight);

        // Preserve the character's separate rim light.
        var rimLight = new THREE.DirectionalLight(0x8fa9cf, 0.36);
        rimLight.position.set(2.8, 2.8, -2.4);
        root.add(rimLight);

        // ---------- 9. 舞台四周飘浮的真·扇形金色银杏叶（精确对位设计图三片银杏叶！） ----------
        var floatingLeaves = [];
        var leafConfigs = [
            { x: -0.82, y: 1.80, z: 0.14, s: 0.44, rx: 0.28, ry: 0.35, rz: 2.35, ph: 0.3 },
            { x: -0.62, y: 0.44, z: 0.24, s: 0.38, rx: -0.22, ry: 0.42, rz: 2.85, ph: 1.9 },
            { x: 0.84, y: 1.24, z: 0.08, s: 0.40, rx: 0.32, ry: -0.45, rz: -1.85, ph: 3.5 }
        ];
        leafConfigs.forEach(function (cfg) {
            var leafMesh = new THREE.Mesh(createTrueGinkgoGeometry(THREE, cfg.s), ginkgoMat);
            leafMesh.position.set(cfg.x, cfg.y, cfg.z);
            leafMesh.rotation.set(cfg.rx, cfg.ry, cfg.rz);
            root.add(leafMesh);
            floatingLeaves.push({ mesh: leafMesh, cfg: cfg });
        });

        // ---------- 动画状态、情绪动作机与身份光环联动 ----------
        var blinkTimer = 2.4;
        var blinkPhase = -1;
        var lastHeadY = 0;
        var tasselVel = 0;
        var tasselAngle = 0;
        var userYaw = 0;

        var PERSONA_THEMES = {
            "default": { core: 0x00e5ff, bloom: 0x38bdf8, inner: 0x38bdf8, rim: 0x8fa9cf, spark: 0x8bcfdc },
            "career": { core: 0x38bdf8, bloom: 0xfbbf24, inner: 0x0ea5e9, rim: 0xfcd34d, spark: 0xfde68a },
            "mental": { core: 0x34d399, bloom: 0x6ee7b7, inner: 0x2dd4bf, rim: 0xa7f3d0, spark: 0xa7f3d0 }
        };
        var personaKey = "default";
        var personaLerp = {
            core: new THREE.Color(PERSONA_THEMES["default"].core),
            bloom: new THREE.Color(PERSONA_THEMES["default"].bloom),
            inner: new THREE.Color(PERSONA_THEMES["default"].inner),
            rim: new THREE.Color(PERSONA_THEMES["default"].rim),
            spark: new THREE.Color(PERSONA_THEMES["default"].spark)
        };
        var GESTURE_DURATIONS = { wave: 1.8, nod: 1.3, book: 2.0, celebrate: 2.0 };
        var gesture = { kind: null, elapsed: 0, duration: 0 };

        function triggerGesture(kind, durationSec) {
            if (!GESTURE_DURATIONS[kind]) return false;
            gesture.kind = kind;
            gesture.elapsed = 0;
            gesture.duration = Math.max(0.5, Number(durationSec) || GESTURE_DURATIONS[kind]);
            return true;
        }

        function setPersona(roleKey) {
            var nextKey = PERSONA_THEMES[roleKey] ? roleKey : "default";
            personaKey = nextKey;
            var th = PERSONA_THEMES[nextKey];
            personaLerp.core.setHex(th.core);
            personaLerp.bloom.setHex(th.bloom);
            personaLerp.inner.setHex(th.inner);
            personaLerp.rim.setHex(th.rim);
            personaLerp.spark.setHex(th.spark);
            return personaKey;
        }

        function update(t, dt, state) {
            var speaking = !!(state && state.voiceActive);
            var mouthPulse = (state && state.mouthPulse) || 0;
            var audioLevel = Math.max(0, Math.min(1, Number((state && state.audioLevel) || 0)));
            var px = (state && state.pointerNX) || 0;
            var py = (state && state.pointerNY) || 0;
            var isThinking = !!(state && state.thinking);

            // 平滑推进当前触发的情绪/交互动作包络
            var gKind = gesture.kind;
            var gP = 0;
            var gEnv = 0;
            if (gKind) {
                gesture.elapsed += dt;
                gP = Math.min(1, gesture.elapsed / Math.max(0.1, gesture.duration));
                gEnv = Math.sin(Math.PI * gP);
                if (gP >= 1) {
                    gesture.kind = null;
                }
            }

            var colorBlend = Math.min(1, dt * 4.5);
            outerRingCore.material.color.lerp(personaLerp.core, colorBlend);
            outerRingBloom.material.color.lerp(personaLerp.bloom, colorBlend);
            innerRing.material.color.lerp(personaLerp.inner, colorBlend);
            rimLight.color.lerp(personaLerp.rim, colorBlend);
            sparks.material.color.lerp(personaLerp.spark, colorBlend);

            var celebrateBounce = gKind === "celebrate" ? Math.abs(Math.sin(gP * Math.PI * 3)) * 0.042 * gEnv : 0;
            var nodBodyLean = gKind === "nod" ? gEnv * 0.036 : 0;

            // 柔和呼吸起伏
            bodyBob.position.y = Math.sin(t * 1.8) * 0.014 + celebrateBounce;
            spinePivot.rotation.z = Math.sin(t * 0.9) * 0.013 + (gKind === "wave" ? -gEnv * 0.04 : 0);
            spinePivot.rotation.x = Math.sin(t * 1.8 + 0.5) * (speaking ? 0.020 : 0.009) + nodBodyLean;

            // 头部平滑跟随鼠标视线 + 说话轻点头 + 情绪动作叠加
            var nodHeadDelta = gKind === "nod" ? Math.sin(gP * Math.PI * 4) * 0.16 * gEnv : 0;
            var tiltHeadDelta = gKind === "wave" ? gEnv * 0.075 : (gKind === "celebrate" ? Math.sin(gP * Math.PI * 4) * 0.055 * gEnv : 0);
            var targetHeadY = px * 0.26 + Math.sin(t * 0.55) * 0.035;
            var targetHeadX = py * 0.13 + Math.sin(t * 1.1) * 0.016 + (speaking ? Math.sin(t * 6.5) * 0.024 : 0) + nodHeadDelta;
            headPivot.rotation.y += (targetHeadY - headPivot.rotation.y) * Math.min(1, dt * 6);
            headPivot.rotation.x += (targetHeadX - headPivot.rotation.x) * Math.min(1, dt * 6);
            headPivot.rotation.z = -px * 0.045 + (isThinking ? Math.sin(t * 2.4) * 0.038 : 0) + tiltHeadDelta;

            // 圆耳朵灵动微颤
            var earAmp = (speaking || gKind === "celebrate") ? 0.055 : 0.018;
            ears.forEach(function (ear, idx) {
                ear.pivot.rotation.z = ear.baseZ + Math.sin(t * 3.2 + idx * 1.7) * earAmp * ear.sx;
            });

            // 银杏叶流苏惯性单摆物理晃动
            var headYawDelta = (headPivot.rotation.y - lastHeadY) / Math.max(0.008, dt);
            lastHeadY = headPivot.rotation.y;
            tasselVel += (-headYawDelta * 0.16 - tasselAngle * 18.0) * dt;
            tasselVel *= Math.pow(0.18, dt);
            tasselAngle = Math.max(-0.30, Math.min(0.30, tasselAngle + tasselVel * dt));
            tasselPivot.rotation.z = 0.04 + tasselAngle + Math.sin(t * 1.6) * 0.022;
            tasselPivot.rotation.x = Math.cos(t * 1.3) * 0.018;

            // 自然眨眼
            if (t > blinkTimer && blinkPhase < 0) {
                blinkPhase = 0;
                blinkTimer = t + 2.5 + Math.random() * 2.8;
            }
            var lidClosed = 0;
            if (blinkPhase >= 0) {
                blinkPhase += dt / 0.15;
                lidClosed = blinkPhase < 0.5 ? blinkPhase * 2 : Math.max(0, 2 - blinkPhase * 2);
                if (blinkPhase >= 1) {
                    blinkPhase = -1;
                    lidClosed = 0;
                }
            }
            eyelids.forEach(function (lid) {
                var wasVisible = lid.visible;
                lid.visible = lidClosed > 0.015;
                if (lid.visible || wasVisible) updatePandaEyelid(lid.geometry, lidClosed);
            });
            eyes.forEach(function (eye) {
                var targetX = -0.004 * eye.sx + px * 0.007;
                var targetY = 0.004 - py * 0.005;
                eye.gaze.position.x += (targetX - eye.gaze.position.x) * Math.min(1, dt * 5);
                eye.gaze.position.y += (targetY - eye.gaze.position.y) * Math.min(1, dt * 5);
            });

            // 说话动态口型（闭嘴时纯享温柔微笑弧，说话时按韵律/音频电平张合）
            var openTarget = 0.01;
            if (speaking) {
                openTarget = Math.max(
                    0.36 + 0.44 * Math.abs(Math.sin(t * 10.5)) + 0.18 * mouthPulse,
                    audioLevel > 0 ? (0.24 + audioLevel * 0.72) : 0
                );
            }
            var curOpen = mouthCavity.scale.y;
            var nextOpen = curOpen + (Math.min(1.0, openTarget) - curOpen) * Math.min(1, dt * 16);
            mouthCavity.scale.y = nextOpen;
            mouthCavity.visible = nextOpen > 0.06;
            closedMouth.visible = !mouthCavity.visible;

            // 托书右手与挥手左手协同互动（保持书本文字始终面向熊猫阅读方向）
            var talkWave = speaking ? Math.sin(t * 3.6) * 0.065 : 0;
            var bookArmBoost = gKind === "book" ? -gEnv * 0.17 : (gKind === "celebrate" ? -gEnv * 0.22 : 0);
            rightElbow.rotation.x = -1.36 + Math.sin(t * 1.8) * 0.032 + talkWave + bookArmBoost;

            var waveZ = 0;
            var waveX = 0;
            if (gKind === "wave") {
                waveZ = gEnv * (1.42 + Math.sin(gP * Math.PI * 5) * 0.22);
                waveX = -gEnv * 0.34;
            } else if (gKind === "celebrate") {
                waveZ = gEnv * (0.95 + Math.sin(gP * Math.PI * 6) * 0.24);
                waveX = -gEnv * 0.26;
            }
            leftShoulder.rotation.z = 0.25 + waveZ;
            leftShoulder.rotation.x = 0.04 + Math.sin(t * 1.4 + 1.1) * (speaking ? 0.075 : 0.028) + waveX;

            // 全息书卷悬浮呼吸、内页微颤翻动与星尘微升
            var bookLift = gKind === "book" ? gEnv * 0.085 : 0;
            var flutterBoost = gKind === "book" ? (1 + gEnv * 1.6) : 1;
            var sparkBoost = (gKind === "book" || gKind === "celebrate") ? (1 + gEnv * 1.5) : 1;
            holoBookGroup.position.y = 1.33 + Math.sin(t * 2.1) * 0.034 + talkWave * 0.16 + bookLift;
            orientBookForReader(t);
            flutterPages.forEach(function (fp) {
                fp.group.rotation.y = fp.baseY + Math.sin(t * 2.6 * flutterBoost + fp.ph) * (speaking ? 0.08 : 0.035);
            });
            var posArr = sparkGeo.attributes.position.array;
            for (var i = 0; i < sparkCount; i++) {
                var sd = sparkSeeds[i];
                posArr[i * 3 + 1] = sd.y + ((t * 0.11 * sparkBoost + sd.ph * 0.1) % 0.30);
                posArr[i * 3] = sd.x + Math.sin(t * 1.8 + sd.ph) * 0.018;
            }
            sparkGeo.attributes.position.needsUpdate = true;

            // 舞台四周银杏叶轻盈律动
            var leafRate = gKind === "celebrate" ? 1.8 : 1.0;
            floatingLeaves.forEach(function (item) {
                var c = item.cfg;
                item.mesh.position.y = c.y + Math.sin(t * 1.3 * leafRate + c.ph) * 0.05;
                item.mesh.rotation.z = c.rz + Math.sin(t * 0.9 * leafRate + c.ph) * 0.12;
                item.mesh.rotation.y = c.ry + Math.cos(t * 0.7 * leafRate + c.ph) * 0.14;
            });

            // 底座双层全息光环呼吸
            outerRingCore.material.opacity = 0.84 + Math.sin(t * 2.4) * 0.11;
            outerRingBloom.material.opacity = 0.28 + Math.sin(t * 2.4) * 0.09;
            innerRing.material.opacity = 0.62 + Math.cos(t * 2.4) * 0.14;

            var targetYaw = basePoseYaw + userYaw;
            root.rotation.y += (targetYaw - root.rotation.y) * Math.min(1, dt * 8);
        }

        return {
            root: root,
            envMap: envMap,
            cameraPreset: { fov: 32, pos: [0, 1.42, 4.95], lookAt: [0, 1.30, 0] },
            update: update,
            addYaw: function (delta) {
                userYaw = Math.max(-Math.PI, Math.min(Math.PI, userYaw + delta));
            },
            resetYaw: function () { userYaw = 0; },
            triggerGesture: triggerGesture,
            setPersona: setPersona,
            getGesture: function () { return gesture.kind; }
        };
    };
})();
