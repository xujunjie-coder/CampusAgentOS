/* Local campus explorer. Geometry is unchanged; map styling is illustrative. */
(function () {
    "use strict";
    var stage = document.getElementById("mapStage");
    if (!stage) return;
    var status = document.getElementById("mapStatus");
    var searchInput = document.getElementById("mapSearch"), searchForm = document.getElementById("mapSearchForm");
    var searchOptions = document.getElementById("mapSearchOptions"), searchToggle = document.getElementById("mapSearchToggle");
    var searchMatches = [], activeSearchIndex = -1;
    var info = document.getElementById("mapSelection");
    var shell = document.getElementById("campusMapShell");
    var labelLayer = document.getElementById("mapLabelLayer"), linesLayer = document.getElementById("mapLabelLines");
    var detail = document.getElementById("mapBuildingDetail");
    var perspectiveButton = document.getElementById("mapPerspective"), topButton = document.getElementById("mapTop");
    var measureButton = document.getElementById("mapMeasure"), measurePanel = document.getElementById("mapMeasurePanel");
    var measureResult = document.getElementById("mapMeasureResult"), clearMeasureButton = document.getElementById("mapClearMeasure");
    var scale = document.getElementById("mapScale"), compass = document.getElementById("mapCompass");
    var overlays = [detail, measurePanel, scale, document.getElementById("mapStageBadge"), document.getElementById("mapControls")];
    var overviewLandmarks = new Set(["图书馆", "教学楼", "体育馆", "行署礼堂"]);
    var labels = new Map(), reviews = new Map(), featureById = new Map(), selectedId = "", panGesture = false;
    var renderer, observer, model, manifest, scene, camera, perspective, overhead, gateData;
    var roots = new Map(), bounds = new Map(), outlines = new Map(), pickables = [], pointers = new Map();
    var center, campusCenter, campusSpan, campusPoints, radius, theta = Math.PI / 5, phi = 0.83;
    var aspect = 1, topView = false, measuring = false, atOverview = true;
    var outlineMaterial, selectionMaterial, measurement, groundPlane, grid;
    var points = [], cameraFrame = 0, waterTimer = 0, waterTime = { value: 0 };
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var touchPrimary = window.matchMedia("(pointer: coarse)");
    var raycaster, moved = false, down, pinchDistance = 0, destroyed = false;
    function fail() {
        status.hidden = false;
        status.textContent = "地图加载失败或浏览器不支持 WebGL，请刷新重试，也可使用页面下方的 SCSWiki 原文链接。";
    }
    function draw() {
        if (!renderer || !model || destroyed) return;
        if (topView) {
            var halfSpan = radius * Math.tan(perspective.fov * Math.PI / 360);
            overhead.left = -halfSpan * aspect;
            overhead.right = halfSpan * aspect;
            overhead.top = halfSpan;
            overhead.bottom = -halfSpan;
            overhead.updateProjectionMatrix();
            camera.position.set(center.x, center.y + campusSpan * 2, center.z);
        } else {
            camera.position.copy(viewAxes().back.multiplyScalar(radius).add(center));
        }
        camera.lookAt(center);
        renderer.render(scene, camera);
        updateScale();
        updateLabels();
        var northAngle = topView ? 0 : Math.atan2(Math.sin(theta), Math.cos(theta) * Math.cos(phi));
        compass.style.transform = "rotate(" + northAngle + "rad)";
    }
    function resize() {
        if (!renderer || destroyed) return;
        var width = stage.clientWidth, height = stage.clientHeight;
        if (!width || !height) return;
        aspect = width / height;
        perspective.aspect = aspect;
        perspective.updateProjectionMatrix();
        renderer.setSize(width, height);
        measureLabels();
        if (model && atOverview) fit(topView);
        else draw();
    }
    function viewAxes() {
        var back = new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
        var right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
        return { back: back, right: right, up: back.clone().cross(right) };
    }
    function boxCorners(box) {
        var corners = [];
        [box.min.x, box.max.x].forEach(function (x) {
            [box.min.y, box.max.y].forEach(function (y) {
                [box.min.z, box.max.z].forEach(function (z) {
                    corners.push(new THREE.Vector3(x, y, z));
                });
            });
        });
        return corners;
    }
    function fittedRadius(vertices, target, fillX, fillY) {
        var axes = viewAxes(), distance = 0, offset = new THREE.Vector3();
        var halfFov = Math.tan(perspective.fov * Math.PI / 360);
        vertices.forEach(function (vertex) {
            offset.copy(vertex).sub(target);
            var across = topView ? offset.x : offset.dot(axes.right);
            var vertical = topView ? -offset.z : offset.dot(axes.up);
            var depth = topView ? 0 : offset.dot(axes.back);
            distance = Math.max(distance, depth + Math.max(
                Math.abs(across) / (fillX * aspect), Math.abs(vertical) / fillY) / halfFov);
        });
        return distance;
    }
    function perspectiveCenter(fillX, fillY) {
        var target = campusCenter.clone(), axes = viewAxes();
        var distance = fittedRadius(campusPoints, target, fillX, fillY);
        var extent = new THREE.Box2();
        var offset = new THREE.Vector3(), point = new THREE.Vector2();
        campusPoints.forEach(function (vertex) {
            offset.copy(vertex).sub(target);
            var depth = distance - offset.dot(axes.back);
            extent.expandByPoint(point.set(offset.dot(axes.right) / depth, offset.dot(axes.up) / depth));
        });
        extent.getCenter(point).multiplyScalar(distance);
        return target.addScaledVector(axes.right, point.x).addScaledVector(axes.up, point.y);
    }
    function stopTransition() {
        cancelAnimationFrame(cameraFrame);
        cameraFrame = 0;
    }
    function moveCamera(target, distance, animate) {
        stopTransition();
        if (!animate || reducedMotion.matches) {
            center.copy(target);
            radius = distance;
            draw();
            return;
        }
        var start = performance.now(), startCenter = center.clone(), startRadius = radius;
        function step(now) {
            var progress = Math.min(1, (now - start) / 360);
            var ease = 1 - Math.pow(1 - progress, 3);
            center.lerpVectors(startCenter, target, ease);
            radius = THREE.MathUtils.lerp(startRadius, distance, ease);
            draw();
            cameraFrame = progress < 1 ? requestAnimationFrame(step) : 0;
        }
        cameraFrame = requestAnimationFrame(step);
    }
    function fit(top) {
        if (!campusPoints) return;
        atOverview = true;
        topView = top;
        camera = top ? overhead : perspective;
        phi = 0.83;
        theta = Math.PI / 5;
        grid.visible = top;
        perspectiveButton.setAttribute("aria-pressed", String(!top));
        topButton.setAttribute("aria-pressed", String(top));
        document.getElementById("mapViewHint").textContent = touchPrimary.matches
            ? (top ? "拖动平移 · 双指缩放" : "拖动旋转 · 双指缩放和平移")
            : (top ? "拖动平移 · 滚轮缩放" : "拖动旋转 · Shift + 拖动平移");
        var fillX = top ? 0.83 : 0.86, fillY = top ? 0.82 : 0.78;
        var target = top ? campusCenter : perspectiveCenter(fillX, fillY);
        moveCamera(target, fittedRadius(campusPoints, target, fillX, fillY), false);
    }
    function updateScale() {
        scale.hidden = !topView;
        if (!topView) return;
        var pixelsPerMeter = stage.clientHeight / (overhead.top - overhead.bottom);
        var meters = window.CampusMapLabels.scaleDistance(Math.min(112, stage.clientWidth * 0.25) / pixelsPerMeter);
        document.getElementById("mapScaleValue").textContent = meters >= 1000 ? meters / 1000 + " km" : meters + " m";
        document.getElementById("mapScaleBar").style.width = (meters * pixelsPerMeter) + "px";
    }
    function setSelection(id) {
        var root = roots.get(id);
        if (!root || measuring) return;
        highlight(selectedId, false);
        selectedId = id;
        var feature = featureById.get(id);
        var isGate = feature.kind === "gate";
        var box = bounds.get(id);
        var position = isGate ? [root.position.x, -root.position.z] : feature.centerLocalEN;
        searchInput.value = feature.name;
        closeSearch();
        info.textContent = feature.name + (isGate ? " · 示意位置" : " · 名称与模型待核验");
        detail.hidden = false;
        document.getElementById("mapDetailName").textContent = feature.name;
        document.getElementById("mapDetailIcon").className = "fas " + buildingIcon(feature.name);
        document.getElementById("mapDetailId").textContent = id;
        document.getElementById("mapDetailReview").textContent = isGate ? "位置示意" : "信息待核验";
        document.getElementById("mapDetailPosition").textContent = "E " + Math.round(position[0]) + " m · N " + Math.round(position[1]) + " m";
        document.getElementById("mapDetailHeightRow").hidden = isGate;
        document.getElementById("mapDetailHeight").textContent = Math.round(box.max.y - box.min.y) + " m";
        var review = reviews.get(id);
        var conflict = review && review.modelName && review.modelName !== feature.name;
        document.getElementById("mapDetailNote").textContent = isGate ? feature.note : conflict
            ? "清单与模型内部名称（" + review.modelName + "）有差异，需现场校对。位置与高度均取自模型。"
            : "坐标为模型原点的东向、北向偏移，高度为楼块几何高度。实景与楼层待核验。";
        highlight(id, true);
        draw();
    }
    function highlight(id, selected) {
        (outlines.get(id) || []).forEach(function (outline) {
            outline.material = selected ? selectionMaterial : outlineMaterial;
        });
    }
    function buildingIcon(name) {
        if (/^(西门|南门)$/.test(name)) return "fa-door-open";
        if (/图书|史|旧址/.test(name)) return "fa-book-open";
        if (/食堂/.test(name)) return "fa-utensils";
        if (/公寓|宿舍/.test(name)) return "fa-bed";
        if (/教学|实训|计算机/.test(name)) return "fa-graduation-cap";
        if (/医院/.test(name)) return "fa-plus-square";
        if (/体育/.test(name)) return "fa-running";
        return "fa-building";
    }
    function createLabels() {
        manifest.features.forEach(function (feature) {
            var box = bounds.get(feature.id); if (!box) return;
            var anchor = box.getCenter(new THREE.Vector3());
            anchor.y = box.max.y + 2;
            addLabel(feature, anchor);
        });
    }
    function addLabel(feature, anchor) {
            featureById.set(feature.id, feature);
            var button = document.createElement("button");
            button.type = "button";
            button.className = "map-building-label" + (feature.kind === "gate" ? " is-gate" : feature.verification === "named" ? "" : " is-candidate");
            button.setAttribute("aria-label", feature.name + "，信息待核验，点击查看");
            button.title = feature.name + "（待核验）";
            var icon = document.createElement("span"); icon.className = "map-poi-icon";
            var glyph = document.createElement("i"); glyph.className = "fas " + buildingIcon(feature.name); glyph.setAttribute("aria-hidden", "true");
            icon.appendChild(glyph); button.appendChild(icon);
            var title = document.createElement("span");
            title.textContent = feature.verification === "named" ? feature.name : "待核验建筑 " + feature.id.slice(-2);
            button.appendChild(title);
            if (feature.verification === "named") {
                var badge = document.createElement("span"); badge.className = "map-label-review"; badge.textContent = "?"; badge.title = "名称与位置待核验"; button.appendChild(badge);
            }
            var line = document.createElementNS("http://www.w3.org/2000/svg", "line"); linesLayer.appendChild(line);
            labelLayer.appendChild(button);
            button.addEventListener("click", function () { setSelection(feature.id); });
            labels.set(feature.id, { button: button, anchor: anchor, line: line, feature: feature });
    }
    function createGateMarkers() {
        (gateData.landmarks || []).forEach(function (gate) {
            var root = new THREE.Group(); root.name = "feature__" + gate.id;
            root.position.set(gate.positionLocal[0], 1, gate.positionLocal[2]);
            var color = gate.id === "gate-west" ? 0x23699e : 0x158074;
            var pinMaterial = new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide });
            var ring = new THREE.Mesh(new THREE.RingGeometry(5.5, 8, 32), pinMaterial);
            ring.rotation.x=-Math.PI/2; root.add(ring);
            var post = new THREE.Mesh(new THREE.CylinderGeometry(0.8,0.8,12,8), pinMaterial);
            post.position.y=6;root.add(post);
            var pin = new THREE.Mesh(new THREE.SphereGeometry(3.2,12,8), pinMaterial);
            pin.position.y=13;root.add(pin);
            scene.add(root); roots.set(gate.id,root);
            bounds.set(gate.id, new THREE.Box3().setFromObject(root));
            pickables.push(ring, post, pin);
            var feature={id:gate.id,name:gate.name,kind:"gate",verification:"named",note:gate.note};
            addLabel(feature, new THREE.Vector3(root.position.x,18,root.position.z));
        });
    }
    function measureLabels() {
        labels.forEach(function (label) { label.button.hidden = false; });
        labels.forEach(function (label) {
            label.width = label.button.offsetWidth;
            label.height = label.button.offsetHeight;
        });
    }
    function updateLabels() {
        if (!labels.size) return;
        var width = stage.clientWidth, height = stage.clientHeight, items = [];
        var reserved = overlays.filter(function (element) { return !element.hidden; }).map(function (element) {
            return { x: element.offsetLeft, y: element.offsetTop, w: element.offsetWidth, h: element.offsetHeight };
        });
        labels.forEach(function (label, id) {
            var isGate = label.feature.kind === "gate", isSelected = id === selectedId;
            var isLandmark = atOverview && width >= 760 && label.feature.verification === "named" && overviewLandmarks.has(label.feature.name);
            label.button.classList.toggle("is-selected", isSelected);
            if (measuring || (!topView && !isGate && !isSelected && !isLandmark)) return;
            var projected = label.anchor.clone().project(camera);
            if (projected.z < -1 || projected.z > 1) return;
            items.push({
                id: id, x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2,
                w: label.width, h: label.height,
                alwaysShow: isGate || isSelected,
                priority: isGate ? 2000 : isSelected ? 1000 : label.feature.verification === "named" ? 100 : 0
            });
        });
        var placements = new Map(window.CampusMapLabels.place(items, width, height, "smart", reserved)
            .map(function (placement) { return [placement.id, placement]; }));
        labels.forEach(function (label, id) {
            var placement = placements.get(id);
            label.button.hidden = !placement;
            label.line.style.display = "none";
            if (!placement) return;
            label.button.style.transform = "translate(" + placement.x.toFixed(1) + "px," + placement.y.toFixed(1) + "px)";
            var lineX = THREE.MathUtils.clamp(placement.anchorX, placement.x, placement.x + placement.w);
            var lineY = THREE.MathUtils.clamp(placement.anchorY, placement.y, placement.y + placement.h);
            if (Math.hypot(lineX - placement.anchorX, lineY - placement.anchorY) > 9) {
                label.line.setAttribute("x1",lineX); label.line.setAttribute("y1",lineY);
                label.line.setAttribute("x2",placement.anchorX); label.line.setAttribute("y2",placement.anchorY);
                label.line.style.display = "";
            }
        });
        document.getElementById("mapCount").textContent = topView ? "北向俯视" : "三维视角";
    }
    function mapMaterial(color, options) {
        return new THREE.MeshStandardMaterial(Object.assign({
            color: new THREE.Color(color).convertSRGBToLinear(), roughness: 1
        }, options));
    }
    function styleWater(material) {
        // Animate only the color of the existing water meshes in model-space meters.
        material.onBeforeCompile = function (shader) {
            shader.uniforms.waterTime = waterTime;
            shader.vertexShader = "varying vec2 waterPosition;\n" + shader.vertexShader.replace(
                "#include <begin_vertex>", "#include <begin_vertex>\nwaterPosition = (modelMatrix * vec4(position, 1.0)).xz;");
            shader.fragmentShader = "varying vec2 waterPosition;\nuniform float waterTime;\n" + shader.fragmentShader.replace(
                "#include <color_fragment>", `#include <color_fragment>
                float ripple = sin(dot(waterPosition, vec2(0.36, 0.54)) + sin(waterPosition.y * 0.12) - waterTime * 1.8)
                    * sin(dot(waterPosition, vec2(0.12, -0.24)) + waterTime * 0.9);
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.63, 0.66), smoothstep(0.50, 0.93, ripple) * 0.32);`);
        };
    }
    function syncWater() {
        clearInterval(waterTimer);
        waterTimer = 0;
        if (document.hidden || reducedMotion.matches || destroyed || !model) return;
        var previous = performance.now();
        waterTimer = setInterval(function () {
            var now = performance.now();
            waterTime.value += Math.min(0.2, (now - previous) / 1000);
            previous = now;
            if (!cameraFrame) renderer.render(scene, camera);
        }, 1000 / 15);
    }
    function styleMap() {
        var palette = {
            "campus-ground": 0xa9be8d, grass: 0x97aa76, sports: 0xb06e53, water: 0x4d9ba4,
            "internal-roads": 0xb5b5a6, footpaths: 0xe1c69e, "external-roads": 0xa6aca2
        };
        // The source uses nearly coplanar slabs. Separate their render surfaces at oblique angles.
        var layerLift = {
            grass: 0.07, sports: 0.14, water: 0.18,
            "external-roads": 0.21, "internal-roads": 0.24, footpaths: 0.29
        };
        var previousMaterials = new Set();
        manifest.semanticLayers.forEach(function (layer) {
            var node = model.getObjectByName(layer.nodeName); if (!node) return;
            node.position.y += layerLift[layer.id] || 0;
            node.traverse(function (mesh) {
                if (!mesh.isMesh) return;
                previousMaterials.add(mesh.material);
                mesh.material = mapMaterial(palette[layer.id] || 0xd0d8ba, { side: THREE.DoubleSide });
                if (layer.id === "water") styleWater(mesh.material);
                mesh.receiveShadow = true;
            });
        });
        var backdrop = model.getObjectByName("S14_Xuan_Paper_Backdrop");
        if (backdrop) backdrop.visible = false;
        var walls = mapMaterial(0xb99e85), roofs = mapMaterial(0xe8d1ab);
        roots.forEach(function (root, id) {
            var edges = [];
            root.traverse(function (mesh) {
                if (!mesh.isMesh) return;
                var geometry = mesh.geometry, normal = geometry.getAttribute("normal");
                var index = geometry.index, count = index ? index.count : geometry.getAttribute("position").count;
                var wallIndices = [], roofIndices = [];
                for (var i = 0; i < count; i += 3) {
                    var a = index ? index.getX(i) : i;
                    var b = index ? index.getX(i + 1) : i + 1;
                    var c = index ? index.getX(i + 2) : i + 2;
                    var isRoof = normal && normal.getY(a) + normal.getY(b) + normal.getY(c) > 1.8;
                    (isRoof ? roofIndices : wallIndices).push(a, b, c);
                }
                // Preserve every triangle while batching walls and roofs into two draw calls.
                geometry.setIndex(wallIndices.concat(roofIndices));
                geometry.clearGroups();
                if (wallIndices.length) geometry.addGroup(0, wallIndices.length, 0);
                if (roofIndices.length) geometry.addGroup(wallIndices.length, roofIndices.length, 1);
                previousMaterials.add(mesh.material);
                mesh.material = [walls, roofs];
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                pickables.push(mesh);
                edges.push(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 35), outlineMaterial));
            });
            var edgeIndex = 0;
            root.traverse(function (mesh) {
                if (mesh.isMesh) mesh.add(edges[edgeIndex++]);
            });
            outlines.set(id, edges);
        });
        previousMaterials.forEach(function (material) { material.dispose(); });
    }
    function pan(dx, dy) {
        stopTransition();
        atOverview = false;
        var scale = 2 * radius * Math.tan(perspective.fov * Math.PI / 360) / Math.max(1, stage.clientHeight);
        var right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        var up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1); up.y = 0; up.normalize();
        center.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale); draw();
    }
    function zoom(factor, animate) {
        atOverview = false;
        moveCamera(center.clone(), THREE.MathUtils.clamp(radius * factor, 20, campusSpan * 6), animate);
    }
    function distance() {
        var values = Array.from(pointers.values());
        return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
    }
    function clearMeasurement() {
        points = [];
        while (measurement.children.length) {
            var node = measurement.children[0];
            measurement.remove(node);
            node.geometry.dispose();
            node.material.dispose();
        }
        clearMeasureButton.disabled = true;
        measureResult.textContent = "请在地图上点选起点。";
        draw();
    }
    function setMeasuring(active) {
        if (measuring === active) return;
        measuring = active;
        measureButton.setAttribute("aria-pressed", String(active));
        measurePanel.hidden = !active;
        stage.classList.toggle("is-measuring", active);
        if (active) {
            clearSelection();
            if (!topView) fit(true);
        }
        clearMeasurement();
    }
    function markDistance(point) {
        if (points.length === 2) clearMeasurement();
        var metersPerPixel = (overhead.top - overhead.bottom) / stage.clientHeight;
        var marker = new THREE.Mesh(new THREE.RingGeometry(3 * metersPerPixel, 6 * metersPerPixel, 24),
            new THREE.MeshBasicMaterial({ color: 0xbd5633, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
        marker.rotation.x = -Math.PI / 2;
        marker.position.copy(point);
        marker.renderOrder = 40;
        points.push(point);
        measurement.add(marker);
        clearMeasureButton.disabled = false;
        if (points.length === 1) {
            measureResult.textContent = "起点已设定，请点选终点。";
        } else {
            var length = window.CampusMapLabels.planDistance(points[0], points[1]);
            var geometry = new THREE.BufferGeometry().setFromPoints(points);
            var material = new THREE.LineDashedMaterial({
                color: 0xb6492a, dashSize: 7 * metersPerPixel, gapSize: 4 * metersPerPixel, depthTest: false, depthWrite: false
            });
            var line = new THREE.Line(geometry, material);
            line.computeLineDistances();
            line.renderOrder = 39;
            measurement.add(line);
            measureResult.textContent = "约 " + Math.round(length) + " 米 · 再点选可开始新一段";
        }
        draw();
    }
    clearMeasureButton.addEventListener("click", clearMeasurement);
    measureButton.addEventListener("click", function () { setMeasuring(!measuring); });

    async function init() {
        try {
            if (!window.THREE || !THREE.GLTFLoader) throw new Error("Missing renderer");
            renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, logarithmicDepthBuffer: true });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.outputEncoding = THREE.sRGBEncoding;
            renderer.toneMapping = THREE.NoToneMapping;
            renderer.setClearColor(0x000000, 0);
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.autoUpdate = false;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            renderer.domElement.tabIndex = 0;
            renderer.domElement.setAttribute("aria-label", "校园地图。方向键旋转或平移，加减键缩放，数字 0 恢复全校视角。俯视测距时按回车选取视图中心。");
            stage.appendChild(renderer.domElement);
            scene = new THREE.Scene();
            perspective = new THREE.PerspectiveCamera(43, 1, 1, 12000);
            overhead = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 12000);
            overhead.up.set(0, 0, -1);
            scene.add(new THREE.HemisphereLight(0xffffff, 0xafc1b0, 0.86));
            var light = new THREE.DirectionalLight(0xfff0d4, 0.86);
            light.castShadow = true;
            light.shadow.mapSize.set(stage.clientWidth < 600 ? 1024 : 2048, stage.clientWidth < 600 ? 1024 : 2048);
            light.shadow.bias = -0.00015;
            light.shadow.normalBias = 0.18;
            scene.add(light); scene.add(light.target);
            center = new THREE.Vector3(); raycaster = new THREE.Raycaster();
            groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
            measurement = new THREE.Group();
            scene.add(measurement);
            outlineMaterial = new THREE.LineBasicMaterial({ color: 0x624f3e, transparent: true, opacity: 0.25, depthWrite: false });
            selectionMaterial = new THREE.LineBasicMaterial({ color: 0x037360, depthWrite: false });
            observer = new ResizeObserver(resize); observer.observe(stage); resize();
            var response = await fetch("/static/maps/xingshu-campus/manifest.json");
            if (!response.ok) throw new Error("Missing manifest");
            manifest = await response.json();
            var gatesResponse=await fetch("/static/maps/xingshu-campus/landmarks.json");
            if(!gatesResponse.ok) throw new Error("Missing gate landmarks");
            gateData=await gatesResponse.json();
            var auditFiles = ["buildings-01-14.json", "buildings-15-28.json", "buildings-29-42.json"];
            await Promise.all(auditFiles.map(async function (file) {
                try {
                    var auditResponse = await fetch("/static/maps/xingshu-campus/" + file);
                    if (!auditResponse.ok) return;
                    var audit = await auditResponse.json();
                    audit.features.forEach(function (entry) { reviews.set(entry.id, entry); });
                } catch (error) { /* The baseline model remains usable if optional review notes are unavailable. */ }
            }));
            var gltf = await new Promise(function (resolve, reject) {
                new THREE.GLTFLoader().load("/static/maps/xingshu-campus/xingshu-campus.glb", resolve, undefined, reject);
            });
            if (destroyed) return;
            model = gltf.scene; scene.add(model);
            model.traverse(function (node) {
                if (node.name.indexOf("feature__") === 0) roots.set(node.name.slice(9), node);
            });
            styleMap();
            var campusBox = new THREE.Box3().setFromObject(model.getObjectByName("layer__campus-ground"));
            roots.forEach(function (root, id) {
                var box = new THREE.Box3().setFromObject(root);
                bounds.set(id, box);
                campusBox.union(box);
            });
            createLabels();
            createGateMarkers();
            gateData.landmarks.forEach(function (gate) { campusBox.union(bounds.get(gate.id)); });
            measureLabels();
            campusPoints = manifest.referenceMap.campusBoundaryLocalEN.map(function (position) {
                return new THREE.Vector3(position[0], 0, -position[1]);
            });
            bounds.forEach(function (box) { campusPoints.push.apply(campusPoints, boxCorners(box)); });
            var size = campusBox.getSize(new THREE.Vector3());
            campusCenter = campusBox.getCenter(new THREE.Vector3());
            campusSpan = Math.max(size.x, size.z, size.y);
            grid = new THREE.GridHelper(4000, 80, 0x739184, 0x739184);
            grid.position.y = -0.3;
            grid.material.transparent = true;
            grid.material.opacity = 0.2;
            grid.material.depthWrite = false;
            scene.add(grid);
            light.target.position.copy(campusCenter);
            light.position.copy(campusCenter).add(new THREE.Vector3(-470, 720, 355));
            var shadowSpan = campusSpan * 0.82;
            Object.assign(light.shadow.camera, {
                left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan, near: 1, far: 1900
            });
            light.shadow.camera.updateProjectionMatrix();
            renderer.shadowMap.needsUpdate = true;
            searchInput.disabled = false;
            searchToggle.disabled = false;
            perspectiveButton.disabled = false;
            topButton.disabled = false;
            measureButton.disabled = false;
            fit(false);
            status.hidden = true;
            syncWater();
        } catch (error) {
            console.error("Campus map initialization failed", error);
            fail();
        }
    }
    function clearSelection() {
        highlight(selectedId, false);
        selectedId=""; searchInput.value=""; detail.hidden=true; closeSearch();
        info.textContent="点击楼块或搜索名称查看详情";
        draw();
    }
    document.getElementById("mapCloseDetail").addEventListener("click", clearSelection);
    function closeSearch() {
        searchOptions.hidden=true;activeSearchIndex=-1;
        searchInput.setAttribute("aria-expanded","false");searchInput.removeAttribute("aria-activedescendant");
        searchToggle.setAttribute("aria-expanded","false");
    }
    function showSearch(query) {
        if(!model) return;
        query=(query || "").trim().toLowerCase();
        searchMatches=Array.from(featureById.values()).filter(function(feature){return feature.name.toLowerCase().indexOf(query)!==-1 || feature.id.indexOf(query)!==-1;})
            .sort(function(a,b){return a.name.localeCompare(b.name,"zh-CN");});
        searchOptions.replaceChildren();activeSearchIndex=-1;
        searchInput.removeAttribute("aria-activedescendant");
        searchMatches.forEach(function(feature,index){
            var option=document.createElement("button");option.type="button";option.tabIndex=-1;option.id="map-option-"+feature.id;
            option.setAttribute("role","option");option.setAttribute("aria-selected",String(feature.id===selectedId));
            option.textContent=feature.name;option.addEventListener("click",function(){chooseSearch(index);});searchOptions.appendChild(option);
        });
        if(!searchMatches.length){var empty=document.createElement("p");empty.textContent="没有找到相关建筑或校门";searchOptions.appendChild(empty);}
        searchOptions.hidden=false;searchInput.setAttribute("aria-expanded","true");searchToggle.setAttribute("aria-expanded","true");
    }
    function chooseSearch(index) {
        if(!searchMatches[index])return;
        if (measuring) setMeasuring(false);
        setSelection(searchMatches[index].id);focusSelected();
    }
    searchInput.addEventListener("focus",function(){showSearch(searchInput.value);});
    searchInput.addEventListener("input",function(){showSearch(searchInput.value);});
    searchToggle.addEventListener("click",function(){if(searchOptions.hidden){searchInput.focus();showSearch("");}else closeSearch();});
    document.addEventListener("pointerdown",function(event){if(!searchForm.contains(event.target))closeSearch();});
    searchForm.addEventListener("focusout",function(event){if(!searchForm.contains(event.relatedTarget))closeSearch();});
    searchInput.addEventListener("keydown",function(event){
        if(event.key==="Escape"){closeSearch();return;}
        if(event.key!=="ArrowDown" && event.key!=="ArrowUp")return;
        event.preventDefault();if(searchOptions.hidden)showSearch(searchInput.value);if(!searchMatches.length)return;
        activeSearchIndex=activeSearchIndex<0?(event.key==="ArrowDown"?0:searchMatches.length-1):(activeSearchIndex+(event.key==="ArrowDown"?1:-1)+searchMatches.length)%searchMatches.length;
        Array.from(searchOptions.children).forEach(function(option,index){option.classList.toggle("is-active",index===activeSearchIndex);});
        var active=searchOptions.children[activeSearchIndex];searchInput.setAttribute("aria-activedescendant",active.id);active.scrollIntoView({block:"nearest"});
    });
    searchForm.addEventListener("submit", function (event) {
        event.preventDefault(); if (!model) return;
        if(searchOptions.hidden)showSearch(searchInput.value);
        if(searchMatches.length)chooseSearch(activeSearchIndex<0?0:activeSearchIndex);
    });
    function focusSelected() {
        var box = bounds.get(selectedId); if (!box) return;
        var target = box.getCenter(new THREE.Vector3());
        atOverview = false;
        moveCamera(target, Math.max(125, fittedRadius(boxCorners(box), target, 0.49, 0.45)), true);
    }
    perspectiveButton.addEventListener("click", function () {
        setMeasuring(false);
        fit(false);
    });
    topButton.addEventListener("click", function () { fit(true); });
    document.getElementById("mapDetailFocus").addEventListener("click", focusSelected);
    document.getElementById("mapNorth").addEventListener("click", function () { if(model) fit(true); });
    document.getElementById("mapZoomIn").addEventListener("click", function () { if(model) zoom(0.8, true); });
    document.getElementById("mapZoomOut").addEventListener("click", function () { if(model) zoom(1.25, true); });
    var fullscreen = document.getElementById("mapFullscreen");
    fullscreen.hidden = !shell.requestFullscreen;
    fullscreen.addEventListener("click", async function () {
        try { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.requestFullscreen(); }
        catch (error) { info.textContent = "浏览器暂时无法进入全屏，请使用窗口查看。"; }
    });
    document.addEventListener("fullscreenchange", function () {
        var active = document.fullscreenElement === shell;
        fullscreen.querySelector("i").className = active ? "fas fa-compress" : "fas fa-expand";
        fullscreen.querySelector("span").textContent = active ? "退出全屏" : "全屏";
    });
    stage.addEventListener("wheel", function (event) {
        if (!model || event.target.closest("aside")) return;
        event.preventDefault();
        zoom(Math.exp(THREE.MathUtils.clamp(event.deltaY, -100, 100) * 0.0015));
    }, { passive: false });
    stage.addEventListener("pointerdown", function (event) {
        if (!model || event.target.closest("button, aside") || (event.button !== 0 && event.button !== 2)) return;
        stopTransition();
        panGesture=event.button===2 || event.shiftKey;
        renderer.domElement.focus({preventScroll:true});
        stage.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size === 1) { moved = false; down = { x: event.clientX, y: event.clientY }; }
        else { moved = true; pinchDistance = distance(); }
    });
    stage.addEventListener("pointermove", function (event) {
        var previous = pointers.get(event.pointerId); if (!previous) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size > 1) {
            var current = distance(); if (current > 0 && pinchDistance > 0) zoom(pinchDistance / current);
            pan((event.clientX-previous.x)/2,(event.clientY-previous.y)/2);
            pinchDistance = current; moved = true;
        } else {
            if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) moved = true;
            if (!moved) return;
            if (panGesture || topView) { pan(event.clientX - previous.x, event.clientY - previous.y); return; }
            atOverview = false;
            theta -= (event.clientX - previous.x) * 0.006;
            phi = Math.max(0.001, Math.min(1.48, phi + (event.clientY - previous.y) * 0.006)); draw();
        }
    });
    stage.addEventListener("pointerup", function (event) {
        if (!pointers.has(event.pointerId)) return;
        pointers.delete(event.pointerId);
        if (moved || panGesture || !model) return;
        var rect = renderer.domElement.getBoundingClientRect();
        raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
            -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
        if (measuring) {
            var point = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
            if (point) markDistance(point);
            return;
        }
        var hits = raycaster.intersectObjects(pickables, false);
        if (!hits.length) return;
        var node = hits[0].object;
        while (node && node.name.indexOf("feature__") !== 0) node = node.parent;
        if (node) setSelection(node.name.slice(9));
    });
    stage.addEventListener("pointercancel", function (event) { pointers.delete(event.pointerId); moved = true; });
    stage.addEventListener("contextmenu", function(event){event.preventDefault();});
    stage.addEventListener("keydown", function (event) {
        if (!model || event.target!==renderer.domElement) return;
        var arrows = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] };
        var direction = arrows[event.key];
        if (direction) {
            if (topView) pan(direction[0], direction[1]);
            else {
                stopTransition();
                atOverview = false;
                theta += direction[0] / 350;
                phi = THREE.MathUtils.clamp(phi - direction[1] / 350, 0.001, 1.48);
                draw();
            }
        } else if (event.key === "+" || event.key === "=") zoom(0.9);
        else if (event.key === "-") zoom(1.1);
        else if (event.key === "0") fit(topView);
        else if (event.key === "Escape" && measuring) setMeasuring(false);
        else if (event.key === "Enter" && measuring) markDistance(new THREE.Vector3(center.x, 0, center.z));
        else return;
        event.preventDefault();
    });
    reducedMotion.addEventListener("change", syncWater);
    document.addEventListener("visibilitychange", syncWater);
    window.addEventListener("pageshow", function (event) { if (event.persisted) syncWater(); });
    window.addEventListener("pagehide", function (event) {
        clearInterval(waterTimer);
        if (event.persisted) return;
        destroyed = true;
        stopTransition();
        if (observer) observer.disconnect();
        if (scene) scene.traverse(function (node) {
            if (node.geometry) node.geometry.dispose();
            if (node.material) (Array.isArray(node.material) ? node.material : [node.material]).forEach(function (material) { material.dispose(); });
        });
        if (outlineMaterial) outlineMaterial.dispose();
        if (selectionMaterial) selectionMaterial.dispose();
        if (renderer) renderer.dispose();
    });
    init();
}());
