/*
 * dashboard-globe.js —— 数智大屏 3D 科技地球与指向性飞线组件（全本地零外链 · Three.js r128）
 * 暴露全局 window.DashboardGlobe.mount(container, opts) -> { update(regionList, chinaGeo), resize(), setActive(bool), dispose() }
 * 若 WebGL 或 THREE 不可用则返回 null，由 dashboard.js 自动降级为 ECharts 2D 飞线地图。
 */
(function (global) {
    "use strict";

    var THREE = global.THREE;
    var DEG2RAD = Math.PI / 180;
    var GLOBE_RADIUS = 1;
    var HUB = { name: "西华师大 · 南充", lat: 30.79, lon: 106.08 };
    var UP = THREE ? new THREE.Vector3(0, 1, 0) : null;

    // 基线学术/资讯节点（当文本地域命中不足时补充全国/区域拓扑骨架）
    var BASELINE_ORIGINS = [
        { name: "北京", lat: 39.90, lon: 116.41, baseline: true },
        { name: "上海", lat: 31.23, lon: 121.47, baseline: true },
        { name: "广东", lat: 23.13, lon: 113.28, baseline: true },
        { name: "浙江", lat: 30.28, lon: 120.15, baseline: true },
        { name: "湖北", lat: 30.59, lon: 114.30, baseline: true },
        { name: "陕西", lat: 34.26, lon: 108.95, baseline: true },
        { name: "重庆", lat: 29.56, lon: 106.55, baseline: true },
        { name: "辽宁", lat: 41.80, lon: 123.43, baseline: true },
        { name: "新加坡", lat: 1.35, lon: 103.82, baseline: true },
        { name: "东京", lat: 35.69, lon: 139.69, baseline: true }
    ];

    // 轻量世界主要陆地轮廓（等距柱状经纬度 [lon, lat]，纯本地几何）
    var WORLD_LAND = [
        // 北美洲
        [[-168,66],[-156,71],[-135,70],[-110,73],[-82,68],[-62,66],[-55,52],[-66,44],[-75,35],[-80,25],[-83,30],[-90,29],[-97,26],[-96,19],[-87,21],[-84,11],[-78,9],[-85,11],[-94,16],[-105,20],[-112,28],[-117,32],[-124,42],[-125,50],[-136,58],[-152,60],[-165,61]],
        // 格陵兰
        [[-52,60],[-42,60],[-22,70],[-18,81],[-45,83],[-68,78],[-56,69]],
        // 南美洲
        [[-79,9],[-72,12],[-62,10],[-50,1],[-35,-6],[-38,-14],[-41,-22],[-52,-33],[-62,-40],[-67,-54],[-74,-53],[-75,-42],[-71,-30],[-71,-18],[-81,-5]],
        // 欧洲
        [[-9,37],[-9,43],[-2,44],[-5,48],[2,51],[8,54],[9,58],[5,61],[15,69],[28,71],[42,68],[60,68],[60,52],[45,44],[38,45],[29,41],[24,38],[16,38],[12,44],[7,44],[3,42],[-5,36]],
        // 英国 / 爱尔兰
        [[-6,50],[2,51],[1,54],[-2,58],[-6,57],[-5,53]],
        // 非洲
        [[-17,15],[-13,28],[-6,36],[10,37],[12,33],[25,32],[33,31],[43,12],[51,12],[41,-2],[40,-15],[33,-26],[20,-35],[15,-25],[12,-6],[9,4],[2,6],[-8,5],[-15,11]],
        // 马达加斯加
        [[44,-25],[47,-25],[50,-15],[49,-12],[44,-18]],
        // 欧亚大陆亚洲主干 + 中东 + 南亚 + 东南亚
        [[28,41],[36,37],[35,31],[43,13],[59,22],[56,26],[62,25],[72,21],[77,8],[82,16],[88,22],[92,21],[98,15],[103,2],[105,10],[109,14],[108,21],[116,23],[121,29],[121,36],[126,38],[129,35],[130,42],[141,52],[143,60],[162,60],[178,66],[168,71],[135,72],[105,77],[82,73],[62,70],[60,52],[46,43],[38,44]],
        // 日本群岛
        [[130,31],[133,34],[136,34],[141,38],[145,44],[141,45],[139,39],[135,36],[131,34]],
        // 苏门答腊 / 爪哇 / 婆罗洲
        [[95,5],[105,-6],[115,-8],[107,-7],[101,-1]],
        [[109,1],[117,6],[118,1],[115,-4],[110,-3]],
        // 澳大利亚
        [[114,-22],[122,-17],[131,-12],[136,-12],[141,-11],[145,-15],[153,-26],[150,-36],[140,-38],[132,-32],[122,-34],[115,-34],[113,-26]],
        // 新西兰
        [[166,-46],[172,-44],[178,-37],[174,-36],[171,-41]]
    ];

    function isReducedMotion() {
        return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }

    function hasWebGL() {
        if (!THREE) return false;
        try {
            var c = global.document.createElement("canvas");
            return !!(global.WebGLRenderingContext && (c.getContext("webgl") || c.getContext("experimental-webgl")));
        } catch (e) {
            return false;
        }
    }

    // 与 Three.js SphereGeometry UV 完全对齐的球面投影
    function latLonToVec3(lat, lon, r) {
        var radius = r || GLOBE_RADIUS;
        var phi = (90 - lat) * DEG2RAD;
        var theta = (lon + 180) * DEG2RAD;
        return new THREE.Vector3(
            -radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.cos(phi),
            radius * Math.sin(phi) * Math.sin(theta)
        );
    }

    function lonToPx(lon, w) {
        return ((lon + 180) / 360) * w;
    }

    function latToPy(lat, h) {
        return ((90 - lat) / 180) * h;
    }

    function decodeUtf8Ring(encoded, encodeOffsets) {
        if (Array.isArray(encoded)) return encoded;
        if (typeof encoded !== "string" || !Array.isArray(encodeOffsets) || encodeOffsets.length < 2) {
            return [];
        }
        var result = [];
        var prevX = encodeOffsets[0];
        var prevY = encodeOffsets[1];
        for (var i = 0; i < encoded.length; i += 2) {
            var x = encoded.charCodeAt(i) - 64;
            var y = encoded.charCodeAt(i + 1) - 64;
            x = (x >> 1) ^ -(x & 1);
            y = (y >> 1) ^ -(y & 1);
            x += prevX;
            y += prevY;
            prevX = x;
            prevY = y;
            result.push([x / 1024, y / 1024]);
        }
        return result;
    }

    function decodeEChartsGeoJson(geo) {
        if (!geo || !Array.isArray(geo.features)) return geo;
        if (geo.__decodedCache) return geo.__decodedCache;
        if (!geo.UTF8Encoding || geo.__decoded) return geo;
        var features = geo.features.map(function (f) {
            var geom = f && f.geometry;
            if (!geom || !geom.coordinates) return f;
            var coords = geom.coordinates;
            var offs = geom.encodeOffsets || [];
            var decodedCoords;
            if (geom.type === "Polygon") {
                decodedCoords = coords.map(function (ring, idx) {
                    return decodeUtf8Ring(ring, offs[idx]);
                });
            } else if (geom.type === "MultiPolygon") {
                decodedCoords = coords.map(function (poly, pi) {
                    var polyOffs = offs[pi] || [];
                    return poly.map(function (ring, ri) {
                        return decodeUtf8Ring(ring, polyOffs[ri]);
                    });
                });
            } else {
                decodedCoords = coords;
            }
            return {
                type: f.type,
                properties: f.properties,
                geometry: { type: geom.type, coordinates: decodedCoords }
            };
        });
        var decoded = {
            type: geo.type || "FeatureCollection",
            UTF8Encoding: false,
            __decoded: true,
            features: features
        };
        geo.__decodedCache = decoded;
        return decoded;
    }

    function forEachPolyRings(geoFeature, fn) {
        var geom = geoFeature && geoFeature.geometry;
        if (!geom || !Array.isArray(geom.coordinates)) return;
        if (geom.type === "Polygon") {
            geom.coordinates.forEach(function (ring) {
                if (Array.isArray(ring)) fn(ring);
            });
        } else if (geom.type === "MultiPolygon") {
            geom.coordinates.forEach(function (poly) {
                if (Array.isArray(poly)) {
                    poly.forEach(function (ring) {
                        if (Array.isArray(ring)) fn(ring);
                    });
                }
            });
        }
    }

    function buildEarthTexture(chinaGeo, regionMap, maxVal) {
        var W = 2048;
        var H = 1024;
        var canvas = global.document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        var ctx = canvas.getContext("2d");

        // 1. 深空海域渐变底色
        var bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, "#030b19");
        bg.addColorStop(0.5, "#06152c");
        bg.addColorStop(1, "#030b19");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        // 2. 经纬网格（15° 间距，赤道略亮）
        for (var lon = -180; lon <= 180; lon += 15) {
            var x = lonToPx(lon, W);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.strokeStyle = lon === 0 ? "rgba(56, 189, 248, 0.22)" : "rgba(56, 189, 248, 0.08)";
            ctx.lineWidth = lon === 0 ? 1.5 : 1;
            ctx.stroke();
        }
        for (var lat = -75; lat <= 75; lat += 15) {
            var y = latToPy(lat, H);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.strokeStyle = lat === 0 ? "rgba(0, 229, 255, 0.28)" : "rgba(56, 189, 248, 0.08)";
            ctx.lineWidth = lat === 0 ? 1.5 : 1;
            ctx.stroke();
        }

        // 3. 世界陆地轮廓（科技青蓝轮廓 + 微点阵感填色）
        ctx.save();
        WORLD_LAND.forEach(function (poly) {
            if (!poly || poly.length < 3) return;
            ctx.beginPath();
            poly.forEach(function (pt, idx) {
                var px = lonToPx(pt[0], W);
                var py = latToPy(pt[1], H);
                if (idx === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            });
            ctx.closePath();
            ctx.fillStyle = "rgba(15, 44, 88, 0.78)";
            ctx.fill();
            ctx.strokeStyle = "rgba(56, 189, 248, 0.42)";
            ctx.lineWidth = 1.4;
            ctx.stroke();
        });
        ctx.restore();

        // 4. 点阵肌理微叠加（科技扫描质感）
        ctx.fillStyle = "rgba(125, 211, 252, 0.09)";
        for (var gx = 8; gx < W; gx += 16) {
            for (var gy = 8; gy < H; gy += 16) {
                ctx.fillRect(gx, gy, 1.4, 1.4);
            }
        }

        // 5. 精确绘制 china.json 省级填充与热力高亮
        if (chinaGeo && Array.isArray(chinaGeo.features)) {
            chinaGeo.features.forEach(function (feat) {
                var name = feat.properties && feat.properties.name;
                var val = (name && regionMap[name]) || 0;
                var ratio = val > 0 && maxVal > 0 ? Math.min(1, val / maxVal) : 0;

                ctx.beginPath();
                forEachPolyRings(feat, function (ring) {
                    ring.forEach(function (pt, idx) {
                        var px = lonToPx(pt[0], W);
                        var py = latToPy(pt[1], H);
                        if (idx === 0) ctx.moveTo(px, py);
                        else ctx.lineTo(px, py);
                    });
                    ctx.closePath();
                });

                if (ratio > 0.65) {
                    ctx.fillStyle = "rgba(245, 158, 11, 0.62)";
                } else if (ratio > 0) {
                    ctx.fillStyle = "rgba(0, 212, 255, " + (0.28 + ratio * 0.42).toFixed(2) + ")";
                } else {
                    ctx.fillStyle = "rgba(22, 68, 136, 0.78)";
                }
                ctx.fill();
                ctx.strokeStyle = ratio > 0 ? "rgba(0, 229, 255, 0.85)" : "rgba(56, 189, 248, 0.42)";
                ctx.lineWidth = 1.3;
                ctx.stroke();
            });
        }

        var tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        return tex;
    }

    function buildChinaBorderLines(chinaGeo) {
        if (!chinaGeo || !Array.isArray(chinaGeo.features)) return null;
        var verts = [];
        var r = GLOBE_RADIUS * 1.004;
        chinaGeo.features.forEach(function (feat) {
            forEachPolyRings(feat, function (ring) {
                for (var i = 0; i < ring.length - 1; i++) {
                    var p1 = latLonToVec3(ring[i][1], ring[i][0], r);
                    var p2 = latLonToVec3(ring[i + 1][1], ring[i + 1][0], r);
                    verts.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
                }
            });
        });
        if (!verts.length) return null;
        var geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        var mat = new THREE.LineBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.74
        });
        return new THREE.LineSegments(geom, mat);
    }

    function createAtmosphereMesh() {
        var geom = new THREE.SphereGeometry(GLOBE_RADIUS * 1.09, 48, 36);
        var mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            vertexShader: [
                "varying vec3 vNormal;",
                "varying vec3 vViewPos;",
                "void main() {",
                "  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);",
                "  vViewPos = -mvPos.xyz;",
                "  vNormal = normalize(normalMatrix * normal);",
                "  gl_Position = projectionMatrix * mvPos;",
                "}"
            ].join("\n"),
            fragmentShader: [
                "varying vec3 vNormal;",
                "varying vec3 vViewPos;",
                "void main() {",
                "  vec3 viewDir = normalize(vViewPos);",
                "  float rim = pow(clamp(0.72 - dot(vNormal, -viewDir), 0.0, 1.0), 2.8);",
                "  vec3 col = mix(vec3(0.08, 0.42, 0.96), vec3(0.0, 0.90, 1.0), rim);",
                "  gl_FragColor = vec4(col, rim * 0.78);",
                "}"
            ].join("\n")
        });
        return new THREE.Mesh(geom, mat);
    }

    function createOrbitRing(radius, tiltX, tiltZ, color, opacity, tickStepDeg) {
        var group = new THREE.Group();
        var pts = [];
        for (var deg = 0; deg <= 360; deg += 3) {
            var a = deg * DEG2RAD;
            pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
        }
        var ringGeom = new THREE.BufferGeometry().setFromPoints(pts);
        var ringMat = new THREE.LineBasicMaterial({
            color: color,
            transparent: true,
            opacity: opacity
        });
        group.add(new THREE.Line(ringGeom, ringMat));

        if (tickStepDeg) {
            var tickVerts = [];
            for (var d = 0; d < 360; d += tickStepDeg) {
                var rad = d * DEG2RAD;
                var inner = radius - 0.022;
                var outer = radius + 0.022;
                tickVerts.push(
                    Math.cos(rad) * inner, 0, Math.sin(rad) * inner,
                    Math.cos(rad) * outer, 0, Math.sin(rad) * outer
                );
            }
            var tGeom = new THREE.BufferGeometry();
            tGeom.setAttribute("position", new THREE.Float32BufferAttribute(tickVerts, 3));
            group.add(new THREE.LineSegments(tGeom, new THREE.LineBasicMaterial({
                color: 0x00e5ff,
                transparent: true,
                opacity: opacity + 0.16
            })));
        }

        group.rotation.x = tiltX;
        group.rotation.z = tiltZ;
        return group;
    }

    function createStarfield() {
        var count = 280;
        var positions = new Float32Array(count * 3);
        for (var i = 0; i < count; i++) {
            var r = 6.5 + Math.random() * 5.5;
            var theta = Math.random() * Math.PI * 2;
            var phi = Math.acos(2 * Math.random() - 1);
            positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.cos(phi);
            positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
        }
        var geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        var mat = new THREE.PointsMaterial({
            color: 0x7dd3fc,
            size: 0.036,
            transparent: true,
            opacity: 0.55
        });
        return new THREE.Points(geom, mat);
    }

    function orientAlongNormal(mesh, vec) {
        var dir = vec.clone().normalize();
        mesh.quaternion.setFromUnitVectors(UP, dir);
    }

    function orientTangentRing(mesh, surfacePos) {
        var normal = surfacePos.clone().normalize();
        // RingGeometry 默认在 XY 平面（法向量 +Z）
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    }

    function disposeObject(obj) {
        if (!obj) return;
        obj.traverse(function (child) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(function (m) {
                        if (m.map && !m.map.__shared) m.map.dispose();
                        m.dispose();
                    });
                } else {
                    if (child.material.map && !child.material.map.__shared) child.material.map.dispose();
                    child.material.dispose();
                }
            }
        });
    }

    function createGlowTexture() {
        var c = global.document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        var ctx = c.getContext("2d");
        var grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, "rgba(255, 255, 255, 1)");
        grad.addColorStop(0.28, "rgba(255, 255, 255, 0.72)");
        grad.addColorStop(0.62, "rgba(255, 255, 255, 0.18)");
        grad.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 64);
        var tex = new THREE.CanvasTexture(c);
        tex.__shared = true;
        return tex;
    }

    function mount(containerEl, opts) {
        if (!containerEl || !hasWebGL()) {
            return null;
        }
        opts = opts || {};

        var renderer;
        try {
            renderer = new THREE.WebGLRenderer({
                antialias: true,
                alpha: true,
                powerPreference: "high-performance"
            });
        } catch (err) {
            return null;
        }

        var width = Math.max(containerEl.clientWidth || 480, 240);
        var height = Math.max(containerEl.clientHeight || 360, 200);
        renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        renderer.domElement.className = "ckb-globe-canvas";

        containerEl.innerHTML = "";
        containerEl.appendChild(renderer.domElement);

        var labelLayer = global.document.createElement("div");
        labelLayer.className = "ckb-globe-labels";
        containerEl.appendChild(labelLayer);

        var scene = new THREE.Scene();
        var camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 40);
        var camDist = 2.68;
        camera.position.set(0, 0, camDist);

        // 均匀高对比度光照，确保背面/边缘也可清晰辨认大陆与国界
        scene.add(new THREE.AmbientLight(0xdbeafe, 0.96));
        var keyLight = new THREE.DirectionalLight(0x38bdf8, 0.72);
        keyLight.position.set(3, 4, 4);
        scene.add(keyLight);
        var rimLight = new THREE.DirectionalLight(0x00e5ff, 0.36);
        rimLight.position.set(-4, -2, -2);
        scene.add(rimLight);

        scene.add(createStarfield());

        // 两层旋转骨架构成无万向节死锁拖拽（外层控制倾角，内层控制经度自转）
        var tiltGroup = new THREE.Group();
        var spinGroup = new THREE.Group();
        tiltGroup.add(spinGroup);
        scene.add(tiltGroup);

        // 初始角度直接对准中国 / 西华师大南充中心
        var TARGET_LAT = 26 * DEG2RAD;
        var TARGET_LON_Y = -(90 + 106) * DEG2RAD;
        tiltGroup.rotation.x = TARGET_LAT;
        spinGroup.rotation.y = TARGET_LON_Y;

        var earthGeom = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48);
        var earthMat = new THREE.MeshPhongMaterial({
            color: 0xffffff,
            specular: new THREE.Color(0x164e63),
            shininess: 18
        });
        var earthMesh = new THREE.Mesh(earthGeom, earthMat);
        spinGroup.add(earthMesh);

        var atmoMesh = createAtmosphereMesh();
        spinGroup.add(atmoMesh);

        var ringOuter = createOrbitRing(1.24, 0.42, 0.18, 0x38bdf8, 0.24, 15);
        var ringInner = createOrbitRing(1.36, -0.52, -0.24, 0x00e5ff, 0.16, 30);
        var ringEquatorial = createOrbitRing(1.10, 0, 0, 0x2dd4bf, 0.14, 0);
        spinGroup.add(ringOuter);
        spinGroup.add(ringInner);
        spinGroup.add(ringEquatorial);

        var borderGroup = new THREE.Group();
        var flightGroup = new THREE.Group();
        spinGroup.add(borderGroup);
        spinGroup.add(flightGroup);

        var glowTex = createGlowTexture();
        var TRAIL_STEPS = 18;
        var _yAxis = new THREE.Vector3();
        var _zAxis = new THREE.Vector3();
        var _xAxis = new THREE.Vector3();
        var _rotMat = new THREE.Matrix4();
        var _pt = new THREE.Vector3();
        var _tg = new THREE.Vector3();
        var _nrm = new THREE.Vector3();
        var _side = new THREE.Vector3();

        var animations = {
            darts: [],
            waves: [],
            labelNodes: []
        };
        var state = {
            active: true,
            disposed: false,
            dragging: false,
            lastX: 0,
            lastY: 0,
            velX: 0,
            velY: 0,
            chinaHash: ""
        };

        // 8-triangle 锐利后掠三角翼箭矢，指向 +Y（与地球表面平行）
        function createChevronGeometry(scale) {
            var s = scale || 1;
            var tipY = 0.0155 * s;
            var wingX = 0.0082 * s;
            var wingY = -0.0095 * s;
            var notchY = -0.0032 * s;
            var ridgeY = -0.0005 * s;
            var ridgeZ = 0.0026 * s;

            var T = [0, tipY, 0];
            var L = [-wingX, wingY, 0];
            var R = [wingX, wingY, 0];
            var N = [0, notchY, 0];
            var U = [0, ridgeY, ridgeZ];
            var B = [0, ridgeY, -ridgeZ];

            var verts = [].concat(
                T, U, L,
                T, R, U,
                U, N, L,
                U, R, N,
                T, L, B,
                T, B, R,
                B, L, N,
                B, N, R
            );
            var geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
            geom.computeVertexNormals();
            return geom;
        }

        function createSciFiArrow(colorHex, scale, isSubtle, isHot) {
            var s = scale || 1;
            var group = new THREE.Group();

            var coreCol = isHot ? 0xfef9c3 : 0xe0f2fe;
            var coreMat = new THREE.MeshBasicMaterial({
                color: coreCol,
                transparent: true,
                opacity: isSubtle ? 0.55 : 0.96,
                side: THREE.DoubleSide
            });
            var coreMesh = new THREE.Mesh(createChevronGeometry(s * 0.78), coreMat);
            group.add(coreMesh);

            var auraMat = new THREE.MeshBasicMaterial({
                color: colorHex,
                transparent: true,
                opacity: isSubtle ? 0.28 : 0.48,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            var auraMesh = new THREE.Mesh(createChevronGeometry(s * 1.24), auraMat);
            group.add(auraMesh);

            var tipSprite = null;
            if (!isSubtle) {
                var sprMat = new THREE.SpriteMaterial({
                    map: glowTex,
                    color: colorHex,
                    transparent: true,
                    opacity: 0.9,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                });
                tipSprite = new THREE.Sprite(sprMat);
                tipSprite.position.set(0, 0.008 * s, 0);
                tipSprite.scale.set(0.038 * s, 0.038 * s, 1);
                group.add(tipSprite);
            }

            return {
                group: group,
                coreMat: coreMat,
                auraMat: auraMat,
                tipSprite: tipSprite
            };
        }

        function orientArrowOnCurve(obj, pos, tan) {
            _yAxis.copy(tan).normalize();
            _zAxis.copy(pos).normalize();
            if (Math.abs(_yAxis.dot(_zAxis)) > 0.98) {
                _zAxis.set(0, 1, 0);
                if (Math.abs(_yAxis.dot(_zAxis)) > 0.98) {
                    _zAxis.set(1, 0, 0);
                }
            }
            _xAxis.crossVectors(_yAxis, _zAxis).normalize();
            _zAxis.crossVectors(_xAxis, _yAxis).normalize();
            _rotMat.makeBasis(_xAxis, _yAxis, _zAxis);
            obj.quaternion.setFromRotationMatrix(_rotMat);
        }

        function createTrailRibbon(colorHex, isHot) {
            var count = (TRAIL_STEPS + 1) * 2;
            var positions = new Float32Array(count * 3);
            var colors = new Float32Array(count * 3);
            var indices = [];

            var baseCol = new THREE.Color(colorHex);
            var headCol = new THREE.Color(isHot ? 0xfef9c3 : 0xe0f2fe);
            var tmpCol = new THREE.Color();

            for (var i = 0; i <= TRAIL_STEPS; i++) {
                var frac = i / TRAIL_STEPS;
                var fade = Math.pow(frac, 1.55);
                var whiteMix = Math.max(0, (frac - 0.58) / 0.42);
                tmpCol.copy(baseCol).lerp(headCol, whiteMix * 0.65).multiplyScalar(fade);
                for (var sideIdx = 0; sideIdx < 2; sideIdx++) {
                    var vi = (i * 2 + sideIdx) * 3;
                    colors[vi] = tmpCol.r;
                    colors[vi + 1] = tmpCol.g;
                    colors[vi + 2] = tmpCol.b;
                }
                if (i < TRAIL_STEPS) {
                    var a = i * 2;
                    var b = i * 2 + 1;
                    var c = (i + 1) * 2;
                    var d = (i + 1) * 2 + 1;
                    indices.push(a, b, c, b, d, c);
                }
            }

            var geom = new THREE.BufferGeometry();
            var posAttr = new THREE.BufferAttribute(positions, 3);
            if (posAttr.setUsage) posAttr.setUsage(THREE.DynamicDrawUsage);
            geom.setAttribute("position", posAttr);
            geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
            geom.setIndex(indices);

            var mat = new THREE.MeshBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.92,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            var mesh = new THREE.Mesh(geom, mat);
            mesh.frustumCulled = false;

            return {
                mesh: mesh,
                posAttr: posAttr,
                mat: mat
            };
        }

        function updateDartAndTrail(d) {
            _pt.copy(d.curve.getPoint(d.t, _pt));
            _tg.copy(d.curve.getTangent(d.t, _tg)).normalize();

            var startEnv = Math.min(1, d.t / 0.12);
            var endEnv = Math.min(1, (1 - d.t) / 0.14);
            var env = Math.max(0.04, Math.min(startEnv, endEnv));

            d.mesh.position.copy(_pt);
            orientArrowOnCurve(d.mesh, _pt, _tg);
            d.mesh.scale.setScalar(0.55 + 0.45 * env);

            d.coreMat.opacity = 0.96 * env;
            d.auraMat.opacity = 0.48 * env;
            if (d.tipSprite) d.tipSprite.material.opacity = 0.92 * env;
            d.trailMat.opacity = 0.92 * env;

            var posArr = d.trailPosAttr.array;
            for (var i = 0; i <= TRAIL_STEPS; i++) {
                var frac = i / TRAIL_STEPS;
                var sT = Math.max(0.001, d.t - (1 - frac) * d.trailLen);
                _pt.copy(d.curve.getPoint(sT, _pt));
                _tg.copy(d.curve.getTangent(sT, _tg)).normalize();
                _nrm.copy(_pt).normalize();
                _side.crossVectors(_tg, _nrm);
                if (_side.lengthSq() < 1e-6) {
                    _side.set(1, 0, 0);
                } else {
                    _side.normalize();
                }
                var halfW = 0.0044 * d.scale * Math.pow(frac, 1.35) * env;

                var li = i * 6;
                posArr[li] = _pt.x - _side.x * halfW;
                posArr[li + 1] = _pt.y - _side.y * halfW;
                posArr[li + 2] = _pt.z - _side.z * halfW;
                posArr[li + 3] = _pt.x + _side.x * halfW;
                posArr[li + 4] = _pt.y + _side.y * halfW;
                posArr[li + 5] = _pt.z + _side.z * halfW;
            }
            d.trailPosAttr.needsUpdate = true;
        }

        function buildHubBeacon() {
            var hubVec = latLonToVec3(HUB.lat, HUB.lon, GLOBE_RADIUS * 1.003);
            var normal = hubVec.clone().normalize();

            // 纤细金色光针
            var pillarH = 0.082;
            var pillar = new THREE.Mesh(
                new THREE.CylinderGeometry(0.0025, 0.0085, pillarH, 12),
                new THREE.MeshBasicMaterial({
                    color: 0xfbbf24,
                    transparent: true,
                    opacity: 0.9,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                })
            );
            pillar.position.copy(normal.clone().multiplyScalar(GLOBE_RADIUS + pillarH * 0.5));
            orientAlongNormal(pillar, normal);
            flightGroup.add(pillar);

            // 顶部棱晶信标 + 柔光晕
            var diamond = new THREE.Mesh(
                new THREE.OctahedronGeometry(0.015, 0),
                new THREE.MeshBasicMaterial({ color: 0xfef08a })
            );
            diamond.position.copy(normal.clone().multiplyScalar(GLOBE_RADIUS + pillarH + 0.015));
            flightGroup.add(diamond);

            var hubGlow = new THREE.Sprite(new THREE.SpriteMaterial({
                map: glowTex,
                color: 0xfbbf24,
                transparent: true,
                opacity: 0.78,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            }));
            hubGlow.position.copy(normal.clone().multiplyScalar(GLOBE_RADIUS + pillarH * 0.85));
            hubGlow.scale.set(0.078, 0.078, 1);
            flightGroup.add(hubGlow);

            // 表面双扩散雷达波环
            for (var w = 0; w < 2; w++) {
                var waveGeom = new THREE.RingGeometry(0.020, 0.026, 32);
                var waveMat = new THREE.MeshBasicMaterial({
                    color: w === 0 ? 0xfbbf24 : 0x00e5ff,
                    side: THREE.DoubleSide,
                    transparent: true,
                    opacity: 0.78,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                });
                var wave = new THREE.Mesh(waveGeom, waveMat);
                wave.position.copy(normal.clone().multiplyScalar(GLOBE_RADIUS * 1.006));
                orientTangentRing(wave, wave.position);
                flightGroup.add(wave);
                animations.waves.push({
                    mesh: wave,
                    phase: w * 0.5,
                    maxScale: 2.4,
                    baseOpacity: 0.78
                });
            }

            animations.labelNodes.push({
                name: HUB.name,
                value: null,
                isHub: true,
                localPos: normal.clone().multiplyScalar(GLOBE_RADIUS + pillarH + 0.026)
            });
        }

        function buildFlights(regionList, chinaGeo) {
            while (flightGroup.children.length) {
                var child = flightGroup.children.pop();
                disposeObject(child);
            }
            animations.darts = [];
            animations.waves = [];
            animations.labelNodes = [];

            var cpByName = {};
            if (chinaGeo && Array.isArray(chinaGeo.features)) {
                chinaGeo.features.forEach(function (f) {
                    var p = f.properties || {};
                    if (p.name && Array.isArray(p.cp) && p.cp.length >= 2) {
                        cpByName[p.name] = { lon: Number(p.cp[0]), lat: Number(p.cp[1]) };
                    }
                });
            }

            buildHubBeacon();

            var seen = {};
            var routes = [];
            (regionList || []).forEach(function (item) {
                var name = item && item.name;
                var val = Number(item && item.value) || 0;
                if (!name || seen[name]) return;
                var cp = cpByName[name];
                if (!cp) return;
                seen[name] = true;
                var isSichuan = name === "四川";
                routes.push({
                    name: isSichuan ? "成都" : name,
                    lat: cp.lat,
                    lon: cp.lon,
                    value: val,
                    baseline: false
                });
            });

            // 保证至少具备丰富全国飞线与指向箭头视觉
            if (routes.length < 6) {
                BASELINE_ORIGINS.forEach(function (b) {
                    if (seen[b.name]) return;
                    seen[b.name] = true;
                    routes.push({
                        name: b.name,
                        lat: b.lat,
                        lon: b.lon,
                        value: null,
                        baseline: true
                    });
                });
            }

            var hubVec = latLonToVec3(HUB.lat, HUB.lon, GLOBE_RADIUS * 1.005);
            var activeCount = routes.filter(function (r) { return !r.baseline; }).length;
            var labelLimit = Math.min(routes.length, 7);

            routes.slice(0, 12).forEach(function (origin, idx) {
                var startVec = latLonToVec3(origin.lat, origin.lon, GLOBE_RADIUS * 1.005);
                var chord = startVec.distanceTo(hubVec);
                if (chord < 0.02) return;

                var isHot = !origin.baseline && idx < Math.max(2, Math.ceil(activeCount / 3));
                var arcColor = isHot ? 0xfbbf24 : (origin.baseline ? 0x38bdf8 : 0x00e5ff);
                var routeScale = chord < 0.12 ? 0.82 : (origin.baseline ? 0.85 : 1.08);

                var mid = startVec.clone().add(hubVec).multiplyScalar(0.5);
                var arcRadius = GLOBE_RADIUS + Math.min(0.30, Math.max(0.06, chord * 0.36));
                mid.normalize().multiplyScalar(arcRadius);

                var curve = new THREE.QuadraticBezierCurve3(startVec, mid, hubVec);

                // 柔光发光管状轨道线
                var railGeom = new THREE.TubeGeometry(curve, 36, origin.baseline ? 0.0012 : 0.0018, 5, false);
                var railMat = new THREE.MeshBasicMaterial({
                    color: arcColor,
                    transparent: true,
                    opacity: origin.baseline ? 0.20 : 0.34,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                });
                flightGroup.add(new THREE.Mesh(railGeom, railMat));

                // 起点精巧信标 + 柔光晕 + 表面脉冲波环
                var pin = new THREE.Mesh(
                    new THREE.SphereGeometry(origin.baseline ? 0.0055 : 0.0068, 10, 10),
                    new THREE.MeshBasicMaterial({ color: isHot ? 0xfef9c3 : 0xe0f2fe })
                );
                pin.position.copy(startVec);
                flightGroup.add(pin);

                var pinGlow = new THREE.Sprite(new THREE.SpriteMaterial({
                    map: glowTex,
                    color: arcColor,
                    transparent: true,
                    opacity: origin.baseline ? 0.55 : 0.82,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                }));
                pinGlow.position.copy(startVec);
                pinGlow.scale.set(0.044, 0.044, 1);
                flightGroup.add(pinGlow);

                var pulseRing = new THREE.Mesh(
                    new THREE.RingGeometry(0.011, 0.015, 24),
                    new THREE.MeshBasicMaterial({
                        color: arcColor,
                        side: THREE.DoubleSide,
                        transparent: true,
                        opacity: 0.55,
                        blending: THREE.AdditiveBlending,
                        depthWrite: false
                    })
                );
                pulseRing.position.copy(startVec);
                orientTangentRing(pulseRing, startVec);
                flightGroup.add(pulseRing);
                animations.waves.push({
                    mesh: pulseRing,
                    phase: (idx * 0.21) % 1,
                    maxScale: 1.9,
                    baseOpacity: 0.55
                });

                // 弧线中段全息微路标（取代旧版在南充旁堆叠的厚重静态圆锥）
                var wayArrow = createSciFiArrow(arcColor, routeScale * 0.62, true, isHot);
                _pt.copy(curve.getPoint(0.56, _pt));
                _tg.copy(curve.getTangent(0.56, _tg)).normalize();
                wayArrow.group.position.copy(_pt);
                orientArrowOnCurve(wayArrow.group, _pt, _tg);
                flightGroup.add(wayArrow.group);

                // 沿弧线连续飞行的科幻矢量箭矢 + 渐变彗星光尾
                var dartArrow = createSciFiArrow(arcColor, routeScale, false, isHot);
                var trail = createTrailRibbon(arcColor, isHot);
                flightGroup.add(trail.mesh);
                flightGroup.add(dartArrow.group);

                var dartObj = {
                    mesh: dartArrow.group,
                    coreMat: dartArrow.coreMat,
                    auraMat: dartArrow.auraMat,
                    tipSprite: dartArrow.tipSprite,
                    trailMesh: trail.mesh,
                    trailPosAttr: trail.posAttr,
                    trailMat: trail.mat,
                    scale: routeScale,
                    trailLen: 0.26,
                    curve: curve,
                    t: 0.22 + ((idx * 0.29) % 0.64),
                    speed: origin.baseline ? 0.0036 : 0.0048
                };
                updateDartAndTrail(dartObj);
                animations.darts.push(dartObj);

                if (idx < labelLimit) {
                    animations.labelNodes.push({
                        name: origin.name,
                        value: origin.value,
                        isHub: false,
                        baseline: origin.baseline,
                        localPos: startVec.clone().multiplyScalar(1.015)
                    });
                }
            });

            rebuildLabelElements();
        }

        function rebuildLabelElements() {
            labelLayer.innerHTML = "";
            animations.labelNodes.forEach(function (node) {
                var el = global.document.createElement("div");
                el.className = "ckb-globe-label" +
                    (node.isHub ? " is-hub" : (node.baseline ? " is-base" : ""));
                el.textContent = node.value ? (node.name + " · " + node.value) : node.name;
                labelLayer.appendChild(el);
                node.el = el;
            });
        }

        var tmpWorld = new THREE.Vector3();
        var tmpNormal = new THREE.Vector3();
        var tmpToCam = new THREE.Vector3();

        function updateLabels() {
            var w = containerEl.clientWidth || width;
            var h = containerEl.clientHeight || height;
            spinGroup.updateMatrixWorld();
            var hubVisible = false;
            var hubPx = 0;
            var hubPy = 0;
            animations.labelNodes.forEach(function (node) {
                if (!node.el) return;
                tmpWorld.copy(node.localPos).applyMatrix4(spinGroup.matrixWorld);
                tmpNormal.copy(tmpWorld).normalize();
                tmpToCam.copy(camera.position).sub(tmpWorld).normalize();
                var facing = tmpNormal.dot(tmpToCam);
                if (facing < 0.22) {
                    node.el.style.opacity = "0";
                    return;
                }
                tmpWorld.project(camera);
                if (tmpWorld.z > 1) {
                    node.el.style.opacity = "0";
                    return;
                }
                var px = (tmpWorld.x * 0.5 + 0.5) * w;
                var py = (-tmpWorld.y * 0.5 + 0.5) * h;
                if (node.isHub) {
                    hubVisible = true;
                    hubPx = px;
                    hubPy = py;
                    node.el.style.transform = "translate3d(" + px.toFixed(1) + "px," + py.toFixed(1) + "px,0) translate(-50%, -155%)";
                } else {
                    if (hubVisible && Math.abs(px - hubPx) < 82 && Math.abs(py - hubPy) < 30) {
                        py = hubPy + 22;
                        px = px <= hubPx ? Math.min(px, hubPx - 36) : Math.max(px, hubPx + 36);
                    }
                    node.el.style.transform = "translate3d(" + px.toFixed(1) + "px," + py.toFixed(1) + "px,0) translate(-50%, -120%)";
                }
                node.el.style.opacity = String(Math.min(1, (facing - 0.22) * 2.4).toFixed(2));
            });
        }

        // 交互事件：左键拖拽旋转、滚轮微缩放、双击复位中国视角
        function onPointerDown(e) {
            state.dragging = true;
            state.lastX = e.clientX;
            state.lastY = e.clientY;
            state.velX = 0;
            state.velY = 0;
            if (renderer.domElement.setPointerCapture) {
                try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) {}
            }
        }
        function onPointerMove(e) {
            if (!state.dragging) return;
            var dx = e.clientX - state.lastX;
            var dy = e.clientY - state.lastY;
            state.lastX = e.clientX;
            state.lastY = e.clientY;
            state.velY = dx * 0.0052;
            state.velX = dy * 0.0042;
            spinGroup.rotation.y += state.velY;
            tiltGroup.rotation.x = Math.max(-0.85, Math.min(0.85, tiltGroup.rotation.x + state.velX));
        }
        function onPointerUp() {
            state.dragging = false;
        }
        function onWheel(e) {
            e.preventDefault();
            camDist = Math.max(2.05, Math.min(3.55, camDist + e.deltaY * 0.0014));
            camera.position.z = camDist;
        }
        function onDblClick() {
            spinGroup.rotation.y = TARGET_LON_Y;
            tiltGroup.rotation.x = TARGET_LAT;
            camDist = 2.68;
            camera.position.z = camDist;
        }

        renderer.domElement.addEventListener("pointerdown", onPointerDown);
        global.addEventListener("pointermove", onPointerMove);
        global.addEventListener("pointerup", onPointerUp);
        renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
        renderer.domElement.addEventListener("dblclick", onDblClick);

        function resize() {
            if (state.disposed) return;
            var w = containerEl.clientWidth || width;
            var h = containerEl.clientHeight || height;
            if (!w || !h) return;
            width = w;
            height = h;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
            updateLabels();
        }

        var ro = global.ResizeObserver ? new global.ResizeObserver(resize) : null;
        if (ro) ro.observe(containerEl);

        var rafId = 0;
        function tick() {
            if (state.disposed) return;
            rafId = global.requestAnimationFrame(tick);
            if (!state.active) return;

            var reduced = isReducedMotion();
            if (!state.dragging) {
                if (Math.abs(state.velY) > 0.0001 || Math.abs(state.velX) > 0.0001) {
                    spinGroup.rotation.y += state.velY;
                    tiltGroup.rotation.x = Math.max(-0.85, Math.min(0.85, tiltGroup.rotation.x + state.velX));
                    state.velX *= 0.92;
                    state.velY *= 0.92;
                } else if (!reduced) {
                    spinGroup.rotation.y += 0.0014;
                }
            }

            if (!reduced) {
                ringOuter.rotation.y += 0.0022;
                ringInner.rotation.y -= 0.0016;

                animations.darts.forEach(function (d) {
                    d.t = (d.t + d.speed) % 1;
                    updateDartAndTrail(d);
                });

                animations.waves.forEach(function (w) {
                    w.phase = (w.phase + 0.015) % 1;
                    var sc = 1 + w.phase * (w.maxScale || 2.4);
                    w.mesh.scale.set(sc, sc, 1);
                    w.mesh.material.opacity = (1 - w.phase) * (w.baseOpacity || 0.78);
                });
            }

            updateLabels();
            renderer.render(scene, camera);
        }

        // 首次挂载先绘一帧基础地球+航线
        function update(regionList, chinaGeo) {
            if (state.disposed) return;
            var geo = decodeEChartsGeoJson(chinaGeo);
            var regionMap = {};
            var maxVal = 0;
            (regionList || []).forEach(function (r) {
                if (!r || !r.name) return;
                var v = Number(r.value) || 0;
                regionMap[r.name] = v;
                if (v > maxVal) maxVal = v;
            });

            var tex = buildEarthTexture(geo, regionMap, maxVal || 1);
            if (earthMat.map) earthMat.map.dispose();
            earthMat.map = tex;
            earthMat.needsUpdate = true;

            if (geo && !state.chinaHash) {
                state.chinaHash = "1";
                var borders = buildChinaBorderLines(geo);
                if (borders) borderGroup.add(borders);
            }

            buildFlights(regionList, geo);
            renderer.render(scene, camera);
            updateLabels();
        }

        update(opts.regionList || [], opts.chinaGeo || null);
        tick();

        return {
            update: update,
            resize: resize,
            setActive: function (on) {
                state.active = !!on;
                if (state.active) resize();
            },
            dispose: function () {
                state.disposed = true;
                global.cancelAnimationFrame(rafId);
                if (ro) ro.disconnect();
                renderer.domElement.removeEventListener("pointerdown", onPointerDown);
                global.removeEventListener("pointermove", onPointerMove);
                global.removeEventListener("pointerup", onPointerUp);
                renderer.domElement.removeEventListener("wheel", onWheel);
                renderer.domElement.removeEventListener("dblclick", onDblClick);
                disposeObject(scene);
                if (glowTex) glowTex.dispose();
                renderer.dispose();
                containerEl.innerHTML = "";
            }
        };
    }

    global.DashboardGlobe = {
        mount: mount,
        hasWebGL: hasWebGL
    };
})(window);
