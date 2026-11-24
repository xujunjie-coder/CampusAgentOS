/* 本地 Cubism 4 看板娘。Haru 的挥手使用原版举臂画层和手腕关键帧。 */
(function () {
    "use strict";

    function createCampusLive2DAvatar(stage, options) {
        var modelUrl = options.modelUrl;
        var app, model, canvas;
        var loading = false;
        var visible = false;
        var destroyed = false;
        var voiceActive = false;
        var mouth = 0;
        var voiceTime = 0;
        var nodTime = 0;
        var nodding = false;
        var expression = -1;
        var expressions = [];

        function layout() {
            if (!model) return;
            var width = Math.max(1, stage.clientWidth);
            var height = Math.max(1, stage.clientHeight);
            app.renderer.resize(width, height);
            model.scale.set(1);
            model.anchor.set(0.5, 0);
            model.scale.set(Math.min(height * 1.77 / model.height, width * 0.90 / model.width));
            model.position.set(width * 0.50, height * 0.024);
        }

        function update() {
            if (!visible || !model) return;
            var ms = Math.min(50, app.ticker.deltaMS);
            var dt = ms / 1000;
            if (voiceActive) voiceTime += dt * 13;
            if (nodding) {
                nodTime += dt;
                if (nodTime >= 1.25) nodding = false;
            }
            var target = voiceActive ? 0.20 + 0.65 * Math.abs(Math.sin(voiceTime)) : 0;
            mouth += (target - mouth) * Math.min(1, dt * 19);
            model.update(ms);
        }

        function load(done) {
            if (model) { done(true); return; }
            if (loading || destroyed) return;
            if (!window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
                done(false, "Live2D 运行时未加载");
                return;
            }
            loading = true;
            Promise.resolve().then(function () {
                canvas = document.createElement("canvas");
                canvas.className = "avatar-live2d-canvas";
                canvas.hidden = !visible;
                stage.appendChild(canvas);
                app = new PIXI.Application({
                    view: canvas, autoStart: false, backgroundAlpha: 0, antialias: true,
                    autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2)
                });
                app.ticker.add(update, undefined, PIXI.UPDATE_PRIORITY.NORMAL);
                return PIXI.live2d.Live2DModel.from(modelUrl, {
                    autoInteract: false, autoUpdate: false, motionPreload: "ALL"
                });
            }).then(function (loaded) {
                if (destroyed) { loaded.destroy(); return; }
                loading = false;
                model = loaded;
                expressions = model.internalModel.settings.expressions.map(function (item) { return item.Name; });
                var internal = model.internalModel;
                var core = internal.coreModel;
                // 写入在动作、眼神与物理计算之后，仅在播报时覆盖嘴部通道。
                internal.on("beforeModelUpdate", function () {
                    if (voiceActive || mouth > 0.005) core.setParameterValueById("ParamMouthOpenY", mouth);
                    if (nodding) {
                        var p = nodTime / 1.25;
                        var tilt = -10 * (1 - Math.cos(p * 4 * Math.PI)) * Math.sin(p * Math.PI);
                        core.addParameterValueById("ParamAngleY", tilt);
                    }
                });
                app.stage.addChild(model);
                layout();
                setVisible(visible);
                done(true);
            }).catch(function (error) {
                loading = false;
                if (!destroyed) done(false, String(error));
            });
        }

        function setVisible(show) {
            visible = !!show;
            if (canvas) canvas.hidden = !visible;
            if (!app || !model) return;
            if (visible) {
                layout();
                app.start();
            } else {
                app.stop();
            }
        }

        function focus(clientX, clientY) {
            if (!visible || !model) return;
            var rect = canvas.getBoundingClientRect();
            model.focus(clientX - rect.left, clientY - rect.top);
        }

        function onTap(clientX, clientY) {
            if (!visible || !model) return;
            var rect = canvas.getBoundingClientRect();
            var areas = model.hitTest(clientX - rect.left, clientY - rect.top);
            if (areas.includes("Head")) triggerGesture("nod");
            else if (areas.includes("Body")) triggerGesture("wave");
        }

        function triggerGesture(kind) {
            if (!model) return;
            var manager = model.internalModel.motionManager;
            if (kind === "wave" || kind === "celebrate") {
                nodding = false;
                model.motion("Wave", 0, PIXI.live2d.MotionPriority.FORCE);
            } else if (kind === "nod") {
                nodTime = 0;
                nodding = true;
            } else if (kind === "book" || kind === "expr") {
                if (!expressions.length) return;
                expression = (expression + 1) % expressions.length;
                model.expression(expressions[expression]);
            } else if (kind === "reset") {
                nodding = false;
                expression = -1;
                manager.stopAllMotions();
                if (manager.expressionManager) manager.expressionManager.resetExpression();
                var rect = canvas.getBoundingClientRect();
                model.focus(rect.width * 0.5, rect.height * 0.45, true);
            }
        }

        return {
            load: load,
            setVisible: setVisible,
            focus: focus,
            onTap: onTap,
            triggerGesture: triggerGesture,
            setVoice: function (active) { voiceActive = !!active; },
            resize: function () { if (visible) layout(); },
            isReady: function () { return !!model; },
            destroy: function () {
                destroyed = true;
                if (app) app.destroy(true, { children: true, texture: true, baseTexture: true });
                app = canvas = model = null;
            }
        };
    }

    window.createCampusLive2DAvatar = createCampusLive2DAvatar;
})();

