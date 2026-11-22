/* Deterministic screen-space label placement; independent of WebGL and the DOM. */
(function (root) {
    "use strict";
    function intersects(a, b) {
        return a.x < b.x + b.w + 4 && a.x + a.w + 4 > b.x && a.y < b.y + b.h + 4 && a.y + a.h + 4 > b.y;
    }
    function place(items, width, height, mode, reserved) {
        if (mode === "off") return [];
        var occupied = (reserved || []).slice(), placed = [];
        items.slice().sort(function (a, b) { return (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id); }).forEach(function (item) {
            if (item.x < 0 || item.x > width || item.y < 0 || item.y > height) return;
            var offsets = [[0, 0], [0, -30], [0, 32], [0, -60], [0, 62], [-26, 0], [26, 0], [0, -88], [0, 90]];
            var best = null, available = null;
            offsets.some(function (offset) {
                var x = Math.max(5, Math.min(width - item.w - 5, item.x - item.w / 2 + offset[0]));
                var rect = { x: x, y: item.y - item.h - 7 + offset[1], w: item.w, h: item.h };
                if (rect.x < 5 || rect.x + rect.w > width - 5 || rect.y < 5 || rect.y + rect.h > height - 5) return false;
                if ((reserved || []).some(function (other) { return intersects(rect, other); })) return false;
                if (!available) available = rect;
                if (occupied.some(function (other) { return intersects(rect, other); })) return false;
                best = rect; return true;
            });
            if (!best && (mode === "all" || item.alwaysShow)) best = available;
            if (!best) return;
            occupied.push(best);
            placed.push({ id: item.id, x: best.x, y: best.y, w: best.w, h: best.h, anchorX: item.x, anchorY: item.y });
        });
        return placed;
    }
    function scaleDistance(maxDistance) {
        if (!Number.isFinite(maxDistance) || maxDistance <= 0) return 0;
        var power = Math.pow(10, Math.floor(Math.log10(maxDistance)));
        return [5, 2, 1].map(function (step) { return step * power; }).find(function (step) {
            return step <= maxDistance * (1 + Number.EPSILON);
        }) || power;
    }
    function planDistance(a, b) {
        return Math.hypot(b.x - a.x, b.z - a.z);
    }
    var api = { place: place, scaleDistance: scaleDistance, planDistance: planDistance };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.CampusMapLabels = api;
}(typeof window === "undefined" ? this : window));
