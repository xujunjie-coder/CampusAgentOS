/* Deterministic screen-space label placement; independent of WebGL and the DOM. */
(function (root) {
    "use strict";
    function intersects(a, b) {
        return a.x < b.x + b.w + 4 && a.x + a.w + 4 > b.x && a.y < b.y + b.h + 4 && a.y + a.h + 4 > b.y;
    }
    function isTopView(polarAngle) {
        // Allow only the numerical epsilon used by the top-view camera.
        return Number.isFinite(polarAngle) && polarAngle >= 0 && polarAngle <= 0.01;
    }
    function place(items, width, height, mode, reserved) {
        if (mode === "off") return [];
        var occupied = (reserved || []).slice(), placed = [];
        items.slice().sort(function (a, b) { return (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id); }).forEach(function (item) {
            var offsets = mode === "all" ? [0, -30, 30, -60, 60, -90, 90] : [0, -32, 32, -64, 64];
            var best = null;
            offsets.some(function (dy) {
                var rect = { x: item.x - item.w / 2, y: item.y - item.h - 7 + dy, w: item.w, h: item.h };
                if (rect.x < 5 || rect.x + rect.w > width - 5 || rect.y < 5 || rect.y + rect.h > height - 5) return false;
                if (!best) best = rect;
                if (occupied.some(function (other) { return intersects(rect, other); })) return false;
                best = rect; return true;
            });
            if (!best) return;
            if (mode !== "all" && !item.alwaysShow && occupied.some(function (other) { return intersects(best, other); })) return;
            occupied.push(best);
            placed.push({ id: item.id, x: best.x, y: best.y, w: best.w, h: best.h, anchorX: item.x, anchorY: item.y });
        });
        return placed;
    }
    var api = { place: place, isTopView: isTopView };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.CampusMapLabels = api;
}(typeof window === "undefined" ? this : window));
