(function () {
    "use strict";

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function stalledError(message) {
        var err = new Error(message);
        err.cameraStalled = true;
        return err;
    }

    function hasLiveVideoTrack(stream) {
        if (!stream || typeof stream.getVideoTracks !== "function") {
            return false;
        }
        var tracks = stream.getVideoTracks();
        return tracks.length > 0 && tracks.every(function (track) {
            return track.readyState === "live" && track.enabled !== false;
        });
    }

    async function ensureVideoPlaying(video, stream) {
        if (!stream || video.srcObject !== stream) {
            throw stalledError("摄像头画面不可用，请重新打开摄像头。");
        }
        if (!hasLiveVideoTrack(stream)) {
            throw stalledError("摄像头连接已中断，正在重新打开…");
        }
        if (video.paused || video.ended) {
            try {
                await video.play();
            } catch (e) {
                throw stalledError("摄像头画面已暂停，正在重新打开…");
            }
        }
        var deadline = Date.now() + 1500;
        while ((video.readyState < 2 || !video.videoWidth || !video.videoHeight) && Date.now() < deadline) {
            await sleep(60);
            if (!stream || video.srcObject !== stream) {
                throw new Error("摄像头已关闭。");
            }
        }
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
            throw stalledError("摄像头画面未就绪，正在重新打开…");
        }
    }

    function waitNextVideoFrame(video, previousTime, timeoutMs) {
        return new Promise(function (resolve) {
            var settled = false;
            var timer = null;
            var poll = null;
            var callbackId = null;

            function finish(advanced) {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (poll) clearInterval(poll);
                if (callbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
                    try { video.cancelVideoFrameCallback(callbackId); } catch (e) {}
                }
                resolve(advanced);
            }

            if (previousTime !== null && video.currentTime !== previousTime) {
                finish(true);
                return;
            }

            if (typeof video.requestVideoFrameCallback === "function") {
                callbackId = video.requestVideoFrameCallback(function () {
                    finish(true);
                });
            }

            poll = setInterval(function () {
                if (previousTime !== null && video.currentTime !== previousTime) {
                    finish(true);
                }
            }, 50);

            timer = setTimeout(function () {
                finish(previousTime !== null && video.currentTime !== previousTime);
            }, timeoutMs);
        });
    }

    function grabJpegFrame(video, canvas, context) {
        var scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.9);
    }

    window.captureFaceFrames = async function (video) {
        var frames = [];
        var stream = video && video.srcObject;
        await ensureVideoPlaying(video, stream);

        var canvas = document.createElement("canvas");
        var context = canvas.getContext("2d");
        var lastTime = null;

        for (var index = 0; index < 3; index++) {
            if (index > 0) {
                await sleep(160);
                await ensureVideoPlaying(video, stream);
                var advanced = await waitNextVideoFrame(video, lastTime, 1200);
                if (!advanced) {
                    throw stalledError("摄像头画面卡住未刷新，正在自动重连…");
                }
            }

            var shot = grabJpegFrame(video, canvas, context);
            var retries = 0;
            while (frames.indexOf(shot) !== -1 && retries < 4) {
                retries++;
                if (video.paused) {
                    try { await video.play(); } catch (e) {}
                }
                var gotNew = await waitNextVideoFrame(video, video.currentTime, 450);
                if (!gotNew) {
                    await sleep(180);
                }
                await ensureVideoPlaying(video, stream);
                shot = grabJpegFrame(video, canvas, context);
            }

            if (frames.indexOf(shot) !== -1) {
                throw stalledError("摄像头画面卡住未刷新，正在自动重连…");
            }

            lastTime = video.currentTime;
            frames.push(shot);
        }
        return frames;
    };
})();
