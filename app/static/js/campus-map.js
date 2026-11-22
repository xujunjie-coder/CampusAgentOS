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
    var labels = new Map(), reviews = new Map(), featureById = new Map(), selectedId = "", panGesture = false;
    var renderer, observer, model, helper, manifest, scene, camera, gateData;
    var roots = new Map(), meshes = [], pointers = new Map();
    var center, campusCenter, campusSpan, radius, theta = Math.PI / 4, phi = 0.75;
    var raycaster, moved = false, down, pinchDistance = 0, destroyed = false;
    function fail() {
        status.hidden = false;
        status.textContent = "地图加载失败或浏览器不支持 WebGL，请刷新重试，也可使用页面下方的 SCSWiki 原文链接。";
    }
    function draw() {
        if (!renderer || !model || destroyed) return;
        camera.position.set(center.x + radius * Math.sin(phi) * Math.sin(theta),
            center.y + radius * Math.cos(phi), center.z + radius * Math.sin(phi) * Math.cos(theta));
        camera.lookAt(center);
        renderer.render(scene, camera);
        updateLabels();
        document.getElementById("mapCompass").style.transform = "rotate(" + (-theta * 180 / Math.PI) + "deg)";
    }
    function resize() {
        if (!renderer || destroyed) return;
        var width = stage.clientWidth, height = stage.clientHeight;
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        draw();
    }
    function fit(top) {
        center.copy(campusCenter);
        // Fit both portrait and landscape viewports, including the diagonal view.
        radius = campusSpan * 0.53 / Math.tan(camera.fov * Math.PI / 360) / Math.min(1, camera.aspect);
        phi = top ? 0.001 : 0.95;
        theta = top ? 0 : Math.PI / 4;
        draw();
    }
    function setSelection(id) {
        var root = roots.get(id);
        if (!root) return;
        selectedId = id;
        var feature = featureById.get(id);
        searchInput.value = feature.name;
        closeSearch();
        info.textContent = feature.name + " · 名称与模型待核验";
        detail.hidden = false;
        document.getElementById("mapDetailName").textContent = feature.name;
        document.getElementById("mapDetailIcon").className = "fas " + buildingIcon(feature.name);
        document.getElementById("mapDetailId").textContent = id;
        var review = reviews.get(id);
        var conflict = review && review.modelName && review.modelName !== feature.name;
        document.getElementById("mapDetailNote").textContent = feature.kind === "gate" ? feature.note : conflict
            ? "清单名称与模型内部记录（" + review.modelName + "）存在差异，对应关系需现场校对。轮廓与高度不是实测成果。"
            : "建筑名称与位置来自学生整理，轮廓和高度为估算。当前实景与楼层尚未独立核验。";
        if (helper) { scene.remove(helper); helper.geometry.dispose(); helper.material.dispose(); }
        helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(root), 0xa24736);
        scene.add(helper);
        draw();
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
            var root = roots.get(feature.id); if (!root) return;
            var box = new THREE.Box3().setFromObject(root), anchor = box.getCenter(new THREE.Vector3());
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
            labels.set(feature.id, { button: button, anchor: anchor, line: line, feature: feature, w: button.offsetWidth, h: button.offsetHeight });
    }
    function createGateMarkers() {
        (gateData.landmarks || []).forEach(function (gate) {
            var root = new THREE.Group(); root.name = "feature__" + gate.id;
            root.position.set(gate.positionLocal[0], 1, gate.positionLocal[2]);
            var color = gate.id === "gate-west" ? 0x216fb5 : 0x168575;
            var ring = new THREE.Mesh(new THREE.RingGeometry(6, 9, 32), new THREE.MeshBasicMaterial({color:color, side:THREE.DoubleSide}));
            ring.rotation.x=-Math.PI/2; root.add(ring);
            var post = new THREE.Mesh(new THREE.CylinderGeometry(0.8,0.8,12,8), new THREE.MeshBasicMaterial({color:color}));
            post.position.y=6;root.add(post);
            var pin = new THREE.Mesh(new THREE.SphereGeometry(3.2,12,8), new THREE.MeshBasicMaterial({color:color}));
            pin.position.y=13;root.add(pin);
            scene.add(root); roots.set(gate.id,root);
            root.traverse(function(node){if(node.isMesh) meshes.push(node);});
            var feature={id:gate.id,name:gate.name,kind:"gate",verification:"named",note:gate.note};
            addLabel(feature, new THREE.Vector3(root.position.x,18,root.position.z));
        });
    }
    function updateLabels() {
        if (!labels.size) return;
        var topView = window.CampusMapLabels.isTopView(phi);
        var width = stage.clientWidth, height = stage.clientHeight, items = [], reserved = [{x:10,y:10,w:220,h:40}, {x:width-70,y:height-210,w:65,h:210}];
        if (!detail.hidden) reserved.push({x:12,y:height-detail.offsetHeight-24,w:detail.offsetWidth+12,h:detail.offsetHeight+24});
        labels.forEach(function (label, id) {
            label.button.classList.toggle("is-selected", id === selectedId);
            label.button.hidden = true; label.line.style.display = "none";
            if (!topView && label.feature.kind !== "gate") return;
            var projected = label.anchor.clone().project(camera);
            if (projected.z < -1 || projected.z > 1) return;
            items.push({id:id,x:(projected.x+1)*width/2,y:(1-projected.y)*height/2,w:label.w,h:label.h,
                alwaysShow:label.feature.kind==="gate",
                priority:label.feature.kind==="gate"?2000:id===selectedId?1000:label.feature.verification==="named"?100:0});
        });
        var placements = window.CampusMapLabels.place(items, width, height, "smart", reserved);
        placements.forEach(function (placement) {
            var label = labels.get(placement.id);
            label.button.hidden = false;
            label.button.style.transform = "translate(" + placement.x.toFixed(1) + "px," + placement.y.toFixed(1) + "px)";
            var lineX = placement.x + placement.w / 2, lineY = placement.y + placement.h;
            if (Math.hypot(lineX-placement.anchorX,lineY-placement.anchorY)>16) {
                label.line.setAttribute("x1",lineX); label.line.setAttribute("y1",lineY);
                label.line.setAttribute("x2",placement.anchorX); label.line.setAttribute("y2",placement.anchorY);
                label.line.style.display = "";
            }
        });
        document.getElementById("mapCount").textContent = !topView ? "倾斜视角 · 校门名称常显" : placements.length + " / " + labels.size + " 个名称";
    }
    function styleMap() {
        var palette = {"campus-ground":0xc7e5a3,grass:0xa9d77f,sports:0xb8d6a3,water:0x89d0e3,
            "internal-roads":0xfffefa,footpaths:0xf6f4ec,"external-roads":0xffffff};
        manifest.semanticLayers.forEach(function (layer) {
            var node = model.getObjectByName(layer.nodeName); if (!node) return;
            node.traverse(function (mesh) {
                if (!mesh.isMesh) return;
                mesh.material.dispose();
                mesh.material = new THREE.MeshStandardMaterial({color:new THREE.Color(palette[layer.id] || 0xdfe8d5).convertSRGBToLinear(),roughness:1,metalness:0,side:THREE.DoubleSide});
                mesh.receiveShadow = true;
                if (/roads|footpaths/.test(layer.id)) {
                    var edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry,30),new THREE.LineBasicMaterial({color:0xcbd0c8,transparent:true,opacity:0.55}));
                    mesh.add(edge);
                }
            });
        });
        var backdrop = model.getObjectByName("S14_Xuan_Paper_Backdrop");
        if (backdrop) backdrop.traverse(function (mesh) { if (mesh.isMesh) {mesh.material.dispose();mesh.material=new THREE.MeshBasicMaterial({color:new THREE.Color(0xf5f6f1).convertSRGBToLinear(),toneMapped:false});} });
        roots.forEach(function (root) {
            root.traverse(function (mesh) {
                if (!mesh.isMesh) return;
                var geometry = mesh.geometry, normal = geometry.getAttribute("normal"), index = geometry.index;
                geometry.clearGroups();
                var count = index ? index.count : geometry.getAttribute("position").count, groupStart=0, last=-1;
                for (var i=0;i<count;i+=3) {
                    var ny=0;
                    for (var j=0;j<3;j++) ny += normal ? normal.getY(index ? index.getX(i+j) : i+j) : 0;
                    var materialIndex=ny>1.8?1:0;
                    if (last!==materialIndex && last!==-1) {geometry.addGroup(groupStart,i-groupStart,last);groupStart=i;}
                    last=materialIndex;
                }
                geometry.addGroup(groupStart,count-groupStart,last);
                mesh.material.dispose();
                mesh.material=[new THREE.MeshStandardMaterial({color:new THREE.Color(0xdad6cc).convertSRGBToLinear(),roughness:1,metalness:0}),
                    new THREE.MeshStandardMaterial({color:new THREE.Color(0xfff8ed).convertSRGBToLinear(),roughness:1,metalness:0})];
                mesh.castShadow=true;mesh.receiveShadow=true;
            });
        });
    }
    function pan(dx, dy) {
        var scale = 2 * radius * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, stage.clientHeight);
        var right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        var up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1); up.y = 0; up.normalize();
        center.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale); draw();
    }
    function zoom(factor) {
        radius = Math.max(20, Math.min(campusSpan * 12, radius * factor));
        draw();
    }
    function distance() {
        var values = Array.from(pointers.values());
        return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
    }
    async function init() {
        try {
            if (!window.THREE || !THREE.GLTFLoader) throw new Error("Missing renderer");
            renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.outputEncoding = THREE.sRGBEncoding;
            renderer.toneMapping = THREE.NoToneMapping;
            renderer.toneMappingExposure = 1.06;
            renderer.setClearColor(0xf5f6f1);
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            renderer.domElement.tabIndex = 0;
            renderer.domElement.setAttribute("aria-label", "三维校园地图：方向键旋转，加减键缩放，数字0重置；也可通过上方选择器选择建筑");
            stage.appendChild(renderer.domElement);
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(45, 1, 1, 12000);
            scene.add(new THREE.HemisphereLight(0xffffff, 0xc5c9b9, 0.75));
            var light = new THREE.DirectionalLight(0xfffaf1, 0.65);
            light.position.set(-400, 800, 300); light.castShadow=true;
            light.shadow.mapSize.set(stage.clientWidth < 600 ? 1024 : 2048, stage.clientWidth < 600 ? 1024 : 2048);
            light.shadow.bias=-0.00015; light.shadow.normalBias=0.3;
            scene.add(light); scene.add(light.target);
            center = new THREE.Vector3(); raycaster = new THREE.Raycaster();
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
                if (node.isMesh) meshes.push(node);
            });
            styleMap();
            var box = new THREE.Box3();
            // Frame the campus buildings, excluding the large paper backdrop and peripheral roads.
            roots.forEach(function (root) {
                box.expandByObject(root);
                root.traverse(function (node) {
                    if (!node.isMesh) return;
                    var outline = new THREE.LineSegments(new THREE.EdgesGeometry(node.geometry, 34),
                        new THREE.LineBasicMaterial({ color: 0xaaa99e, transparent: true, opacity: 0.38, depthWrite: false }));
                    outline.renderOrder = 30;
                    node.add(outline);
                });
            });
            var size = box.getSize(new THREE.Vector3());
            campusCenter = box.getCenter(new THREE.Vector3());
            campusSpan = Math.max(size.x, size.z, size.y);
            light.target.position.copy(campusCenter);
            light.shadow.camera.left=-campusSpan;light.shadow.camera.right=campusSpan;
            light.shadow.camera.top=campusSpan;light.shadow.camera.bottom=-campusSpan;
            light.shadow.camera.near=1;light.shadow.camera.far=2500;light.shadow.camera.updateProjectionMatrix();
            createLabels();
            createGateMarkers();
            searchInput.disabled = false;
            searchToggle.disabled = false;
            document.getElementById("mapTop").disabled = false;
            status.hidden = true; fit(false);
        } catch (error) { fail(); }
    }
    function clearSelection() {
        selectedId=""; searchInput.value=""; detail.hidden=true; closeSearch();
        info.textContent="点击建筑或名称，了解对应位置";
        if (helper) {scene.remove(helper);helper.geometry.dispose();helper.material.dispose();helper=null;}
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
        var root = roots.get(selectedId); if (!root) return;
        var box = new THREE.Box3().setFromObject(root);
        box.getCenter(center); radius = Math.max(90, box.getSize(new THREE.Vector3()).length() * 2.2) / Math.min(1,camera.aspect);
        phi = 0.95; draw();
    }
    document.getElementById("mapTop").addEventListener("click", function () { fit(true); });
    document.getElementById("mapDetailFocus").addEventListener("click", focusSelected);
    document.getElementById("mapNorth").addEventListener("click", function () { if(model) fit(true); });
    document.getElementById("mapZoomIn").addEventListener("click", function () { if(model) zoom(0.8); });
    document.getElementById("mapZoomOut").addEventListener("click", function () { if(model) zoom(1.25); });
    var fullscreen = document.getElementById("mapFullscreen");
    fullscreen.hidden = !shell.requestFullscreen;
    fullscreen.addEventListener("click", async function () {
        try { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.requestFullscreen(); }
        catch (error) { info.textContent = "浏览器暂时无法进入全屏，请使用窗口查看。"; }
    });
    document.addEventListener("fullscreenchange", function () { fullscreen.textContent = document.fullscreenElement ? "退出全屏" : "全屏查看"; });
    stage.addEventListener("wheel", function (event) {
        if (!model || event.target.closest(".map-building-detail")) return; event.preventDefault(); zoom(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.0015));
    }, { passive: false });
    stage.addEventListener("pointerdown", function (event) {
        if (!model || event.target.closest("button, .map-building-detail")) return;
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
            if(panGesture) {pan(event.clientX-previous.x,event.clientY-previous.y);return;}
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
        var hits = raycaster.intersectObjects(meshes, false);
        if (!hits.length) return;
        var node = hits[0].object;
        while (node && node.name.indexOf("feature__") !== 0) node = node.parent;
        if (node) setSelection(node.name.slice(9));
    });
    stage.addEventListener("pointercancel", function (event) { pointers.delete(event.pointerId); moved = true; });
    stage.addEventListener("contextmenu", function(event){event.preventDefault();});
    stage.addEventListener("keydown", function (event) {
        if (!model || event.target!==renderer.domElement) return;
        if (event.key === "ArrowLeft") theta += 0.1;
        else if (event.key === "ArrowRight") theta -= 0.1;
        else if (event.key === "ArrowUp") phi = Math.max(0.001, phi - 0.1);
        else if (event.key === "ArrowDown") phi = Math.min(1.48, phi + 0.1);
        else if (event.key === "+" || event.key === "=") zoom(0.9);
        else if (event.key === "-") zoom(1.1);
        else if (event.key === "0") fit(false);
        else return;
        event.preventDefault(); draw();
    });
    window.addEventListener("pagehide", function (event) {
        if (event.persisted) return;
        destroyed = true;
        if (observer) observer.disconnect();
        if (scene) scene.traverse(function (node) {
            if (node.geometry) node.geometry.dispose();
            if (node.material) (Array.isArray(node.material) ? node.material : [node.material]).forEach(function (material) { material.dispose(); });
        });
        if (renderer) renderer.dispose();
    });
    init();
}());
