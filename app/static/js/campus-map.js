/* Local dual-campus 3D explorer. Geometry is preserved; functional styling & POI guide enhance readability. */
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
    var guideToggle = document.getElementById("mapGuideToggle"), guidePanel = document.getElementById("mapGuidePanel");
    var guideList = document.getElementById("mapGuideList"), guideClose = document.getElementById("mapGuideClose");
    var guideTitle = document.getElementById("mapGuideTitle"), guideSubtitle = document.getElementById("mapGuideSubtitle");
    var resetButton = document.getElementById("mapReset");
    var detailMeasureButton = document.getElementById("mapDetailMeasure");
    var scale = document.getElementById("mapScale"), compass = document.getElementById("mapCompass");
    var titleEl = document.getElementById("mapTitle"), noticeEl = document.getElementById("mapNotice");
    var creditTextEl = document.getElementById("mapCreditText"), noticeLinkEl = document.getElementById("mapNoticeLink");
    var campusButtons = Array.from(document.querySelectorAll("#mapCampusSwitch button[data-campus]"));
    var categoryButtons = Array.from(document.querySelectorAll("#mapCategoryBar button[data-category]"));
    var overlays = [detail, measurePanel, guidePanel, scale, document.getElementById("mapStageBadge"), document.getElementById("mapControls")];

    var CATEGORY_LABELS = {
        teaching: "主要教学楼",
        landmark: "核心地标",
        place: "湖泊广场",
        canteen: "食堂餐饮",
        dorm: "学生公寓",
        gate: "校门通道",
        service: "校园配套",
        candidate: "待核验建筑"
    };
    var GUIDE_ORDER = ["teaching", "landmark", "place", "canteen", "gate", "dorm"];

    var CAMPUSES = {
        xingshu: {
            id: "xingshu",
            title: "行署校区",
            subtitle: "三维地图",
            basePath: "/static/maps/xingshu-campus/",
            glb: "xingshu-campus.glb",
            auditFiles: ["buildings-01-14.json", "buildings-15-28.json", "buildings-29-42.json"],
            overviewLandmarks: new Set([
                "教学楼", "第二教学楼", "计算机中心", "高职学院实训大楼",
                "图书馆", "行署礼堂", "体育馆", "第一学生食堂"
            ]),
            noticeHtml: "本地图由学生绘制，非官方。<br>建筑与校门信息待核验，请以现场指示为准。",
            creditHtml: '学生整理白模与名称来自 <a href="https://scswiki.com/start/xingshu-campus-map" target="_blank" rel="noopener noreferrer">SCSWiki</a>（<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>）。道路与地面数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors（ODbL）</a>。',
            noticeHref: "/static/maps/xingshu-campus/NOTICE.txt"
        },
        huafeng: {
            id: "huafeng",
            title: "华凤校区",
            subtitle: "三维地图（一期 + 二期）",
            basePath: "/static/maps/huafeng-campus/",
            glb: "huafeng-campus.glb",
            auditFiles: ["buildings-review.json"],
            overviewLandmarks: new Set([
                "朝阳楼", "文科楼", "化学楼", "进德楼", "修业楼", "实训楼",
                "图书馆", "办公大楼", "体育中心", "华凤园餐厅", "李园餐厅（二期食堂）",
                "迎曦湖", "毓秀湖"
            ]),
            noticeHtml: "华凤校区白模基于 OpenStreetMap 矢量轮廓生成，非官方导航图。<br>未命名楼块、楼高与出入口待核验，请以现场指示为准。",
            creditHtml: '华凤校区白模（一期 + 二期）基于 OpenStreetMap 矢量轮廓自动生成。道路、水体、运动场与建筑轮廓数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors（ODbL 1.0）</a>。',
            noticeHref: "/static/maps/huafeng-campus/NOTICE.txt"
        }
    };

    var initialCampus = (new URLSearchParams(window.location.search).get("campus") || "").toLowerCase();
    var currentCampusId = CAMPUSES[initialCampus] ? initialCampus : "xingshu";
    var overviewLandmarks = CAMPUSES[currentCampusId].overviewLandmarks;
    var activeCategory = "all";
    var loadToken = 0;

    var labels = new Map(), reviews = new Map(), featureById = new Map(), selectedId = "", panGesture = false;
    var renderer, observer, model, manifest, scene, camera, perspective, overhead, gateData, light;
    var roots = new Map(), bounds = new Map(), outlines = new Map(), buildingMeshesById = new Map();
    var pickables = [], markerGroups = [], pointers = new Map();
    var center, campusCenter, campusSpan, campusPoints, radius, theta = Math.PI / 5, phi = 0.83;
    var aspect = 1, topView = false, measuring = false, atOverview = true;
    var outlineMaterial, selectionMaterial, categoryMaterials, sharedMaterials = new Set();
    var measurement, groundPlane, grid;
    var points = [], cameraFrame = 0, waterTimer = 0, waterTime = { value: 0 };
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var touchPrimary = window.matchMedia("(pointer: coarse)");
    var raycaster, moved = false, down, pinchDistance = 0, destroyed = false;
    var defaultSelectionSummary = "点击楼块或搜索名称查看详情";

    function fail(message) {
        status.hidden = false;
        status.textContent = message || "地图加载失败或浏览器不支持 WebGL，请刷新重试，也可使用页面下方的许可与数据来源链接。";
    }

    function featureCategory(feature) {
        if (!feature) return "service";
        if (feature.kind === "gate") return "gate";
        if (feature.kind === "place") return "place";
        if (feature.category && CATEGORY_LABELS[feature.category]) return feature.category;
        if (feature.verification !== "named") return "candidate";
        var name = feature.name || "";
        if (/图书馆|礼堂|办公楼|办公大楼|办公房|旧址|博物馆|校史|钟鼓楼|医院|体育馆|体育中心/.test(name)) return "landmark";
        if (/食堂|餐厅/.test(name)) return "canteen";
        if (/教学|实训|计算机|科技园|朝阳楼|文科楼|化学楼|音乐楼|美术楼|进德楼|修业楼|宁静楼|生物|新闻传播|学院|天文台/.test(name)) return "teaching";
        if (/公寓|宿舍|专家楼|宾馆|西[二三四五七]楼|东三楼|校[一二]幢/.test(name)) return "dorm";
        return "service";
    }

    function buildingIcon(featureOrName) {
        var feature = typeof featureOrName === "object" ? featureOrName : null;
        var name = feature ? (feature.name || "") : String(featureOrName || "");
        if (feature && feature.kind === "place") {
            if (feature.placeKind === "lake") return "fa-water";
            if (feature.placeKind === "square") return "fa-compass";
            if (feature.placeKind === "sports") return "fa-basketball-ball";
            return "fa-map-marker-alt";
        }
        if (/门|桥/.test(name)) return "fa-door-open";
        if (/图书|史|旧址|博物|钟鼓/.test(name)) return "fa-book-open";
        if (/食堂|餐厅/.test(name)) return "fa-utensils";
        if (/公寓|宿舍|专家楼|宾馆/.test(name)) return "fa-bed";
        if (/医院/.test(name)) return "fa-plus-square";
        if (/体育/.test(name)) return "fa-running";
        if (/办公|礼堂/.test(name)) return "fa-landmark";
        if (/教学|实训|计算机|科技园|朝阳楼|文科楼|化学楼|音乐楼|美术楼|进德楼|修业楼|宁静楼|生物|新闻传播|学院|天文/.test(name)) return "fa-graduation-cap";
        return "fa-building";
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

    function updateStageHint() {
        var hintEl = document.getElementById("mapViewHint");
        if (!hintEl) return;
        if (activeCategory !== "all") {
            hintEl.textContent = "已筛选「" + (CATEGORY_LABELS[activeCategory] || activeCategory) + "」· 点击标签或楼块查看详情";
            return;
        }
        hintEl.textContent = touchPrimary.matches
            ? (topView ? "拖动平移 · 双指缩放" : "拖动旋转 · 双指缩放和平移")
            : (topView ? "拖动平移 · 滚轮缩放" : "拖动旋转 · Shift + 拖动平移");
    }

    function fit(top) {
        if (!campusPoints) return;
        atOverview = true;
        topView = top;
        camera = top ? overhead : perspective;
        phi = 0.83;
        theta = Math.PI / 5;
        if (grid) grid.visible = top;
        perspectiveButton.setAttribute("aria-pressed", String(!top));
        topButton.setAttribute("aria-pressed", String(top));
        updateStageHint();
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

    function applyBuildingMaterials() {
        if (!categoryMaterials) return;
        buildingMeshesById.forEach(function (meshes, id) {
            var feature = featureById.get(id);
            var cat = featureCategory(feature);
            var selectedFeature = featureById.get(selectedId);
            var isSelected = id === selectedId || (selectedFeature && selectedFeature.parentId === id);
            var matPair;
            if (isSelected) {
                matPair = categoryMaterials.selected;
            } else if (activeCategory !== "all" && cat !== activeCategory) {
                matPair = categoryMaterials.muted;
            } else {
                matPair = categoryMaterials[cat] || categoryMaterials.service;
            }
            meshes.forEach(function (mesh) { mesh.material = matPair; });
        });
    }

    function setSelection(id) {
        var root = roots.get(id);
        if (!root || measuring) return;
        highlight(selectedId, false);
        selectedId = id;
        var feature = featureById.get(id);
        var isGate = feature.kind === "gate";
        var isPlace = feature.kind === "place";
        var isPointMarker = isGate || isPlace;
        var cat = featureCategory(feature);
        var box = bounds.get(id);
        var position = isPointMarker ? [root.position.x, -root.position.z] : feature.centerLocalEN;
        searchInput.value = feature.name;
        closeSearch();
        info.textContent = feature.name + (isGate ? " · 示意出入口" : isPlace ? " · 校园重要地点" : " · " + (CATEGORY_LABELS[cat] || "建筑") + "（待核验）");
        detail.hidden = false;
        document.getElementById("mapDetailName").textContent = feature.name;
        document.getElementById("mapDetailIcon").className = "fas " + buildingIcon(feature);
        var iconWrap = document.getElementById("mapDetailIconWrap");
        if (iconWrap) iconWrap.className = "map-detail-icon cat-" + cat;
        var catBadge = document.getElementById("mapDetailCategory");
        if (catBadge) {
            catBadge.className = "map-cat-badge cat-" + cat;
            catBadge.textContent = (CATEGORY_LABELS[cat] || "建筑") + (feature.campusZone ? " · " + feature.campusZone : "");
        }
        document.getElementById("mapDetailId").textContent = id;
        document.getElementById("mapDetailReview").textContent = isGate ? "位置示意" : isPlace ? "OSM 景观定位" : feature.nameSource ? "用户校正名称" : "信息待核验";
        document.getElementById("mapDetailPosition").textContent = "E " + Math.round(position[0]) + " m · N " + Math.round(position[1]) + " m";
        document.getElementById("mapDetailHeightRow").hidden = isPointMarker;
        var hMeters = Math.round(box.max.y - box.min.y);
        document.getElementById("mapDetailHeight").textContent = feature.levels ? (hMeters + " m · 约 " + feature.levels + " 层") : (hMeters + " m");
        var review = reviews.get(id);
        var conflict = review && review.modelName && review.modelName !== feature.name;
        var extraIssue = review && Array.isArray(review.issues) && review.issues.find(function (msg) {
            return msg.indexOf("OSM 中有") === 0 || msg.indexOf("未填写楼名") !== -1;
        });
        document.getElementById("mapDetailNote").textContent = isPointMarker ? feature.note : feature.nameSource
            ? "名称依据用户提供的校园截图校正。" + (feature.parentId ? "分栋位置按截图示意，当前模型仍为连体轮廓；" : "") + "建筑轮廓与高度沿用 OSM 模型，尚非实测。"
            : conflict
            ? "清单与模型内部名称（" + review.modelName + "）有差异，需现场校对。位置与高度均取自模型。"
            : extraIssue
            ? extraIssue + " 坐标为模型原点的东向、北向偏移，高度为估算值。"
            : "坐标为模型原点的东向、北向偏移，高度为楼块几何高度。实景与楼层待核验。";
        highlight(id, true);
        applyBuildingMaterials();
        syncGuideSelection();
        draw();
    }

    function highlight(id, selected) {
        var feature = featureById.get(id);
        if (feature && feature.parentId) id = feature.parentId;
        (outlines.get(id) || []).forEach(function (outline) {
            outline.material = selected ? selectionMaterial : outlineMaterial;
        });
    }

    function createLabels() {
        manifest.features.forEach(function (feature) {
            var box = bounds.get(feature.id); if (!box) return;
            if (feature.parts) {
                // Keep the parent searchable while presenting each annotated wing separately.
                featureById.set(feature.id, feature);
                feature.parts.forEach(function (part) {
                    var child = Object.assign({}, feature, part, {
                        id: feature.id + "-" + part.suffix, parentId: feature.id, parts: undefined
                    });
                    var region = part.boundsLocalEN;
                    var partBox = new THREE.Box3(
                        new THREE.Vector3(region[0], box.min.y, -region[3]),
                        new THREE.Vector3(region[2], box.max.y, -region[1]));
                    roots.set(child.id, roots.get(feature.id));
                    bounds.set(child.id, partBox);
                    addLabel(child, new THREE.Vector3(part.centerLocalEN[0], box.max.y + 2.5, -part.centerLocalEN[1]));
                });
                return;
            }
            var anchor = box.getCenter(new THREE.Vector3());
            anchor.y = box.max.y + 2.5;
            addLabel(feature, anchor);
        });
    }

    function addLabel(feature, anchor) {
        featureById.set(feature.id, feature);
        var cat = featureCategory(feature);
        var button = document.createElement("button");
        button.type = "button";
        button.className = "map-building-label cat-" + cat
            + (feature.kind === "gate" ? " is-gate" : feature.kind === "place" ? " is-place" : feature.verification === "named" ? "" : " is-candidate");
        button.setAttribute("aria-label", feature.name + "，点击查看详情");
        button.title = feature.name + (feature.campusZone ? "（" + feature.campusZone + "）" : "");
        var icon = document.createElement("span"); icon.className = "map-poi-icon";
        var glyph = document.createElement("i"); glyph.className = "fas " + buildingIcon(feature); glyph.setAttribute("aria-hidden", "true");
        icon.appendChild(glyph); button.appendChild(icon);
        var title = document.createElement("span");
        title.textContent = (feature.verification === "named" || feature.kind === "gate" || feature.kind === "place")
            ? feature.name
            : "待核验建筑 " + feature.id.slice(-2);
        button.appendChild(title);
        if (feature.verification === "named" && feature.kind !== "place") {
            var badge = document.createElement("span"); badge.className = "map-label-review"; badge.textContent = "?"; badge.title = "名称与位置待核验"; button.appendChild(badge);
        }
        var line = document.createElementNS("http://www.w3.org/2000/svg", "line"); linesLayer.appendChild(line);
        labelLayer.appendChild(button);
        button.addEventListener("click", function () { setSelection(feature.id); });
        labels.set(feature.id, { button: button, anchor: anchor, line: line, feature: feature, category: cat });
    }

    function createGateMarkers() {
        var pinScale = Math.max(1, Math.min(1.55, (campusSpan || 650) / 760));
        (gateData.landmarks || []).forEach(function (gate, idx) {
            var root = new THREE.Group(); root.name = "feature__" + gate.id;
            root.position.set(gate.positionLocal[0], 1, gate.positionLocal[2]);
            var color = (gate.id === "gate-west" || idx % 2 === 1) ? 0x23699e : 0x158074;
            var pinMaterial = new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide });
            var ring = new THREE.Mesh(new THREE.RingGeometry(5.5 * pinScale, 8 * pinScale, 32), pinMaterial);
            ring.rotation.x = -Math.PI / 2; root.add(ring);
            var post = new THREE.Mesh(new THREE.CylinderGeometry(0.8 * pinScale, 0.8 * pinScale, 12 * pinScale, 8), pinMaterial);
            post.position.y = 6 * pinScale; root.add(post);
            var pin = new THREE.Mesh(new THREE.SphereGeometry(3.2 * pinScale, 12, 8), pinMaterial);
            pin.position.y = 13 * pinScale; root.add(pin);
            scene.add(root); roots.set(gate.id, root); markerGroups.push(root);
            bounds.set(gate.id, new THREE.Box3().setFromObject(root));
            pickables.push(ring, post, pin);
            var feature = { id: gate.id, name: gate.name, kind: "gate", category: "gate", verification: "named", note: gate.note };
            addLabel(feature, new THREE.Vector3(root.position.x, 18 * pinScale, root.position.z));
        });
    }

    function createPlaceMarkers() {
        var pinScale = Math.max(1, Math.min(1.5, (campusSpan || 650) / 800));
        (gateData.places || []).forEach(function (place) {
            var root = new THREE.Group(); root.name = "feature__" + place.id;
            root.position.set(place.positionLocal[0], 0.9, place.positionLocal[2]);
            var color = place.placeKind === "lake" ? 0x1c84a6 : place.placeKind === "square" ? 0xc07e28 : 0xb8543d;
            var ringMat = new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
            var ring = new THREE.Mesh(new THREE.RingGeometry(5 * pinScale, 7.6 * pinScale, 28), ringMat);
            ring.rotation.x = -Math.PI / 2; root.add(ring);
            var dot = new THREE.Mesh(new THREE.CircleGeometry(2.6 * pinScale, 20), ringMat);
            dot.rotation.x = -Math.PI / 2; dot.position.y = 0.05; root.add(dot);
            scene.add(root); roots.set(place.id, root); markerGroups.push(root);
            bounds.set(place.id, new THREE.Box3().setFromObject(root));
            pickables.push(ring, dot);
            var feature = {
                id: place.id, name: place.name, kind: "place", placeKind: place.placeKind,
                category: "place", campusZone: place.campusZone, verification: "named", note: place.note
            };
            addLabel(feature, new THREE.Vector3(root.position.x, 8 * pinScale, root.position.z));
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
        var reserved = overlays.filter(function (element) { return element && !element.hidden; }).map(function (element) {
            return { x: element.offsetLeft, y: element.offsetTop, w: element.offsetWidth, h: element.offsetHeight };
        });
        labels.forEach(function (label, id) {
            var cat = label.category;
            var isGate = label.feature.kind === "gate";
            var isSelected = id === selectedId;
            var isFiltering = activeCategory !== "all";
            var matchesFilter = !isFiltering || cat === activeCategory;
            var isOverviewLandmark = atOverview && width >= 680 && label.feature.verification === "named" && overviewLandmarks.has(label.feature.name);
            label.button.classList.toggle("is-selected", isSelected);

            if (measuring) return;
            var shouldShow = isSelected;
            if (!shouldShow) {
                if (isFiltering) {
                    shouldShow = matchesFilter && (label.feature.verification === "named" || isGate || label.feature.kind === "place");
                } else if (topView) {
                    shouldShow = true;
                } else {
                    shouldShow = isGate || isOverviewLandmark;
                }
            }
            if (!shouldShow) return;

            var projected = label.anchor.clone().project(camera);
            if (projected.z < -1 || projected.z > 1) return;
            var priority = isSelected ? 3000
                : (isFiltering && matchesFilter) ? (cat === "teaching" ? 1600 : 1400)
                : isGate ? 2000
                : isOverviewLandmark ? (cat === "teaching" ? 900 : 850)
                : label.feature.kind === "place" ? 300
                : label.feature.verification === "named" ? (cat === "teaching" ? 260 : cat === "landmark" ? 240 : 120)
                : 0;
            items.push({
                id: id, x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2,
                w: label.width, h: label.height,
                alwaysShow: isSelected || (!isFiltering && isGate),
                priority: priority
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
                label.line.setAttribute("x1", lineX); label.line.setAttribute("y1", lineY);
                label.line.setAttribute("x2", placement.anchorX); label.line.setAttribute("y2", placement.anchorY);
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

    function initSharedMaterials() {
        var makePair = function (wallHex, roofHex) {
            var wall = mapMaterial(wallHex);
            var roof = mapMaterial(roofHex);
            sharedMaterials.add(wall);
            sharedMaterials.add(roof);
            return [wall, roof];
        };
        categoryMaterials = {
            teaching: makePair(0xc2925b, 0xf2cf94),
            landmark: makePair(0x7fa696, 0xcde3d6),
            canteen: makePair(0xc78b6b, 0xf4c7aa),
            dorm: makePair(0xbcaf97, 0xebe2ce),
            service: makePair(0xb5b0a2, 0xe3dfd1),
            candidate: makePair(0xb8b4a8, 0xe4e0d4),
            muted: makePair(0xc9cec6, 0xe5e9e2),
            selected: makePair(0x1f826e, 0xffe49e)
        };
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

        var manifestById = new Map((manifest.features || []).map(function (f) { return [f.id, f]; }));
        roots.forEach(function (root, id) {
            var edges = [];
            var meshes = [];
            var cat = featureCategory(manifestById.get(id));
            var pair = categoryMaterials[cat] || categoryMaterials.service;
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
                geometry.setIndex(wallIndices.concat(roofIndices));
                geometry.clearGroups();
                if (wallIndices.length) geometry.addGroup(0, wallIndices.length, 0);
                if (roofIndices.length) geometry.addGroup(wallIndices.length, roofIndices.length, 1);
                previousMaterials.add(mesh.material);
                mesh.material = pair;
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                pickables.push(mesh);
                meshes.push(mesh);
                edges.push(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 35), outlineMaterial));
            });
            var edgeIndex = 0;
            root.traverse(function (mesh) {
                if (mesh.isMesh) mesh.add(edges[edgeIndex++]);
            });
            outlines.set(id, edges);
            buildingMeshesById.set(id, meshes);
        });
        previousMaterials.forEach(function (material) {
            if (material && !sharedMaterials.has(material)) material.dispose();
        });
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

    function updateCategoryCountsAndGuide() {
        var counts = { teaching: 0, landmark: 0, place: 0, canteen: 0, dorm: 0, gate: 0 };
        featureById.forEach(function (feature) {
            if (feature.verification !== "named" && feature.kind !== "gate" && feature.kind !== "place") return;
            var cat = featureCategory(feature);
            if (!feature.parts && counts[cat] !== undefined) counts[cat]++;
        });
        categoryButtons.forEach(function (btn) {
            var cat = btn.dataset.category;
            if (cat === "all") return;
            var em = btn.querySelector("em");
            if (em) em.textContent = String(counts[cat] || 0);
            btn.hidden = (counts[cat] || 0) === 0;
        });
        if (activeCategory !== "all" && !counts[activeCategory]) activeCategory = "all";
        syncCategoryButtons();
        var config = CAMPUSES[currentCampusId];
        var parts = [config.title];
        if (counts.teaching) parts.push(counts.teaching + " 处主要教学楼");
        if (counts.landmark) parts.push(counts.landmark + " 处核心地标");
        if (counts.place) parts.push(counts.place + " 处湖泊广场");
        parts.push((manifest.features || []).length + " 栋建筑轮廓");
        defaultSelectionSummary = parts.join(" · ");
        if (!selectedId) info.textContent = defaultSelectionSummary;
        renderGuideList();
    }

    function syncCategoryButtons() {
        categoryButtons.forEach(function (btn) {
            var active = btn.dataset.category === activeCategory;
            btn.classList.toggle("is-active", active);
            btn.setAttribute("aria-pressed", String(active));
        });
    }

    function setCategory(cat) {
        if (cat === activeCategory && cat !== "all") activeCategory = "all";
        else activeCategory = cat;
        syncCategoryButtons();
        updateStageHint();
        applyBuildingMaterials();
        renderGuideList();
        draw();
    }

    categoryButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (!model) return;
            setCategory(btn.dataset.category);
        });
    });

    function syncGuideSelection() {
        if (!guideList) return;
        Array.from(guideList.querySelectorAll(".map-guide-item")).forEach(function (el) {
            el.classList.toggle("is-selected", el.dataset.id === selectedId);
        });
    }

    function renderGuideList() {
        if (!guideList) return;
        guideList.replaceChildren();
        var config = CAMPUSES[currentCampusId];
        if (guideTitle) guideTitle.textContent = config.title + " · 重点地点导览";
        if (guideSubtitle) {
            guideSubtitle.textContent = activeCategory === "all"
                ? "点击任意教学楼或地标平滑聚焦"
                : "当前筛选：" + (CATEGORY_LABELS[activeCategory] || activeCategory);
        }
        var groups = new Map();
        GUIDE_ORDER.forEach(function (cat) { groups.set(cat, []); });
        featureById.forEach(function (feature) {
            if (feature.parts || (feature.verification !== "named" && feature.kind !== "gate" && feature.kind !== "place")) return;
            var cat = featureCategory(feature);
            if (!groups.has(cat)) return;
            if (activeCategory !== "all" && cat !== activeCategory) return;
            groups.get(cat).push(feature);
        });
        GUIDE_ORDER.forEach(function (cat) {
            var list = groups.get(cat);
            if (!list || !list.length) return;
            list.sort(function (a, b) {
                var aKey = overviewLandmarks.has(a.name) ? 0 : 1;
                var bKey = overviewLandmarks.has(b.name) ? 0 : 1;
                return (aKey - bKey) || a.name.localeCompare(b.name, "zh-CN");
            });
            var section = document.createElement("div");
            var heading = document.createElement("div");
            heading.className = "map-guide-group-title";
            heading.innerHTML = "<span>" + CATEGORY_LABELS[cat] + "</span><span>" + list.length + "</span>";
            section.appendChild(heading);
            var wrap = document.createElement("div");
            wrap.className = "map-guide-items";
            list.forEach(function (feature) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = "map-guide-item" + (feature.id === selectedId ? " is-selected" : "");
                btn.dataset.id = feature.id;
                var iconWrap = document.createElement("span");
                iconWrap.className = "map-guide-item-icon map-cat-badge cat-" + cat;
                var glyph = document.createElement("i");
                glyph.className = "fas " + buildingIcon(feature);
                glyph.setAttribute("aria-hidden", "true");
                iconWrap.appendChild(glyph);
                var text = document.createElement("span");
                text.className = "map-guide-item-text";
                text.textContent = feature.name;
                btn.appendChild(iconWrap);
                btn.appendChild(text);
                if (feature.campusZone) {
                    var meta = document.createElement("span");
                    meta.className = "map-guide-meta";
                    meta.textContent = feature.campusZone.replace(/（.*）/, "");
                    btn.appendChild(meta);
                }
                btn.addEventListener("click", function () {
                    if (measuring) setMeasuring(false);
                    setSelection(feature.id);
                    focusSelected();
                    if (window.innerWidth < 768) setGuideOpen(false);
                });
                wrap.appendChild(btn);
            });
            section.appendChild(wrap);
            guideList.appendChild(section);
        });
    }

    function setGuideOpen(open) {
        if (!guidePanel || !guideToggle) return;
        guidePanel.hidden = !open;
        guideToggle.setAttribute("aria-pressed", String(open));
        stage.classList.toggle("has-guide", open);
        draw();
    }

    if (guideToggle) guideToggle.addEventListener("click", function () { setGuideOpen(guidePanel.hidden); });
    if (guideClose) guideClose.addEventListener("click", function () { setGuideOpen(false); });

    function disposeObject(root) {
        if (!root) return;
        root.traverse(function (node) {
            if (node.geometry) node.geometry.dispose();
            if (node.material) {
                (Array.isArray(node.material) ? node.material : [node.material]).forEach(function (material) {
                    if (material && material !== outlineMaterial && material !== selectionMaterial && !sharedMaterials.has(material)) {
                        material.dispose();
                    }
                });
            }
        });
    }

    function clearCampusScene() {
        stopTransition();
        clearInterval(waterTimer);
        waterTimer = 0;
        if (measuring) setMeasuring(false);
        else clearMeasurement();
        selectedId = "";
        activeCategory = "all";
        syncCategoryButtons();
        searchInput.value = "";
        detail.hidden = true;
        closeSearch();
        info.textContent = "点击楼块或搜索名称查看详情";
        if (model) {
            scene.remove(model);
            disposeObject(model);
            model = null;
        }
        if (grid) {
            scene.remove(grid);
            disposeObject(grid);
            grid = null;
        }
        markerGroups.forEach(function (group) {
            scene.remove(group);
            disposeObject(group);
        });
        markerGroups = [];
        roots.clear();
        bounds.clear();
        outlines.clear();
        buildingMeshesById.clear();
        pickables = [];
        labels.clear();
        reviews.clear();
        featureById.clear();
        labelLayer.replaceChildren();
        linesLayer.replaceChildren();
    }

    function syncCampusHeader(config) {
        if (titleEl) {
            titleEl.textContent = "";
            titleEl.appendChild(document.createTextNode(config.title + " "));
            var span = document.createElement("span");
            span.textContent = config.subtitle;
            titleEl.appendChild(span);
        }
        if (noticeEl) noticeEl.innerHTML = config.noticeHtml;
        if (creditTextEl) creditTextEl.innerHTML = config.creditHtml;
        if (noticeLinkEl) noticeLinkEl.href = config.noticeHref;
        campusButtons.forEach(function (btn) {
            btn.setAttribute("aria-pressed", String(btn.dataset.campus === config.id));
        });
    }

    function setToolbarDisabled(disabled) {
        searchInput.disabled = disabled;
        searchToggle.disabled = disabled;
        perspectiveButton.disabled = disabled;
        topButton.disabled = disabled;
        measureButton.disabled = disabled;
        if (guideToggle) guideToggle.disabled = disabled;
        if (resetButton) resetButton.disabled = disabled;
        campusButtons.forEach(function (btn) { btn.disabled = disabled; });
    }

    async function loadCampus(campusId) {
        var config = CAMPUSES[campusId] || CAMPUSES.xingshu;
        var token = ++loadToken;
        currentCampusId = config.id;
        overviewLandmarks = config.overviewLandmarks;
        syncCampusHeader(config);
        setToolbarDisabled(true);
        status.hidden = false;
        status.textContent = "正在加载" + config.title + "三维地图…";
        clearCampusScene();
        try {
            var response = await fetch(config.basePath + "manifest.json");
            if (!response.ok) throw new Error("Missing manifest");
            var nextManifest = await response.json();
            var gatesResponse = await fetch(config.basePath + "landmarks.json");
            if (!gatesResponse.ok) throw new Error("Missing gate landmarks");
            var nextGates = await gatesResponse.json();
            var nextReviews = new Map();
            await Promise.all((config.auditFiles || []).map(async function (file) {
                try {
                    var auditResponse = await fetch(config.basePath + file);
                    if (!auditResponse.ok) return;
                    var audit = await auditResponse.json();
                    (audit.features || []).forEach(function (entry) { nextReviews.set(entry.id, entry); });
                } catch (error) { /* The baseline model remains usable if optional review notes are unavailable. */ }
            }));
            var gltf = await new Promise(function (resolve, reject) {
                new THREE.GLTFLoader().load(config.basePath + config.glb, resolve, undefined, reject);
            });
            if (destroyed || token !== loadToken) {
                disposeObject(gltf.scene);
                return;
            }
            manifest = nextManifest;
            gateData = nextGates;
            nextReviews.forEach(function (entry, id) { reviews.set(id, entry); });
            model = gltf.scene;
            scene.add(model);
            model.traverse(function (node) {
                if (node.name.indexOf("feature__") === 0) roots.set(node.name.slice(9), node);
            });
            styleMap();
            var groundNode = model.getObjectByName("layer__campus-ground");
            var campusBox = groundNode ? new THREE.Box3().setFromObject(groundNode) : new THREE.Box3();
            roots.forEach(function (root, id) {
                var box = new THREE.Box3().setFromObject(root);
                bounds.set(id, box);
                campusBox.union(box);
            });
            var preSize = campusBox.getSize(new THREE.Vector3());
            campusSpan = Math.max(preSize.x, preSize.z, preSize.y, 100);
            createLabels();
            createGateMarkers();
            createPlaceMarkers();
            (gateData.landmarks || []).forEach(function (gate) {
                if (bounds.has(gate.id)) campusBox.union(bounds.get(gate.id));
            });
            measureLabels();
            campusPoints = manifest.referenceMap.campusBoundaryLocalEN.map(function (position) {
                return new THREE.Vector3(position[0], 0, -position[1]);
            });
            bounds.forEach(function (box) { campusPoints.push.apply(campusPoints, boxCorners(box)); });
            var size = campusBox.getSize(new THREE.Vector3());
            campusCenter = campusBox.getCenter(new THREE.Vector3());
            campusSpan = Math.max(size.x, size.z, size.y, 100);
            var farPlane = Math.max(12000, campusSpan * 10);
            perspective.far = farPlane;
            perspective.updateProjectionMatrix();
            overhead.far = farPlane;
            overhead.updateProjectionMatrix();
            var gridSpan = Math.max(4000, Math.ceil(campusSpan * 4 / 1000) * 1000);
            grid = new THREE.GridHelper(gridSpan, Math.round(gridSpan / 50), 0x739184, 0x739184);
            grid.position.set(campusCenter.x, -0.3, campusCenter.z);
            grid.material.transparent = true;
            grid.material.opacity = 0.2;
            grid.material.depthWrite = false;
            scene.add(grid);
            var lightScale = Math.max(1, campusSpan / 650);
            light.target.position.copy(campusCenter);
            light.position.copy(campusCenter).add(new THREE.Vector3(-470 * lightScale, 720 * lightScale, 355 * lightScale));
            var shadowSpan = campusSpan * 0.82;
            Object.assign(light.shadow.camera, {
                left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan,
                near: 1, far: Math.max(1900, campusSpan * 3.5)
            });
            light.shadow.camera.updateProjectionMatrix();
            renderer.shadowMap.needsUpdate = true;
            updateCategoryCountsAndGuide();
            setToolbarDisabled(false);
            fit(false);
            status.hidden = true;
            syncWater();
        } catch (error) {
            if (token !== loadToken) return;
            console.error("Campus map initialization failed", error);
            campusButtons.forEach(function (btn) { btn.disabled = false; });
            fail("加载" + config.title + "三维地图失败或浏览器不支持 WebGL，请刷新重试。");
        }
    }

    campusButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
            var nextId = btn.dataset.campus;
            if (!CAMPUSES[nextId] || (nextId === currentCampusId && model)) return;
            try {
                var url = new URL(window.location.href);
                if (nextId === "xingshu") url.searchParams.delete("campus");
                else url.searchParams.set("campus", nextId);
                window.history.replaceState(null, "", url.toString());
            } catch (e) { /* Ignore URL update errors */ }
            loadCampus(nextId);
        });
    });

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
            light = new THREE.DirectionalLight(0xfff0d4, 0.86);
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
            initSharedMaterials();
            observer = new ResizeObserver(resize); observer.observe(stage); resize();
            await loadCampus(currentCampusId);
        } catch (error) {
            console.error("Campus map initialization failed", error);
            fail();
        }
    }

    function clearSelection() {
        highlight(selectedId, false);
        selectedId = ""; searchInput.value = ""; detail.hidden = true; closeSearch();
        info.textContent = defaultSelectionSummary;
        applyBuildingMaterials();
        syncGuideSelection();
        draw();
    }
    document.getElementById("mapCloseDetail").addEventListener("click", clearSelection);

    function closeSearch() {
        searchOptions.hidden = true; activeSearchIndex = -1;
        searchInput.setAttribute("aria-expanded", "false"); searchInput.removeAttribute("aria-activedescendant");
        searchToggle.setAttribute("aria-expanded", "false");
    }

    function showSearch(query) {
        if (!model) return;
        query = (query || "").trim().toLowerCase();
        searchMatches = Array.from(featureById.values()).filter(function (feature) {
            var catLabel = (CATEGORY_LABELS[featureCategory(feature)] || "").toLowerCase();
            return feature.name.toLowerCase().indexOf(query) !== -1
                || feature.id.toLowerCase().indexOf(query) !== -1
                || catLabel.indexOf(query) !== -1;
        }).sort(function (a, b) {
            var aNamed = (a.verification === "named" || a.kind === "gate" || a.kind === "place") ? 0 : 1;
            var bNamed = (b.verification === "named" || b.kind === "gate" || b.kind === "place") ? 0 : 1;
            if (aNamed !== bNamed) return aNamed - bNamed;
            return a.name.localeCompare(b.name, "zh-CN");
        });
        searchOptions.replaceChildren(); activeSearchIndex = -1;
        searchInput.removeAttribute("aria-activedescendant");
        searchMatches.forEach(function (feature, index) {
            var option = document.createElement("button"); option.type = "button"; option.tabIndex = -1; option.id = "map-option-" + feature.id;
            option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(feature.id === selectedId));
            var nameSpan = document.createElement("span"); nameSpan.textContent = feature.name;
            var tagSpan = document.createElement("small"); tagSpan.textContent = CATEGORY_LABELS[featureCategory(feature)] || "";
            option.appendChild(nameSpan); option.appendChild(tagSpan);
            option.addEventListener("click", function () { chooseSearch(index); });
            searchOptions.appendChild(option);
        });
        if (!searchMatches.length) {
            var empty = document.createElement("p"); empty.textContent = "没有找到相关建筑、教学楼或重要地点"; searchOptions.appendChild(empty);
        }
        searchOptions.hidden = false; searchInput.setAttribute("aria-expanded", "true"); searchToggle.setAttribute("aria-expanded", "true");
    }

    function chooseSearch(index) {
        if (!searchMatches[index]) return;
        if (measuring) setMeasuring(false);
        setSelection(searchMatches[index].id); focusSelected();
    }

    searchInput.addEventListener("focus", function () { showSearch(searchInput.value); });
    searchInput.addEventListener("input", function () { showSearch(searchInput.value); });
    searchToggle.addEventListener("click", function () { if (searchOptions.hidden) { searchInput.focus(); showSearch(""); } else closeSearch(); });
    document.addEventListener("pointerdown", function (event) { if (!searchForm.contains(event.target)) closeSearch(); });
    searchForm.addEventListener("focusout", function (event) { if (!searchForm.contains(event.relatedTarget)) closeSearch(); });
    searchInput.addEventListener("keydown", function (event) {
        if (event.key === "Escape") { closeSearch(); return; }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault(); if (searchOptions.hidden) showSearch(searchInput.value); if (!searchMatches.length) return;
        activeSearchIndex = activeSearchIndex < 0 ? (event.key === "ArrowDown" ? 0 : searchMatches.length - 1) : (activeSearchIndex + (event.key === "ArrowDown" ? 1 : -1) + searchMatches.length) % searchMatches.length;
        Array.from(searchOptions.children).forEach(function (option, index) { option.classList.toggle("is-active", index === activeSearchIndex); });
        var active = searchOptions.children[activeSearchIndex]; searchInput.setAttribute("aria-activedescendant", active.id); active.scrollIntoView({ block: "nearest" });
    });
    searchForm.addEventListener("submit", function (event) {
        event.preventDefault(); if (!model) return;
        if (searchOptions.hidden) showSearch(searchInput.value);
        if (searchMatches.length) chooseSearch(activeSearchIndex < 0 ? 0 : activeSearchIndex);
    });

    function focusSelected() {
        var box = bounds.get(selectedId); if (!box) return;
        var target = box.getCenter(new THREE.Vector3());
        atOverview = false;
        moveCamera(target, Math.max(125, fittedRadius(boxCorners(box), target, 0.49, 0.45)), true);
    }

    if (detailMeasureButton) {
        detailMeasureButton.addEventListener("click", function () {
            var box = bounds.get(selectedId);
            if (!box) return;
            var startPoint = box.getCenter(new THREE.Vector3());
            startPoint.y = 0;
            setMeasuring(true);
            markDistance(startPoint);
        });
    }

    perspectiveButton.addEventListener("click", function () {
        setMeasuring(false);
        fit(false);
    });
    topButton.addEventListener("click", function () { fit(true); });
    if (resetButton) resetButton.addEventListener("click", function () { if (model) fit(topView); });
    document.getElementById("mapDetailFocus").addEventListener("click", focusSelected);
    document.getElementById("mapNorth").addEventListener("click", function () { if (model) fit(true); });
    document.getElementById("mapZoomIn").addEventListener("click", function () { if (model) zoom(0.8, true); });
    document.getElementById("mapZoomOut").addEventListener("click", function () { if (model) zoom(1.25, true); });
    document.querySelectorAll(".map-pan [data-pan]").forEach(function (button) {
        button.addEventListener("click", function () {
            if (!model) return;
            // Move the viewing position in the arrow direction, opposite to dragging.
            var step = Math.max(24, Math.min(stage.clientWidth, stage.clientHeight) * 0.12);
            var direction = button.dataset.pan;
            pan(direction === "left" ? step : direction === "right" ? -step : 0,
                direction === "up" ? step : direction === "down" ? -step : 0);
        });
    });

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
        panGesture = event.button === 2 || event.shiftKey;
        renderer.domElement.focus({ preventScroll: true });
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
            pan((event.clientX - previous.x) / 2, (event.clientY - previous.y) / 2);
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
        if (node) {
            var id = node.name.slice(9);
            var feature = featureById.get(id);
            if (feature && feature.parts) {
                var point = hits[0].point;
                var nearest = feature.parts.slice().sort(function (a, b) {
                    return Math.hypot(point.x - a.centerLocalEN[0], point.z + a.centerLocalEN[1])
                        - Math.hypot(point.x - b.centerLocalEN[0], point.z + b.centerLocalEN[1]);
                })[0];
                id += "-" + nearest.suffix;
            }
            setSelection(id);
        }
    });
    stage.addEventListener("pointercancel", function (event) { pointers.delete(event.pointerId); moved = true; });
    stage.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    stage.addEventListener("keydown", function (event) {
        if (!model || event.target !== renderer.domElement) return;
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
        sharedMaterials.forEach(function (material) { material.dispose(); });
        if (outlineMaterial) outlineMaterial.dispose();
        if (selectionMaterial) selectionMaterial.dispose();
        if (renderer) renderer.dispose();
    });
    init();
}());
