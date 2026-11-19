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
        mat.onBeforeCompile = function (shader) {
            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <dithering_fragment>",
                [
                    "vec3 vNorm = normalize(vNormal);",
                    "vec3 vView = normalize(vViewPosition);",
                    "float fres = pow(1.0 - clamp(abs(dot(vNorm, vView)), 0.0, 1.0), 3.0);",
                    "float leftCyanMask = clamp(-vNorm.x * 0.65 + 0.35, 0.0, 1.0) * clamp(-vNorm.y * 0.4 + 0.7, 0.0, 1.0);",
                    "vec3 rimCol = mix(" + rimCool + ", " + rimCyan + ", leftCyanMask);",
                    "gl_FragColor.rgb += rimCol * fres * " + rimStrength + ";",
                    "#include <dithering_fragment>"
                ].join("\n")
            );
        };
        return mat;
    }

    // ---------- 3. 2048×1024 头部等距球面烘焙贴图（八字水滴黑眼圈 + 腮红 + 帽下 AO + 吻部柔影） ----------
    function createHeadTexture(THREE, renderer) {
        var W = 2048, H = 1024;
        var c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        var ctx = c.getContext("2d");

        // 柔和暖白至冷灰蓝顶底微渐变底色（还原设计图柔光球体明暗体积）
        var baseGrad = ctx.createLinearGradient(0, 0, 0, H);
        baseGrad.addColorStop(0.00, "#dce4f2");
        baseGrad.addColorStop(0.18, "#eef3fa");
        baseGrad.addColorStop(0.58, "#f4f7fc");
        baseGrad.addColorStop(0.84, "#dde6f4");
        baseGrad.addColorStop(1.00, "#b8c6de");
        ctx.fillStyle = baseGrad;
        ctx.fillRect(0, 0, W, H);

        // 两侧脸颊与脑后柔和立体冷调环境暗部（u=0.5 为正前脸）
        var sideLeft = ctx.createLinearGradient(0, 0, W * 0.40, 0);
        sideLeft.addColorStop(0.0, "rgba(156, 176, 208, 0.38)");
        sideLeft.addColorStop(0.72, "rgba(175, 194, 222, 0.14)");
        sideLeft.addColorStop(1.0, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = sideLeft;
        ctx.fillRect(0, 0, W * 0.42, H);

        var sideRight = ctx.createLinearGradient(W, 0, W * 0.60, 0);
        sideRight.addColorStop(0.0, "rgba(148, 168, 204, 0.42)");
        sideRight.addColorStop(0.72, "rgba(170, 190, 220, 0.16)");
        sideRight.addColorStop(1.0, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = sideRight;
        ctx.fillRect(W * 0.58, 0, W * 0.42, H);

        // 额头上方学士帽帽圈接触环境光遮蔽（Contact AO）
        var capAO = ctx.createLinearGradient(0, H * 0.11, 0, H * 0.25);
        capAO.addColorStop(0.0, "rgba(24, 34, 58, 0.46)");
        capAO.addColorStop(0.55, "rgba(52, 68, 102, 0.16)");
        capAO.addColorStop(1.0, "rgba(52, 68, 102, 0)");
        ctx.fillStyle = capAO;
        ctx.fillRect(0, 0, W, H * 0.26);

        // 下颌与颈部交界接触阴影（让下巴与白衬衫领自然分离）
        var neckAO = ctx.createLinearGradient(0, H * 0.82, 0, H);
        neckAO.addColorStop(0.0, "rgba(120, 138, 172, 0)");
        neckAO.addColorStop(0.55, "rgba(96, 114, 148, 0.32)");
        neckAO.addColorStop(1.0, "rgba(62, 78, 110, 0.58)");
        ctx.fillStyle = neckAO;
        ctx.fillRect(0, H * 0.82, W, H * 0.18);

        // 吻部下方与微笑唇下缘柔和立体凹陷暗影
        var chinShade = ctx.createRadialGradient(W * 0.5, H * 0.695, 10, W * 0.5, H * 0.695, 145);
        chinShade.addColorStop(0.0, "rgba(128, 146, 178, 0.30)");
        chinShade.addColorStop(0.65, "rgba(148, 166, 196, 0.12)");
        chinShade.addColorStop(1.0, "rgba(148, 166, 196, 0)");
        ctx.fillStyle = chinShade;
        ctx.beginPath();
        ctx.ellipse(W * 0.5, H * 0.695, 160, 75, 0, 0, Math.PI * 2);
        ctx.fill();

        // 柔和蜜桃粉腮红（无缝融于脸颊绒毛，绝不穿模）
        [-1, 1].forEach(function (sx) {
            var bx = W * (0.5 + sx * 0.106);
            var by = H * 0.585;
            var bg = ctx.createRadialGradient(bx, by, 6, bx, by, 86);
            bg.addColorStop(0.0, "rgba(255, 152, 172, 0.22)");
            bg.addColorStop(0.55, "rgba(255, 164, 182, 0.10)");
            bg.addColorStop(1.0, "rgba(255, 164, 182, 0)");
            ctx.fillStyle = bg;
            ctx.beginPath();
            ctx.arc(bx, by, 88, 0, Math.PI * 2);
            ctx.fill();
        });

        // 经典幼年大熊猫「上窄内收、下宽外垂」八字水滴形黑眼圈（带细腻绒毛柔化边缘）
        function drawTeardropPatch(sx, blurPx, fillCol, scaleMul) {
            ctx.save();
            ctx.translate(W * (0.5 + sx * 0.080), H * 0.492);
            ctx.rotate(sx * 0.44);
            ctx.scale(sx * scaleMul, scaleMul);
            if (blurPx > 0 && typeof ctx.filter === "string") {
                ctx.filter = "blur(" + blurPx + "px)";
            }
            ctx.beginPath();
            // 顶部内侧圆润收窄，外下侧饱满垂落如水滴/梨形
            ctx.moveTo(-8, -98);
            ctx.bezierCurveTo(48, -102, 92, -42, 96, 36);
            ctx.bezierCurveTo(98, 96, 48, 126, -6, 118);
            ctx.bezierCurveTo(-58, 110, -84, 64, -78, -4);
            ctx.bezierCurveTo(-74, -64, -48, -95, -8, -98);
            ctx.closePath();
            ctx.fillStyle = fillCol;
            ctx.fill();
            ctx.restore();
        }
        [-1, 1].forEach(function (sx) {
            // 外层微绒过渡羽化边 + 内层深炭黑绒毛主体
            drawTeardropPatch(sx, 5, "rgba(32, 37, 47, 0.55)", 1.03);
            drawTeardropPatch(sx, 0, "#212630", 1.00);
        });

        // 吻部鼻梁高光柔白提亮
        var muzzleGlow = ctx.createRadialGradient(W * 0.5, H * 0.575, 8, W * 0.5, H * 0.585, 118);
        muzzleGlow.addColorStop(0.0, "rgba(255, 255, 255, 0.55)");
        muzzleGlow.addColorStop(0.7, "rgba(248, 251, 255, 0.22)");
        muzzleGlow.addColorStop(1.0, "rgba(248, 251, 255, 0)");
        ctx.fillStyle = muzzleGlow;
        ctx.beginPath();
        ctx.ellipse(W * 0.5, H * 0.585, 122, 86, 0, 0, Math.PI * 2);
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

    // ---------- 5. 深邃黑曜石晶莹瞳仁贴图（告别橙棕圆环，精准还原设计图清澈黑亮大眼） ----------
    function createIrisTexture(THREE, renderer) {
        var S = 512;
        var c = document.createElement("canvas");
        c.width = c.height = S;
        var ctx = c.getContext("2d");
        var r = S * 0.5;

        // 外缘深冷灰黑虹膜 -> 中央纯黑深邃瞳孔
        var g = ctx.createRadialGradient(r, r * 1.08, S * 0.05, r, r, r * 0.98);
        g.addColorStop(0.00, "#07090e");
        g.addColorStop(0.54, "#0d111a");
        g.addColorStop(0.80, "#232a38");
        g.addColorStop(0.93, "#141821");
        g.addColorStop(1.00, "#090b10");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(r, r, r - 2, 0, Math.PI * 2);
        ctx.fill();

        // 底部通透玻璃体冷灰蓝微弱月牙反光（正是设计图中眼底那抹灵动水光！）
        ctx.strokeStyle = "rgba(142, 168, 206, 0.32)";
        ctx.lineWidth = 18;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(r, r * 1.01, r * 0.72, Math.PI * 0.18, Math.PI * 0.82);
        ctx.stroke();

        // 中央大纯黑瞳仁
        ctx.fillStyle = "#05070b";
        ctx.beginPath();
        ctx.arc(r, r * 0.98, r * 0.56, 0, Math.PI * 2);
        ctx.fill();

        // 左上 10:30 方向主圆润亮白高光 + 右下 4:30 微星副高光
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(r * 0.62, r * 0.62, r * 0.21, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(255, 255, 255, 0.86)";
        ctx.beginPath();
        ctx.arc(r * 1.32, r * 1.30, r * 0.075, 0, Math.PI * 2);
        ctx.fill();

        return srgbTex(THREE, new THREE.CanvasTexture(c), renderer);
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
        var W = 256, H = 320;
        var c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        var ctx = c.getContext("2d");

        // 中心半透冰青、四周边框高亮发光的全息玻璃书页质感（去掉原先显呆板的粗横条）
        var bg = ctx.createRadialGradient(W * 0.5, H * 0.5, 20, W * 0.5, H * 0.5, H * 0.65);
        bg.addColorStop(0.0, "rgba(36, 204, 238, 0.24)");
        bg.addColorStop(0.72, "rgba(56, 228, 255, 0.44)");
        bg.addColorStop(1.0, "rgba(156, 250, 255, 0.78)");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        ctx.strokeStyle = "rgba(215, 254, 255, 0.95)";
        ctx.lineWidth = 7;
        ctx.strokeRect(5, 5, W - 10, H - 10);

        ctx.strokeStyle = "rgba(140, 248, 255, 0.35)";
        ctx.lineWidth = 2;
        ctx.strokeRect(16, 16, W - 32, H - 32);

        // 极淡若隐若现的全息流光暗纹
        ctx.fillStyle = "rgba(205, 253, 255, 0.16)";
        for (var y = 44; y < H - 44; y += 28) {
            ctx.fillRect(34, y, W - 68 - (y % 56 === 0 ? 28 : 0), 3);
        }
        return new THREE.CanvasTexture(c);
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
            var u = sideSign > 0 ? (x / w + 0.5) : (0.5 - x / w);
            // 经典翻开古籍的海鸥翼 S 形微拱曲面
            var z = Math.sin(u * Math.PI * 0.92) * archAmt - Math.pow(u, 2.2) * (archAmt * 0.42);
            z += Math.pow(y / h, 2) * 0.008;
            pos.setX(i, x + sideSign * w * 0.5);
            pos.setZ(i, z);
        }
        geo.computeVertexNormals();
        return geo;
    }

    // ---------- 8. 解析式连续顶点雕刻：婴儿肥梨形圆脸 + 一体式柔和吻部 ----------
    function createSculptedPandaHeadGeometry(THREE) {
        // phiStart = -PI/2 保证 u=0.5 精确落在 +Z 正脸中央，接缝隐藏在 -Z 后脑勺
        var geo = new THREE.SphereGeometry(1.0, 128, 96, -Math.PI * 0.5, Math.PI * 2);
        var pos = geo.attributes.position;

        for (var i = 0; i < pos.count; i++) {
            var nx = pos.getX(i);
            var ny = pos.getY(i);
            var nz = pos.getZ(i);

            // 基础椭球尺度（严格对照设计图：总宽 ~1.28，总高 ~1.12，前后深 ~1.10）
            var sx = 0.615;
            var sy = 0.560;
            var sz = 0.548;

            // 1) 头顶帽圈区域自然微收、两腮向下圆润饱满外扩（幼年熊猫标志性梨形婴儿肥轮廓！）
            var crownTaper = ny > 0.15 ? Math.pow((ny - 0.15) / 0.85, 1.45) * 0.088 : 0.0;
            var cheekBand = Math.exp(-Math.pow((ny + 0.22) / 0.40, 2.0));
            var sideCheek = cheekBand * (0.056 + 0.022 * Math.max(0, nz));
            sx = sx - crownTaper + sideCheek;
            sz = sz - crownTaper * 0.55 + cheekBand * 0.024;

            var x = nx * sx;
            var y = ny * sy;
            var z = nz * sz;

            // 2) 下巴底部柔和托平微圆（避免尖下巴，贴合衬衫领口）
            if (ny < -0.45) {
                var chinFlatten = Math.pow((-ny - 0.45) / 0.55, 1.7);
                y += chinFlatten * 0.028;
            }

            // 3) 眼窝微平缓凹槽（让大眼睛自然嵌合在脸颊曲面上，而非凸出眼球）
            if (nz > 0.25) {
                var eyeDistL = Math.pow((nx + 0.44) / 0.28, 2.0) + Math.pow((ny - 0.05) / 0.28, 2.0);
                var eyeDistR = Math.pow((nx - 0.44) / 0.28, 2.0) + Math.pow((ny - 0.05) / 0.28, 2.0);
                var socket = (Math.exp(-eyeDistL) + Math.exp(-eyeDistR)) * 0.018;
                z -= socket;

                // 4) 一体式无接缝柔和吻部隆起（彻底消除球体拼贴折痕！）
                var muzR2 = Math.pow(nx / 0.39, 2.0) + Math.pow((ny + 0.29) / 0.31, 2.0);
                var muzSwelling = Math.exp(-muzR2 * 1.15) * Math.max(0, nz);
                z += muzSwelling * 0.096;
                y -= muzSwelling * 0.012;

                // 下唇下方微收颌沟，让微笑唇更立体饱满
                var underLipR2 = Math.pow(nx / 0.30, 2.0) + Math.pow((ny + 0.56) / 0.14, 2.0);
                z -= Math.exp(-underLipR2) * 0.014;
            }

            pos.setXYZ(i, x, y, z);
        }
        geo.computeVertexNormals();
        return geo;
    }

    // 雕刻带真实凹陷耳窝的圆润熊猫耳
    function createSculptedEarGeometry(THREE) {
        var geo = new THREE.SphereGeometry(0.215, 40, 32);
        var pos = geo.attributes.position;
        for (var i = 0; i < pos.count; i++) {
            var x = pos.getX(i) * 1.04;
            var y = pos.getY(i) * 1.00;
            var z = pos.getZ(i) * 0.56;
            if (z > 0) {
                var r2 = (x * x + (y + 0.015) * (y + 0.015)) / (0.145 * 0.145);
                if (r2 < 1.35) {
                    z -= Math.exp(-r2 * 1.4) * 0.048;
                }
            }
            pos.setXYZ(i, x, y, z);
        }
        geo.computeVertexNormals();
        return geo;
    }

    // 圆润倒三角心形熊猫鼻几何
    function createPandaNoseGeometry(THREE) {
        var shape = new THREE.Shape();
        shape.moveTo(0, 0.036);
        shape.bezierCurveTo(0.056, 0.040, 0.086, 0.024, 0.080, -0.002);
        shape.bezierCurveTo(0.072, -0.028, 0.028, -0.052, 0, -0.056);
        shape.bezierCurveTo(-0.028, -0.052, -0.072, -0.028, -0.080, -0.002);
        shape.bezierCurveTo(-0.086, 0.024, -0.056, 0.040, 0, 0.036);
        var geo = new THREE.ExtrudeGeometry(shape, {
            depth: 0.028,
            bevelEnabled: true,
            bevelSegments: 5,
            steps: 1,
            bevelSize: 0.022,
            bevelThickness: 0.024
        });
        // 让鼻子前表面顺应吻部呈饱满圆弧球面凸起
        var pos = geo.attributes.position;
        for (var i = 0; i < pos.count; i++) {
            var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            var dome = Math.max(0, 1.0 - (x * x) / 0.011 - (y * y) / 0.006) * 0.018;
            pos.setZ(i, z + dome - x * x * 1.4);
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
    // 精确求取雕刻头部前表面任意 (x, y_rel) 处的 Z 坐标，从根源上 100% 杜绝五官/眼镜/嘴角穿模或悬空！
    function evalHeadFrontZ(xTarget, yRel) {
        var ny = Math.max(-0.96, Math.min(0.96, yRel / 0.560));
        var crownTaper = ny > 0.15 ? Math.pow((ny - 0.15) / 0.85, 1.45) * 0.088 : 0.0;
        var cheekBand = Math.exp(-Math.pow((ny + 0.22) / 0.40, 2.0));
        // 迭代两次精确反解 nx, nz
        var nz = Math.sqrt(Math.max(0.04, 1.0 - ny * ny));
        var nx = 0;
        for (var k = 0; k < 3; k++) {
            var sx = 0.615 - crownTaper + cheekBand * (0.056 + 0.022 * Math.max(0, nz));
            nx = Math.max(-0.96, Math.min(0.96, xTarget / sx));
            nz = Math.sqrt(Math.max(0.02, 1.0 - nx * nx - ny * ny));
        }
        var sz = 0.548 - crownTaper * 0.55 + cheekBand * 0.024;
        var z = nz * sz;
        if (nz > 0.25) {
            var eyeDistL = Math.pow((nx + 0.44) / 0.28, 2.0) + Math.pow((ny - 0.05) / 0.28, 2.0);
            var eyeDistR = Math.pow((nx - 0.44) / 0.28, 2.0) + Math.pow((ny - 0.05) / 0.28, 2.0);
            z -= (Math.exp(-eyeDistL) + Math.exp(-eyeDistR)) * 0.018;
            var muzR2 = Math.pow(nx / 0.39, 2.0) + Math.pow((ny + 0.29) / 0.31, 2.0);
            z += Math.exp(-muzR2 * 1.15) * Math.max(0, nz) * 0.096;
            var underLipR2 = Math.pow(nx / 0.30, 2.0) + Math.pow((ny + 0.56) / 0.14, 2.0);
            z -= Math.exp(-underLipR2) * 0.014;
        }
        return z;
    }

    // 柔和烘焙白肚皮贴图（上沿带马甲下摆接触阴影 AO，彻底消除突兀亮白条）
    function createBellyTexture(THREE, renderer) {
        var S = 512;
        var c = document.createElement("canvas");
        c.width = c.height = S;
        var ctx = c.getContext("2d");
        var g = ctx.createLinearGradient(0, 0, 0, S);
        g.addColorStop(0.00, "#7c8ca8");
        g.addColorStop(0.28, "#a8b8d2");
        g.addColorStop(0.58, "#dce5f3");
        g.addColorStop(0.85, "#cad6ea");
        g.addColorStop(1.00, "#96a6c2");
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

        // ---------- PBR 影棚级定制材质库 ----------
        var headFurMat = enhancePlushMaterial(new THREE.MeshStandardMaterial({
            map: createHeadTexture(THREE, renderer),
            color: 0xffffff,
            roughness: 0.72,
            metalness: 0.01,
            envMapIntensity: 0.55
        }), { rimStrength: 0.24 });

        var bellyFurMat = enhancePlushMaterial(new THREE.MeshStandardMaterial({
            map: createBellyTexture(THREE, renderer),
            color: 0xffffff,
            roughness: 0.76,
            metalness: 0.01,
            envMapIntensity: 0.45
        }), { rimStrength: 0.16 });

        var blackFurMat = enhancePlushMaterial(new THREE.MeshStandardMaterial({
            color: 0x222731,
            roughness: 0.74,
            metalness: 0.03,
            envMapIntensity: 0.62
        }), { rimCool: "vec3(0.36, 0.56, 0.88)", rimCyan: "vec3(0.20, 0.80, 0.95)", rimStrength: 0.20 });

        var innerEarMat = new THREE.MeshStandardMaterial({
            color: 0x3b4250,
            roughness: 0.80,
            metalness: 0.02,
            envMapIntensity: 0.45
        });
        var padMat = new THREE.MeshStandardMaterial({
            color: 0x4d5768,
            roughness: 0.56,
            metalness: 0.04,
            envMapIntensity: 0.55
        });
        var toeCreaseMat = new THREE.MeshStandardMaterial({
            color: 0x141820,
            roughness: 0.85,
            metalness: 0.02
        });
        var noseMat = new THREE.MeshPhysicalMaterial
            ? new THREE.MeshPhysicalMaterial({
                color: 0x191d26,
                roughness: 0.30,
                metalness: 0.04,
                clearcoat: 0.55,
                clearcoatRoughness: 0.28,
                envMapIntensity: 0.85
            })
            : new THREE.MeshStandardMaterial({
                color: 0x191d26,
                roughness: 0.28,
                metalness: 0.06
            });
        var lipMat = new THREE.MeshStandardMaterial({
            color: 0x1f2430,
            roughness: 0.45,
            metalness: 0.03
        });
        var shirtMat = enhancePlushMaterial(new THREE.MeshStandardMaterial({
            color: 0xeaf0f9,
            roughness: 0.62,
            metalness: 0.01,
            envMapIntensity: 0.50
        }), { rimStrength: 0.16 });

        var crimsonCapMat = new THREE.MeshStandardMaterial({
            color: 0x8e1f2b,
            roughness: 0.64,
            metalness: 0.04,
            envMapIntensity: 0.48
        });
        var crimsonDarkEdgeMat = new THREE.MeshStandardMaterial({
            color: 0x6b141e,
            roughness: 0.68,
            metalness: 0.04,
            envMapIntensity: 0.42
        });
        var ribbonMat = new THREE.MeshStandardMaterial({
            color: 0x9b2330,
            roughness: 0.48,
            metalness: 0.06,
            envMapIntensity: 0.58
        });
        var navyBandMat = new THREE.MeshStandardMaterial({
            color: 0x1b2640,
            roughness: 0.62,
            metalness: 0.05,
            envMapIntensity: 0.50
        });
        var goldMat = new THREE.MeshStandardMaterial({
            color: 0xe6c16c,
            roughness: 0.22,
            metalness: 0.86,
            envMapIntensity: 1.25
        });
        var ginkgoMat = new THREE.MeshStandardMaterial({
            map: createGinkgoVeinTexture(THREE, renderer),
            color: 0xf2c95e,
            emissive: 0x261802,
            roughness: 0.42,
            metalness: 0.18,
            envMapIntensity: 0.75,
            side: THREE.DoubleSide
        });
        var buttonMat = new THREE.MeshStandardMaterial({
            color: 0x33302a,
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
        var floorBounceLight = new THREE.PointLight(0x36e6ff, 0.38, 1.6);
        floorBounceLight.position.set(0, 0.12, 0.35);
        root.add(floorBounceLight);

        // ---------- 2. 上宽下收圆润熊猫短腿 + 一体深炭黑三瓣熊掌脚（去掉突兀灰球脚趾） ----------
        [-1, 1].forEach(function (sx) {
            var leg = new THREE.Group();
            leg.position.set(0.232 * sx, 0.43, 0.0);
            leg.rotation.z = -0.045 * sx;
            bodyBob.add(leg);

            var thigh = buildLimbCapsule(THREE, 0.205, 0.150, 0.31, blackFurMat);
            leg.add(thigh);

            var foot = new THREE.Mesh(new THREE.SphereGeometry(0.168, 32, 24), blackFurMat);
            foot.scale.set(1.06, 0.54, 1.26);
            foot.position.set(0, -0.345, 0.048);
            leg.add(foot);

            // 三瓣同色深炭黑圆润脚趾 + 两条内凹暗色趾缝（100% 还原设计图脚掌造型）
            [-0.068, 0, 0.068].forEach(function (tx, ti) {
                var toeLobe = new THREE.Mesh(new THREE.SphereGeometry(0.056, 20, 16), blackFurMat);
                toeLobe.scale.set(0.88, 0.72, 1.05);
                toeLobe.position.set(tx, -0.362, 0.212 - Math.abs(ti - 1) * 0.015);
                leg.add(toeLobe);
            });
            [-0.036, 0.036].forEach(function (cxPos) {
                var crease = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.042, 0.055), toeCreaseMat);
                crease.position.set(cxPos, -0.358, 0.242);
                leg.add(crease);
            });
        });

        // ---------- 3. 躯干（y = 0.36 .. 1.13，精确匹配设计图 1:0.80 头宽肩宽比） ----------
        var spinePivot = new THREE.Group();
        spinePivot.position.set(0, 0.36, 0);
        bodyBob.add(spinePivot);

        // 骨盆暗黑底座与圆润下垂白肚皮（严格收在马甲内侧 z=0 杜绝下摆穿模，仅在马甲下沿露出柔和白肚皮！）
        var pelvisBack = new THREE.Mesh(new THREE.SphereGeometry(0.435, 36, 28), blackFurMat);
        pelvisBack.scale.set(0.98, 0.56, 0.82);
        pelvisBack.position.set(0, 0.03, -0.01);
        spinePivot.add(pelvisBack);

        var whiteBelly = new THREE.Mesh(new THREE.SphereGeometry(0.438, 44, 32), bellyFurMat);
        whiteBelly.scale.set(0.91, 0.66, 0.79);
        whiteBelly.position.set(0, 0.125, 0.0);
        spinePivot.add(whiteBelly);

        // 修身学院马甲车削曲面（局部 y = 0.00 .. 0.77 -> 世界 y = 0.36 .. 1.13，半宽 0.495）
        var lathePts = [
            new THREE.Vector2(0.455, 0.00),
            new THREE.Vector2(0.486, 0.12),
            new THREE.Vector2(0.496, 0.26),
            new THREE.Vector2(0.488, 0.41),
            new THREE.Vector2(0.462, 0.55),
            new THREE.Vector2(0.422, 0.67),
            new THREE.Vector2(0.365, 0.75),
            new THREE.Vector2(0.295, 0.78)
        ];
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
        vestMesh.scale.set(1.02, 1.0, 0.86);
        spinePivot.add(vestMesh);

        // 辅助函数：求取马甲前胸椭圆曲面在局部 (x, y) 处的外法线表面 Z
        function evalChestZ(xLocal, yLocal) {
            var rProfile = 0.492;
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

        // 前门襟两颗复古哑光铜扣（世界 y ≈ 0.67 与 0.53）
        [0.315, 0.175].forEach(function (by) {
            var bz = evalChestZ(0, by);
            var btn = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.023, 0.014, 24), buttonMat);
            btn.rotation.x = Math.PI / 2;
            btn.position.set(-0.004, by, bz + 0.008);
            spinePivot.add(btn);
        });

        // 颈部柔和白色绒毛过渡环 + 18×8 细分曲面贴合式下翻白衬衫八字领（修正镜像法线朝向，零穿模！）
        var neckFur = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.24, 0.14, 32), shirtMat);
        neckFur.position.set(0, 0.755, -0.01);
        spinePivot.add(neckFur);

        var neckHollow = new THREE.Mesh(
            new THREE.CircleGeometry(0.044, 24),
            new THREE.MeshBasicMaterial({ color: 0x161d2e })
        );
        neckHollow.position.set(0, 0.706, evalChestZ(0, 0.706) + 0.008);
        neckHollow.rotation.x = -0.22;
        spinePivot.add(neckHollow);

        [-1, 1].forEach(function (sx) {
            var collarY = 0.672;
            var segU = 18, segV = 8;
            var cGeo = new THREE.PlaneGeometry(1, 1, segU, segV);
            var cp = cGeo.attributes.position;
            for (var ci = 0; ci < cp.count; ci++) {
                var u = cp.getX(ci) + 0.5;
                var v = cp.getY(ci) + 0.5;

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
            spinePivot.add(new THREE.Mesh(cGeo, shirtMat));
        });

        // ---------- 3B. 外置无穿模 3D 学院酒红丝带蝴蝶结（沿胸前曲面弧线自然垂落！） ----------
        var tieY = 0.645;
        var tieZ = evalChestZ(0, tieY) + 0.026;
        var tieGroup = new THREE.Group();
        tieGroup.position.set(0, tieY, tieZ);
        spinePivot.add(tieGroup);

        // 饱满梯形丝带中心结
        var knotGeo = new THREE.BoxGeometry(0.068, 0.052, 0.036);
        var kp = knotGeo.attributes.position;
        for (var ki = 0; ki < kp.count; ki++) {
            var kx = kp.getX(ki), ky = kp.getY(ki), kz = kp.getZ(ki);
            var taper = 1.0 + ky * 2.2;
            kp.setXYZ(ki, kx * taper, ky, kz + (1.0 - (kx * kx) / 0.002) * 0.008);
        }
        knotGeo.computeVertexNormals();
        var knotMesh = new THREE.Mesh(knotGeo, ribbonMat);
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

            // 跨越酒红 V 领边、垂落胸前的修长斜切飘带（复刻设计图至 y≈0.69 的双飘带！）
            var tailShape = new THREE.Shape();
            tailShape.moveTo(0.004 * sx, -0.015);
            tailShape.bezierCurveTo(0.038 * sx, -0.085, 0.078 * sx, -0.185, 0.096 * sx, -0.285);
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

        // ---------- 5. 顺滑溜肩白衬衫双袖 + 利落斜裁袖口 + 掌心灰粉肉垫 ----------
        // 左臂（+X，屏幕右侧：顺滑从马甲袖笼自然垂落）
        var leftShoulder = new THREE.Group();
        leftShoulder.position.set(0.415, 0.65, 0.0);
        leftShoulder.rotation.z = 0.42;
        leftShoulder.rotation.x = 0.04;
        spinePivot.add(leftShoulder);

        var leftSleeve = buildLimbCapsule(THREE, 0.126, 0.138, 0.39, shirtMat);
        leftShoulder.add(leftSleeve);

        // 立体修身衬衫袖口（替换原先救生圈式的圆环）
        var leftCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.141, 0.136, 0.062, 32), shirtMat);
        leftCuff.position.y = -0.405;
        leftShoulder.add(leftCuff);
        var leftCuffSeam = new THREE.Mesh(
            new THREE.TorusGeometry(0.139, 0.0035, 8, 32),
            new THREE.MeshBasicMaterial({ color: 0xb4c2da })
        );
        leftCuffSeam.rotation.x = Math.PI / 2;
        leftCuffSeam.position.y = -0.375;
        leftShoulder.add(leftCuffSeam);

        var leftPawGroup = new THREE.Group();
        leftPawGroup.position.set(-0.01, -0.50, 0.015);
        leftPawGroup.rotation.z = -0.22;
        leftShoulder.add(leftPawGroup);

        var leftPaw = new THREE.Mesh(new THREE.SphereGeometry(0.118, 28, 20), blackFurMat);
        leftPaw.scale.set(0.94, 1.05, 0.88);
        leftPawGroup.add(leftPaw);

        // 内侧可爱大拇指 + 三根微弯手指
        var leftThumb = new THREE.Mesh(new THREE.SphereGeometry(0.044, 16, 12), blackFurMat);
        leftThumb.scale.set(1.1, 0.85, 0.9);
        leftThumb.position.set(-0.095, -0.025, 0.035);
        leftPawGroup.add(leftThumb);

        [-0.042, 0.005, 0.050].forEach(function (fx, fi) {
            var finger = new THREE.Mesh(new THREE.SphereGeometry(0.040, 16, 12), blackFurMat);
            finger.scale.set(0.92, 1.18, 0.92);
            finger.position.set(fx, -0.105 + Math.abs(fi - 1) * 0.010, 0.022);
            leftPawGroup.add(finger);
        });

        // 右臂（-X，屏幕左侧：曲肘向上优雅摊掌托起悬浮全息书卷，正面清晰露出掌心灰粉肉垫！）
        var rightShoulder = new THREE.Group();
        rightShoulder.position.set(-0.415, 0.65, 0.03);
        rightShoulder.rotation.z = -0.56;
        rightShoulder.rotation.x = -0.42;
        spinePivot.add(rightShoulder);

        var rightUpperSleeve = buildLimbCapsule(THREE, 0.126, 0.132, 0.22, shirtMat);
        rightShoulder.add(rightUpperSleeve);

        var rightElbow = new THREE.Group();
        rightElbow.position.set(0, -0.22, 0);
        rightElbow.rotation.x = -1.36;
        rightElbow.rotation.z = -0.22;
        rightElbow.rotation.y = 0.28;
        rightShoulder.add(rightElbow);

        var rightForeSleeve = buildLimbCapsule(THREE, 0.132, 0.138, 0.21, shirtMat);
        rightElbow.add(rightForeSleeve);

        var rightCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.142, 0.138, 0.056, 32), shirtMat);
        rightCuff.position.y = -0.215;
        rightElbow.add(rightCuff);

        // 掌心朝向右前上方微拢的托书右熊掌（让掌心石板灰大肉垫正对镜头与书卷！）
        var rightPawGroup = new THREE.Group();
        rightPawGroup.position.set(0, -0.32, 0.01);
        rightPawGroup.rotation.x = 0.22;
        rightPawGroup.rotation.z = 0.36;
        rightPawGroup.rotation.y = 0.35;
        rightElbow.add(rightPawGroup);

        var rightPaw = new THREE.Mesh(new THREE.SphereGeometry(0.122, 28, 22), blackFurMat);
        rightPaw.scale.set(1.04, 0.84, 0.96);
        rightPawGroup.add(rightPaw);

        // 朝向镜头与全息书卷方向的石板灰椭圆大掌垫（曲肘后局部 +Z 朝向正上方仰掌内侧！）
        var mainPalmPad = new THREE.Mesh(new THREE.SphereGeometry(0.066, 22, 16), padMat);
        mainPalmPad.scale.set(1.12, 0.68, 0.45);
        mainPalmPad.position.set(0.032, -0.018, 0.086);
        mainPalmPad.rotation.z = -0.28;
        rightPawGroup.add(mainPalmPad);

        // 外侧向上微拢的四根圆润熊指 + 仰掌内侧指腹小肉垫
        [
            { x: -0.092, y: -0.042, z: 0.024, rx: -0.28, pad: true },
            { x: -0.062, y: -0.092, z: 0.038, rx: -0.38, pad: true },
            { x: -0.010, y: -0.104, z: 0.042, rx: -0.38, pad: true },
            { x: 0.046, y: -0.082, z: 0.028, rx: -0.24, pad: false }
        ].forEach(function (fd) {
            var digit = new THREE.Mesh(new THREE.SphereGeometry(0.042, 18, 14), blackFurMat);
            digit.scale.set(0.95, 1.22, 0.92);
            digit.position.set(fd.x, fd.y, fd.z);
            digit.rotation.x = fd.rx;
            rightPawGroup.add(digit);

            if (fd.pad) {
                var dPad = new THREE.Mesh(new THREE.SphereGeometry(0.020, 14, 10), padMat);
                dPad.scale.set(0.95, 1.05, 0.48);
                dPad.position.set(fd.x + 0.010, fd.y - 0.008, fd.z + 0.034);
                rightPawGroup.add(dPad);
            }
        });

        // ---------- 6. 连续雕刻婴儿肥梨形头部、深邃晶莹大眼、无穿模金丝眼镜与立体微笑唇 ----------
        var headPivot = new THREE.Group();
        // 下沉 0.025 让饱满白下巴与立体白衬衫翻领无缝衔接（侧面零缝隙！）
        headPivot.position.set(0, 0.735, 0.012);
        spinePivot.add(headPivot);

        var HC_Y = 0.555;
        var headMesh = new THREE.Mesh(createSculptedPandaHeadGeometry(THREE), headFurMat);
        headMesh.position.set(0, HC_Y, 0);
        headPivot.add(headMesh);

        // 带真实凹陷耳窝的圆耳朵（世界坐标 (±0.54, 2.13)）
        var earGeo = createSculptedEarGeometry(THREE);
        var ears = [];
        [-1, 1].forEach(function (sx) {
            var earPivot = new THREE.Group();
            earPivot.position.set(0.505 * sx, HC_Y + 0.445, -0.035);
            earPivot.rotation.z = -0.44 * sx;
            earPivot.rotation.y = 0.14 * sx;
            headPivot.add(earPivot);

            var earOuter = new THREE.Mesh(earGeo, blackFurMat);
            earPivot.add(earOuter);

            var earInner = new THREE.Mesh(new THREE.SphereGeometry(0.132, 28, 20), innerEarMat);
            earInner.scale.set(1.02, 0.98, 0.28);
            earInner.position.set(0, -0.012, 0.068);
            earPivot.add(earInner);

            ears.push({ pivot: earPivot, baseZ: earPivot.rotation.z, sx: sx });
        });

        // 通透深邃大眼睛 + 月牙眼白 + 柔和眨眼眼睑（精确贴合眼窝曲面）
        var irisTex = createIrisTexture(THREE, renderer);
        var irisMat = new THREE.MeshBasicMaterial({ map: irisTex });
        var scleraMat = new THREE.MeshStandardMaterial({
            color: 0xeaf1fb,
            roughness: 0.24,
            metalness: 0.0,
            envMapIntensity: 0.65
        });
        var corneaMat = new THREE.MeshPhysicalMaterial
            ? new THREE.MeshPhysicalMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.10,
                roughness: 0.04,
                clearcoat: 1.0,
                envMapIntensity: 1.4
            })
            : null;
        var eyelids = [];

        [-1, 1].forEach(function (sx) {
            var ex = 0.258 * sx;
            var eyRel = 0.020; // 世界 y = 1.675 + 0.020 = 1.695
            var ez = evalHeadFrontZ(ex, eyRel) - 0.012;

            var eyeGroup = new THREE.Group();
            eyeGroup.position.set(ex, HC_Y + eyRel, ez);
            eyeGroup.rotation.y = 0.30 * sx;
            eyeGroup.rotation.x = -0.03;
            headPivot.add(eyeGroup);

            // 眼白球体（微露外下侧温柔月牙眼白）
            var sclera = new THREE.Mesh(new THREE.SphereGeometry(0.106, 32, 24), scleraMat);
            sclera.scale.set(1.02, 1.05, 0.46);
            eyeGroup.add(sclera);

            // 深邃黑曜石瞳仁（略向鼻梁内上方微聚，呈现设计图专注无辜神态）
            var iris = new THREE.Mesh(new THREE.CircleGeometry(0.088, 48), irisMat);
            iris.position.set(-0.010 * sx, 0.006, 0.0495);
            eyeGroup.add(iris);

            if (corneaMat) {
                var cornea = new THREE.Mesh(new THREE.SphereGeometry(0.107, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.45), corneaMat);
                cornea.rotation.x = Math.PI / 2;
                cornea.scale.set(1.0, 0.48, 1.02);
                eyeGroup.add(cornea);
            }

            // 眨眼上眼睑（平时完全收起在 -0.78 不遮挡圆眼睛，眨眼时柔顺闭合）
            var lid = new THREE.Mesh(
                new THREE.SphereGeometry(0.112, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.55),
                blackFurMat
            );
            lid.scale.set(1.04, 1.08, 0.56);
            lid.rotation.x = -0.78;
            eyeGroup.add(lid);
            eyelids.push(lid);
        });

        // ---------- 6B. 精致香槟金细圆框眼镜（100% 脱离吻部无穿模 + 无两侧外刺尖角！） ----------
        var glassesGroup = new THREE.Group();
        glassesGroup.position.set(0, HC_Y + 0.028, 0);
        headPivot.add(glassesGroup);

        var lensMat = new THREE.MeshPhysicalMaterial
            ? new THREE.MeshPhysicalMaterial({
                color: 0xe6f6ff,
                transparent: true,
                opacity: 0.055,
                roughness: 0.06,
                metalness: 0.0,
                clearcoat: 1.0,
                envMapIntensity: 0.9,
                depthWrite: false
            })
            : new THREE.MeshStandardMaterial({
                color: 0xe6f6ff,
                transparent: true,
                opacity: 0.06,
                roughness: 0.08,
                depthWrite: false
            });

        // 镜圈贴近眼眶前缘 +0.044（正视与侧视均自然贴面且零穿模！）
        var gFrontZ = evalHeadFrontZ(0.24, -0.14) + 0.044;
        [-1, 1].forEach(function (sx) {
            var rimWrap = new THREE.Group();
            rimWrap.position.set(0.286 * sx, 0, gFrontZ);
            rimWrap.rotation.y = 0.21 * sx;
            glassesGroup.add(rimWrap);

            var rim = new THREE.Mesh(new THREE.TorusGeometry(0.186, 0.0090, 24, 96), goldMat);
            rimWrap.add(rim);

            var lens = new THREE.Mesh(new THREE.CircleGeometry(0.178, 48), lensMat);
            rimWrap.add(lens);

            // 镜腿贴着外脸颊向耳上柔和延伸（不横穿镜片视野，也不刺出外框）
            var templeCurve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(0.182 * sx, 0.022, -0.006),
                new THREE.Vector3(0.212 * sx, 0.042, -0.15),
                new THREE.Vector3(0.205 * sx, 0.068, -0.34)
            ]);
            var temple = new THREE.Mesh(new THREE.TubeGeometry(templeCurve, 16, 0.0058, 10, false), goldMat);
            rimWrap.add(temple);
        });

        // 舒展优雅的宽拱形金丝鼻梁桥（精准连接左右内侧镜圈）
        var bridgeCurve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(-0.104, -0.004, gFrontZ + 0.034),
            new THREE.Vector3(-0.052, 0.028, gFrontZ + 0.058),
            new THREE.Vector3(0.0, 0.038, gFrontZ + 0.064),
            new THREE.Vector3(0.052, 0.028, gFrontZ + 0.058),
            new THREE.Vector3(0.104, -0.004, gFrontZ + 0.034)
        ]);
        var bridgeMesh = new THREE.Mesh(new THREE.TubeGeometry(bridgeCurve, 24, 0.0082, 12, false), goldMat);
        glassesGroup.add(bridgeMesh);

        // ---------- 6C. 圆润倒三角心形熊猫鼻 + 表面自适应 3D 上扬微笑唇与嘴角酒窝 ----------
        var noseYRel = -0.165; // 世界 y ≈ 1.51
        var noseSurfZ = evalHeadFrontZ(0, noseYRel);
        var noseMesh = new THREE.Mesh(createPandaNoseGeometry(THREE), noseMat);
        noseMesh.position.set(0, HC_Y + noseYRel, noseSurfZ - 0.012);
        noseMesh.rotation.x = 0.08;
        headPivot.add(noseMesh);

        // 沿雕刻吻部真实曲面采样生成的 3D 温柔上扬微笑唇线（100% 贴面外露，彻底解决嘴巴消失 Bug！）
        var smilePts = [];
        var smileSamples = 17;
        for (var smi = 0; smi < smileSamples; smi++) {
            var uSmile = (smi / (smileSamples - 1)) * 2.0 - 1.0; // -1 .. +1
            var sxSmile = uSmile * 0.195;
            var syRel = -0.312 + Math.pow(uSmile, 2.0) * 0.058;
            var szSmile = evalHeadFrontZ(sxSmile, syRel) + 0.0065;
            smilePts.push(new THREE.Vector3(sxSmile, HC_Y + syRel, szSmile));
        }
        var smileCurve = new THREE.CatmullRomCurve3(smilePts);
        var smileTube = new THREE.Mesh(new THREE.TubeGeometry(smileCurve, 40, 0.0095, 12, false), lipMat);
        headPivot.add(smileTube);

        // 左右嘴角微翘小酒窝短弧（还原设计图灵动治愈笑意！）
        [-1, 1].forEach(function (sx) {
            var dimplePts = [
                new THREE.Vector3(0.182 * sx, HC_Y - 0.258, evalHeadFrontZ(0.182 * sx, -0.258) + 0.005),
                new THREE.Vector3(0.202 * sx, HC_Y - 0.246, evalHeadFrontZ(0.202 * sx, -0.246) + 0.006),
                new THREE.Vector3(0.214 * sx, HC_Y - 0.232, evalHeadFrontZ(0.214 * sx, -0.232) + 0.004)
            ];
            var dimpleGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(dimplePts), 10, 0.0058, 8, false);
            headPivot.add(new THREE.Mesh(dimpleGeo, lipMat));
        });

        // 说话动态张合口腔与粉红小舌头（贴合微笑线正下方吻部表面）
        var mouthYRel = -0.322;
        var mouthSurfZ = evalHeadFrontZ(0, mouthYRel);
        var mouthCavity = new THREE.Group();
        mouthCavity.position.set(0, HC_Y + mouthYRel, mouthSurfZ + 0.004);
        mouthCavity.rotation.x = 0.22;
        mouthCavity.scale.set(1, 0.01, 1);
        mouthCavity.visible = false;
        headPivot.add(mouthCavity);

        var mouthInner = new THREE.Mesh(
            new THREE.SphereGeometry(0.088, 24, 18),
            new THREE.MeshBasicMaterial({ color: 0x48141f })
        );
        mouthInner.scale.set(1.32, 0.78, 0.32);
        mouthCavity.add(mouthInner);

        var tongue = new THREE.Mesh(
            new THREE.SphereGeometry(0.056, 18, 14),
            new THREE.MeshBasicMaterial({ color: 0xe86f86 })
        );
        tongue.scale.set(1.18, 0.52, 0.34);
        tongue.position.set(0, -0.024, 0.012);
        mouthCavity.add(tongue);

        // ---------- 7. 西华师大暗酒红学士帽（前额微尖拱深蓝帽圈 + 双层斜切帽板 + 真·银杏叶流苏） ----------
        var hatGroup = new THREE.Group();
        hatGroup.position.set(0, HC_Y + 0.515, -0.005);
        hatGroup.rotation.x = 0.095;
        hatGroup.rotation.z = -0.025;
        headPivot.add(hatGroup);

        // 前额中央微向下拱起的经典学士帽深蓝织带帽圈
        var bandGeo = new THREE.CylinderGeometry(0.328, 0.348, 0.078, 56, 4);
        var bp = bandGeo.attributes.position;
        for (var bi = 0; bi < bp.count; bi++) {
            var bx = bp.getX(bi), byv = bp.getY(bi), bz = bp.getZ(bi);
            if (bz > 0 && byv < 0) {
                var frontPeak = Math.exp(-Math.pow(bx / 0.16, 2.0)) * (bz / 0.35) * 0.026;
                bp.setY(bi, byv - frontPeak);
            }
        }
        bandGeo.computeVertexNormals();
        var hatBand = new THREE.Mesh(bandGeo, navyBandMat);
        hatBand.position.y = 0.022;
        hatGroup.add(hatBand);

        var hatCrown = new THREE.Mesh(new THREE.CylinderGeometry(0.368, 0.324, 0.205, 56), crimsonCapMat);
        hatCrown.position.y = 0.148;
        hatGroup.add(hatCrown);

        // 双层斜切立体方形帽板（旋转 0.66 rad 还原设计图非对称棱角透视）
        var boardYaw = 0.66;
        var mortarBoardGroup = new THREE.Group();
        mortarBoardGroup.position.y = 0.258;
        mortarBoardGroup.rotation.y = boardYaw;
        hatGroup.add(mortarBoardGroup);

        var boardBottom = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.022, 0.95), crimsonDarkEdgeMat);
        boardBottom.position.y = -0.008;
        mortarBoardGroup.add(boardBottom);

        var boardTop = new THREE.Mesh(new THREE.BoxGeometry(0.975, 0.024, 0.975), crimsonCapMat);
        boardTop.position.y = 0.012;
        mortarBoardGroup.add(boardTop);

        var topButton = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.038, 0.022, 28), goldMat);
        topButton.position.y = 0.285;
        hatGroup.add(topButton);

        // 紧贴帽板顶面自然垂落右前帽檐的连续弯曲金丝绳（无悬空断节！）
        var rimDropX = 0.355, rimDropZ = 0.215;
        var topCordCurve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.0, 0.284, 0.0),
            new THREE.Vector3(rimDropX * 0.48, 0.286, rimDropZ * 0.48),
            new THREE.Vector3(rimDropX * 0.94, 0.282, rimDropZ * 0.94),
            new THREE.Vector3(rimDropX, 0.256, rimDropZ)
        ]);
        var cordAcross = new THREE.Mesh(new THREE.TubeGeometry(topCordCurve, 24, 0.0078, 12, false), goldMat);
        hatGroup.add(cordAcross);

        // 右前帽檐物理单摆垂落：金绳 + 双层金珠帽托 + 真·扇形放射叶脉银杏叶挂坠
        var tasselPivot = new THREE.Group();
        tasselPivot.position.set(rimDropX, 0.256, rimDropZ);
        hatGroup.add(tasselPivot);

        var dropCord = new THREE.Mesh(new THREE.CylinderGeometry(0.0076, 0.0082, 0.225, 14), goldMat);
        dropCord.position.y = -0.112;
        tasselPivot.add(dropCord);

        var tasselBead = new THREE.Mesh(new THREE.SphereGeometry(0.024, 20, 16), goldMat);
        tasselBead.scale.set(1.0, 1.12, 1.0);
        tasselBead.position.y = -0.232;
        tasselPivot.add(tasselBead);

        var beadCap = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.022, 0.016, 16), goldMat);
        beadCap.position.y = -0.250;
        tasselPivot.add(beadCap);

        var ginkgoCharm = new THREE.Mesh(createTrueGinkgoGeometry(THREE, 0.64), ginkgoMat);
        ginkgoCharm.position.set(0, -0.285, 0.004);
        ginkgoCharm.rotation.y = 0.16;
        ginkgoCharm.rotation.z = -0.06;
        tasselPivot.add(ginkgoCharm);

        // ---------- 8. 右掌上方悬浮 3D 海鸥翼弧面多层全息书卷 + 柔光星尘光斑 ----------
        // 严格复刻设计图透视姿态：书页后仰微朝上展开，书脊自右下向左上倾斜
        var holoBookGroup = new THREE.Group();
        holoBookGroup.position.set(-0.80, 1.33, 0.36);
        holoBookGroup.rotation.set(0.46, 0.52, 0.26);
        root.add(holoBookGroup);

        var pageTex = createHoloPageTexture(THREE);
        var pageFrontMat = new THREE.MeshBasicMaterial({
            map: pageTex,
            color: 0x8ef8ff,
            transparent: true,
            opacity: 0.86,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        var pageInnerMat = new THREE.MeshBasicMaterial({
            map: pageTex,
            color: 0x52ecff,
            transparent: true,
            opacity: 0.52,
            blending: additive,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        var coverMat = new THREE.MeshBasicMaterial({
            color: 0x1eb8dc,
            transparent: true,
            opacity: 0.46,
            side: THREE.DoubleSide,
            depthWrite: false
        });

        // 左右主弧面书封与主书页
        [-1, 1].forEach(function (sx) {
            var openLeaf = new THREE.Group();
            openLeaf.rotation.y = -0.32 * sx;
            holoBookGroup.add(openLeaf);

            var mainPage = new THREE.Mesh(createCurvedPageGeometry(THREE, 0.225, 0.295, sx, 0.036), pageFrontMat);
            mainPage.position.z = 0.010;
            openLeaf.add(mainPage);

            var coverPage = new THREE.Mesh(createCurvedPageGeometry(THREE, 0.236, 0.308, sx, 0.022), coverMat);
            coverPage.position.z = -0.010;
            coverPage.rotation.y = -0.06 * sx;
            openLeaf.add(coverPage);
        });

        // 左侧两页微翘翻动的灵动内页（100% 复刻设计图左侧多层展开书页层次！）
        var flutterPages = [];
        [0.58, 0.86].forEach(function (ang, fi) {
            var fLeaf = new THREE.Group();
            fLeaf.rotation.y = ang;
            var fMesh = new THREE.Mesh(createCurvedPageGeometry(THREE, 0.218, 0.290, -1, 0.042), pageInnerMat);
            fMesh.position.z = 0.016 + fi * 0.006;
            fLeaf.add(fMesh);
            holoBookGroup.add(fLeaf);
            flutterPages.push({ group: fLeaf, baseY: ang, ph: fi * 1.4 });
        });

        var spineGlow = new THREE.Mesh(
            new THREE.CylinderGeometry(0.011, 0.011, 0.305, 16),
            new THREE.MeshBasicMaterial({ color: 0xd6ffff, transparent: true, opacity: 0.94 })
        );
        holoBookGroup.add(spineGlow);

        // 全息书卷背衬柔和青蓝光晕层
        var bookHaloSprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: createSoftOrbTexture(THREE, "rgba(72, 240, 255, 0.42)", "rgba(28, 198, 245, 0.16)"),
            transparent: true,
            blending: additive,
            depthWrite: false
        }));
        bookHaloSprite.scale.set(0.86, 0.86, 1.0);
        holoBookGroup.add(bookHaloSprite);

        // 圆润柔光星尘光斑粒子（使用径向柔光纹理告别方形锯齿像素点！）
        var orbTex = createSoftOrbTexture(THREE, "rgba(245, 255, 255, 1)", "rgba(96, 246, 255, 0.78)");
        var sparkCount = 18;
        var sparkPos = new Float32Array(sparkCount * 3);
        var sparkSeeds = [];
        for (var si = 0; si < sparkCount; si++) {
            var sx0 = (Math.random() - 0.5) * 0.48;
            var sy0 = (Math.random() - 0.3) * 0.42;
            var sz0 = (Math.random() - 0.5) * 0.28;
            sparkPos[si * 3] = sx0;
            sparkPos[si * 3 + 1] = sy0;
            sparkPos[si * 3 + 2] = sz0;
            sparkSeeds.push({ x: sx0, y: sy0, z: sz0, ph: Math.random() * Math.PI * 2 });
        }
        var sparkGeo = new THREE.BufferGeometry();
        sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
        var sparks = new THREE.Points(
            sparkGeo,
            new THREE.PointsMaterial({
                map: orbTex,
                color: 0xa6fcff,
                size: 0.068,
                transparent: true,
                opacity: 0.92,
                blending: additive,
                depthWrite: false
            })
        );
        holoBookGroup.add(sparks);

        // 全息书卷柔和青色点光源（照亮熊猫右颊下缘与托书掌心）
        var bookLight = new THREE.PointLight(0x3be8ff, 0.78, 2.2);
        bookLight.position.set(-0.76, 1.35, 0.52);
        root.add(bookLight);

        // 角色右侧后上方柔和冷蓝轮廓逆光（塑造设计图右侧圆润冷蓝轮廓高光）
        var rimLight = new THREE.DirectionalLight(0x6da6ff, 0.62);
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

        // ---------- 动画状态与实时骨骼/表情驱动 ----------
        var blinkTimer = 2.4;
        var blinkPhase = -1;
        var lastHeadY = 0;
        var tasselVel = 0;
        var tasselAngle = 0;
        var userYaw = 0;

        function update(t, dt, state) {
            var speaking = !!(state && state.voiceActive);
            var mouthPulse = (state && state.mouthPulse) || 0;
            var px = (state && state.pointerNX) || 0;
            var py = (state && state.pointerNY) || 0;
            var isThinking = !!(state && state.thinking);

            // 柔和呼吸起伏
            bodyBob.position.y = Math.sin(t * 1.8) * 0.014;
            spinePivot.rotation.z = Math.sin(t * 0.9) * 0.013;
            spinePivot.rotation.x = Math.sin(t * 1.8 + 0.5) * (speaking ? 0.020 : 0.009);

            // 头部平滑跟随鼠标视线 + 说话轻点头
            var targetHeadY = px * 0.26 + Math.sin(t * 0.55) * 0.035;
            var targetHeadX = py * 0.13 + Math.sin(t * 1.1) * 0.016 + (speaking ? Math.sin(t * 6.5) * 0.024 : 0);
            headPivot.rotation.y += (targetHeadY - headPivot.rotation.y) * Math.min(1, dt * 6);
            headPivot.rotation.x += (targetHeadX - headPivot.rotation.x) * Math.min(1, dt * 6);
            headPivot.rotation.z = -px * 0.045 + (isThinking ? Math.sin(t * 2.4) * 0.038 : 0);

            // 圆耳朵灵动微颤
            var earAmp = speaking ? 0.052 : 0.018;
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
            var lidRotX = -0.78 + lidClosed * 2.08;
            eyelids.forEach(function (lid) { lid.rotation.x = lidRotX; });

            // 说话动态口型（闭嘴时纯享温柔微笑弧，说话时张合立体口腔与小舌头）
            var openTarget = 0.01;
            if (speaking) {
                openTarget = 0.36 + 0.46 * Math.abs(Math.sin(t * 10.5)) + 0.18 * mouthPulse;
            }
            var curOpen = mouthCavity.scale.y;
            var nextOpen = curOpen + (Math.min(1.0, openTarget) - curOpen) * Math.min(1, dt * 16);
            mouthCavity.scale.y = nextOpen;
            mouthCavity.visible = nextOpen > 0.06;

            // 托书右手与自然垂落左手互动摆动
            var talkWave = speaking ? Math.sin(t * 3.6) * 0.065 : 0;
            rightElbow.rotation.x = -1.36 + Math.sin(t * 1.8) * 0.032 + talkWave;
            leftShoulder.rotation.x = 0.04 + Math.sin(t * 1.4 + 1.1) * (speaking ? 0.075 : 0.028);

            // 全息书卷悬浮呼吸、内页微颤翻动与星尘微升
            holoBookGroup.position.y = 1.33 + Math.sin(t * 2.1) * 0.034 + talkWave * 0.16;
            holoBookGroup.rotation.y = 0.44 + Math.sin(t * 1.1) * 0.055;
            flutterPages.forEach(function (fp) {
                fp.group.rotation.y = fp.baseY + Math.sin(t * 2.6 + fp.ph) * (speaking ? 0.08 : 0.035);
            });
            var posArr = sparkGeo.attributes.position.array;
            for (var i = 0; i < sparkCount; i++) {
                var sd = sparkSeeds[i];
                posArr[i * 3 + 1] = sd.y + ((t * 0.11 + sd.ph * 0.1) % 0.30);
                posArr[i * 3] = sd.x + Math.sin(t * 1.8 + sd.ph) * 0.018;
            }
            sparkGeo.attributes.position.needsUpdate = true;

            // 舞台四周银杏叶轻盈律动
            floatingLeaves.forEach(function (item) {
                var c = item.cfg;
                item.mesh.position.y = c.y + Math.sin(t * 1.3 + c.ph) * 0.05;
                item.mesh.rotation.z = c.rz + Math.sin(t * 0.9 + c.ph) * 0.12;
                item.mesh.rotation.y = c.ry + Math.cos(t * 0.7 + c.ph) * 0.14;
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
                userYaw = Math.max(-1.05, Math.min(1.05, userYaw + delta));
            },
            resetYaw: function () { userYaw = 0; }
        };
    };
})();
