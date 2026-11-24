#!/usr/bin/env node
/**
 * Build Huafeng Campus (西华师范大学华凤校区) 3D white-box GLB & metadata
 * from OpenStreetMap vector data (ODbL 1.0), matching the exact node/manifest
 * contract of app/static/maps/xingshu-campus/.
 *
 * Usage:
 *   node scripts/build_huafeng_campus_map.mjs <path-to-osm-json>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[2];
if (!inputPath || !fs.existsSync(inputPath)) {
  console.error("Usage: node scripts/build_huafeng_campus_map.mjs <huafeng_osm.json>");
  process.exit(1);
}

const outDir = path.resolve("app/static/maps/huafeng-campus");
fs.mkdirSync(outDir, { recursive: true });

const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const elements = raw.elements || [];

const nodes = new Map();
const ways = new Map();
const relations = new Map();
for (const el of elements) {
  if (el.type === "node") nodes.set(el.id, el);
  else if (el.type === "way") ways.set(el.id, el);
  else if (el.type === "relation") relations.set(el.id, el);
}

// ---------------------------------------------------------------------------
// 1. Exact WGS84 -> UTM Zone 48N (EPSG:32648) Transverse Mercator projection
// ---------------------------------------------------------------------------
function wgs84ToUtm48N(lonDeg, latDeg) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const lon0 = 105.0 * Math.PI / 180; // UTM Zone 48 central meridian
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);

  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = ep2 * cosLat * cosLat;
  const A = cosLat * (lon - lon0);

  const M = a * (
    (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * lat
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * lat)
    + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * lat)
    - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * lat)
  );

  const easting = 500000 + k0 * N * (
    A
    + (1 - T + C) * Math.pow(A, 3) / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
  );
  const northing = k0 * (
    M + N * tanLat * (
      A * A / 2
      + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
    )
  );
  return [easting, northing];
}

// ---------------------------------------------------------------------------
// 2. Geometry utilities: ring stitching, polygon cleaning, hole bridging & earcut
// ---------------------------------------------------------------------------
function getWayLonLat(wayId) {
  const w = ways.get(wayId);
  if (!w || !w.nodes) return [];
  return w.nodes.map(id => nodes.get(id)).filter(Boolean).map(n => [n.lon, n.lat]);
}

function stitchRings(wayIds) {
  const chains = wayIds.map(id => getWayLonLat(id)).filter(c => c.length >= 2);
  const rings = [];
  while (chains.length) {
    const ring = [...chains.shift()];
    let changed = true;
    while (chains.length && changed) {
      changed = false;
      const last = ring[ring.length - 1];
      for (let i = 0; i < chains.length; i++) {
        const c = chains[i];
        if (c[0][0] === last[0] && c[0][1] === last[1]) {
          ring.push(...c.slice(1));
          chains.splice(i, 1);
          changed = true;
          break;
        }
        if (c[c.length - 1][0] === last[0] && c[c.length - 1][1] === last[1]) {
          ring.push(...c.reverse().slice(1));
          chains.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    rings.push(ring);
  }
  return rings;
}

function signedArea2D(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function cleanRing(pts) {
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-4) {
      out.push([p[0], p[1]]);
    }
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-4) {
    out.pop();
  }
  return out;
}

function ensureCCW(ring) {
  const r = cleanRing(ring);
  return signedArea2D(r) < 0 ? r.reverse() : r;
}

function ensureCW(ring) {
  const r = cleanRing(ring);
  return signedArea2D(r) > 0 ? r.reverse() : r;
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInTri(p, a, b, c) {
  const cross = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  const d1 = cross(p, a, b), d2 = cross(p, b, c), d3 = cross(p, c, a);
  const hasNeg = (d1 < -1e-9) || (d2 < -1e-9) || (d3 < -1e-9);
  const hasPos = (d1 > 1e-9) || (d2 > 1e-9) || (d3 > 1e-9);
  return !(hasNeg && hasPos);
}

// Bridge holes into outer CCW ring using standard rightmost-vertex ray method
function mergeHoles(outerCCW, holesCW) {
  let poly = outerCCW.map(p => [p[0], p[1]]);
  // Sort holes by rightmost X descending
  const sortedHoles = holesCW
    .filter(h => h.length >= 3)
    .map(h => {
      let maxIdx = 0;
      for (let i = 1; i < h.length; i++) if (h[i][0] > h[maxIdx][0]) maxIdx = i;
      return { ring: h, maxIdx, maxX: h[maxIdx][0] };
    })
    .sort((a, b) => b.maxX - a.maxX);

  for (const { ring: hole, maxIdx } of sortedHoles) {
    const M = hole[maxIdx];
    // Find nearest intersection of +X ray from M with polygon edges, or fallback to nearest visible vertex
    let bestT = Infinity;
    let bridgeIdx = -1;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] > M[1]) !== (b[1] > M[1])) {
        const xInt = a[0] + (M[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
        if (xInt >= M[0] - 1e-7 && xInt - M[0] < bestT) {
          bestT = xInt - M[0];
          bridgeIdx = a[0] >= b[0] ? i : (i + 1) % poly.length;
        }
      }
    }
    if (bridgeIdx === -1) {
      let bestDist = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const d = Math.hypot(poly[i][0] - M[0], poly[i][1] - M[1]);
        if (d < bestDist) { bestDist = d; bridgeIdx = i; }
      }
    }
    // Check if any reflex vertex lies inside triangle (M, intersection, poly[bridgeIdx])
    const P = poly[bridgeIdx];
    const I = [M[0] + (Number.isFinite(bestT) ? bestT : 0), M[1]];
    if (Number.isFinite(bestT)) {
      let bestAngle = Infinity;
      let candidate = bridgeIdx;
      for (let i = 0; i < poly.length; i++) {
        if (i === bridgeIdx) continue;
        const v = poly[i];
        if (v[0] >= M[0] && pointInTri(v, M, I, P)) {
          const angle = Math.abs(Math.atan2(v[1] - M[1], v[0] - M[0]));
          if (angle < bestAngle) { bestAngle = angle; candidate = i; }
        }
      }
      bridgeIdx = candidate;
    }

    // Splice hole into poly at bridgeIdx
    const rotatedHole = [];
    for (let k = 0; k < hole.length; k++) rotatedHole.push(hole[(maxIdx + k) % hole.length]);
    rotatedHole.push(hole[maxIdx]); // close back to M
    poly = [
      ...poly.slice(0, bridgeIdx + 1),
      ...rotatedHole,
      poly[bridgeIdx],
      ...poly.slice(bridgeIdx + 1),
    ];
  }
  return poly;
}

// Ear-clipping triangulation of a simple CCW polygon (returns array of [p0, p1, p2] triangles)
function triangulatePolygon(outerRing, holeRings = []) {
  const outer = ensureCCW(outerRing);
  if (outer.length < 3) return [];
  const holes = holeRings.map(ensureCW).filter(h => h.length >= 3);
  const pts = holes.length ? mergeHoles(outer, holes) : outer;

  const idx = pts.map((_, i) => i);
  const tris = [];
  let guard = pts.length * pts.length + 10;

  while (idx.length > 3 && guard-- > 0) {
    let earFound = false;
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      const ia = idx[(i - 1 + n) % n];
      const ib = idx[i];
      const ic = idx[(i + 1) % n];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 1e-8) continue; // reflex or collinear

      let contains = false;
      for (let j = 0; j < n; j++) {
        const ip = idx[j];
        if (ip === ia || ip === ib || ip === ic) continue;
        const p = pts[ip];
        if (
          (Math.abs(p[0] - a[0]) < 1e-7 && Math.abs(p[1] - a[1]) < 1e-7) ||
          (Math.abs(p[0] - b[0]) < 1e-7 && Math.abs(p[1] - b[1]) < 1e-7) ||
          (Math.abs(p[0] - c[0]) < 1e-7 && Math.abs(p[1] - c[1]) < 1e-7)
        ) continue;
        if (pointInTri(p, a, b, c)) { contains = true; break; }
      }
      if (!contains) {
        tris.push([a, b, c]);
        idx.splice(i, 1);
        earFound = true;
        break;
      }
    }
    if (!earFound) {
      // Degenerate / near-collinear vertex: remove smallest-angle corner to avoid infinite loop
      let bestI = 0, minArea = Infinity;
      const n2 = idx.length;
      for (let i = 0; i < n2; i++) {
        const a = pts[idx[(i - 1 + n2) % n2]], b = pts[idx[i]], c = pts[idx[(i + 1) % n2]];
        const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
        if (ar < minArea) { minArea = ar; bestI = i; }
      }
      const a = pts[idx[(bestI - 1 + n2) % n2]], b = pts[idx[bestI]], c = pts[idx[(bestI + 1) % n2]];
      if (minArea > 1e-7) tris.push([a, b, c]);
      idx.splice(bestI, 1);
    }
  }
  if (idx.length === 3) {
    const a = pts[idx[0]], b = pts[idx[1]], c = pts[idx[2]];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > 1e-7) tris.push(cross > 0 ? [a, b, c] : [a, c, b]);
  }
  return tris;
}

// ---------------------------------------------------------------------------
// 3. Mesh Builder (flat normals, right-handed glTF Y-up, Z-south)
// ---------------------------------------------------------------------------
class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.indices = [];
  }
  addTriangle(p0, p1, p2, normal) {
    const base = this.positions.length / 3;
    this.positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    this.normals.push(normal[0], normal[1], normal[2], normal[0], normal[1], normal[2], normal[0], normal[1], normal[2]);
    this.indices.push(base, base + 1, base + 2);
  }
  addFlatPolygon(outerEN, holesEN = [], y = 0) {
    const tris = triangulatePolygon(outerEN, holesEN);
    for (const [a, b, c] of tris) {
      this.addTriangle([a[0], y, -a[1]], [b[0], y, -b[1]], [c[0], y, -c[1]], [0, 1, 0]);
    }
  }
  addExtrudedBuilding(outerEN, holesEN = [], height = 12) {
    const outer = ensureCCW(outerEN);
    const holes = holesEN.map(ensureCW).filter(h => h.length >= 3);
    // Roof (normal = +Y)
    this.addFlatPolygon(outer, holes, height);
    // Walls (horizontal outward normals)
    const addRingWalls = (ring) => {
      for (let i = 0; i < ring.length; i++) {
        const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
        const de = p1[0] - p0[0], dn = p1[1] - p0[1];
        const len = Math.hypot(de, dn);
        if (len < 1e-4) continue;
        // Outward normal in 3D (x=east, y=up, z=-north): (dn, 0, de) / len
        const nx = dn / len, nz = de / len;
        const b0 = [p0[0], 0, -p0[1]];
        const b1 = [p1[0], 0, -p1[1]];
        const t1 = [p1[0], height, -p1[1]];
        const t0 = [p0[0], height, -p0[1]];
        this.addTriangle(b0, b1, t1, [nx, 0, nz]);
        this.addTriangle(b0, t1, t0, [nx, 0, nz]);
      }
    };
    addRingWalls(outer);
    for (const h of holes) addRingWalls(h);
  }
  addRibbon(ptsEN, width = 5, y = 0) {
    if (ptsEN.length < 2) return;
    const hw = width * 0.5;
    for (let i = 0; i < ptsEN.length - 1; i++) {
      const a = ptsEN[i], b = ptsEN[i + 1];
      const de = b[0] - a[0], dn = b[1] - a[1];
      const len = Math.hypot(de, dn);
      if (len < 0.05) continue;
      // Left normal in (east, north): (-dn, de) / len
      const lx = (-dn / len) * hw, ly = (de / len) * hw;
      const p0 = [a[0] - lx, y, -(a[1] - ly)];
      const p1 = [b[0] - lx, y, -(b[1] - ly)];
      const p2 = [b[0] + lx, y, -(b[1] + ly)];
      const p3 = [a[0] + lx, y, -(a[1] + ly)];
      // Verify CCW from +Y
      this.addTriangle(p0, p1, p2, [0, 1, 0]);
      this.addTriangle(p0, p2, p3, [0, 1, 0]);
    }
    // Add small octagonal caps at interior joints to avoid gaps on sharp corners
    for (let i = 1; i < ptsEN.length - 1; i++) {
      const c = ptsEN[i];
      const segs = 6;
      for (let k = 0; k < segs; k++) {
        const a0 = (k / segs) * Math.PI * 2;
        const a1 = ((k + 1) / segs) * Math.PI * 2;
        const p0 = [c[0], y, -c[1]];
        const p1 = [c[0] + Math.cos(a0) * hw, y, -(c[1] + Math.sin(a0) * hw)];
        const p2 = [c[0] + Math.cos(a1) * hw, y, -(c[1] + Math.sin(a1) * hw)];
        this.addTriangle(p0, p1, p2, [0, 1, 0]);
      }
    }
  }
  get triangleCount() { return this.indices.length / 3; }
}

// ---------------------------------------------------------------------------
// 4. Extract Huafeng Campus boundary & set local UTM origin
// ---------------------------------------------------------------------------
const uniRel = relations.get(19478636);
if (!uniRel) throw new Error("Relation 19478636 (西华师范大学华凤校区) not found in OSM JSON");

const outerWayIds = uniRel.members.filter(m => m.type === "way" && (m.role === "outer" || !m.role)).map(m => m.ref);
const campusRingsLonLat = stitchRings(outerWayIds);
const allBoundaryLonLat = campusRingsLonLat.flat();

const originLon = allBoundaryLonLat.reduce((s, p) => s + p[0], 0) / allBoundaryLonLat.length;
const originLat = allBoundaryLonLat.reduce((s, p) => s + p[1], 0) / allBoundaryLonLat.length;
const [originUtmE, originUtmN] = wgs84ToUtm48N(originLon, originLat);

const toLocalEN = ([lon, lat]) => {
  const [e, n] = wgs84ToUtm48N(lon, lat);
  return [e - originUtmE, n - originUtmN];
};

const campusRingsEN = campusRingsLonLat.map(r => ensureCCW(r.map(toLocalEN)));
const allBoundaryEN = campusRingsEN.flat();
const minE = Math.min(...allBoundaryEN.map(p => p[0]));
const maxE = Math.max(...allBoundaryEN.map(p => p[0]));
const minN = Math.min(...allBoundaryEN.map(p => p[1]));
const maxN = Math.max(...allBoundaryEN.map(p => p[1]));

const inCampusEN = (pt) => campusRingsEN.some(r => pointInRing(pt, r));
const centroidEN = (pts) => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
];

// Clip a polyline segment to the bounding box [clipMinE, clipMaxE] x [clipMinN, clipMaxN]
const CLIP_PAD = 130;
const clipBox = [minE - CLIP_PAD, minN - CLIP_PAD, maxE + CLIP_PAD, maxN + CLIP_PAD];
function clipPolyline(pts) {
  const [x0, y0, x1, y1] = clipBox;
  const segments = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const inside = p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    if (inside) {
      cur.push(p);
    } else {
      if (cur.length >= 2) segments.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) segments.push(cur);
  return segments;
}

// ---------------------------------------------------------------------------
// 5. Build semantic layers
// ---------------------------------------------------------------------------
const layers = {
  "campus-ground": { label: "校园地面", builder: new MeshBuilder(), sourceWayCount: 0 },
  "grass": { label: "绿地与林地", builder: new MeshBuilder(), sourceWayCount: 0 },
  "internal-roads": { label: "校内车行道路", builder: new MeshBuilder(), sourceWayCount: 0 },
  "footpaths": { label: "步行路与台阶", builder: new MeshBuilder(), sourceWayCount: 0 },
  "external-roads": { label: "校园外围道路", builder: new MeshBuilder(), sourceWayCount: 0 },
  "water": { label: "水体与泳池", builder: new MeshBuilder(), sourceWayCount: 0 },
  "sports": { label: "运动场地", builder: new MeshBuilder(), sourceWayCount: 0 },
};

for (const ring of campusRingsEN) {
  layers["campus-ground"].builder.addFlatPolygon(ring, [], 0);
  layers["campus-ground"].sourceWayCount++;
}

// Track ways consumed by building relations so they aren't double-counted
const relationBuildingWayIds = new Set();
const buildingEntries = [];

for (const rel of relations.values()) {
  if (!rel.tags?.building) continue;
  const outIds = rel.members.filter(m => m.type === "way" && (m.role === "outer" || !m.role)).map(m => m.ref);
  const inIds = rel.members.filter(m => m.type === "way" && m.role === "inner").map(m => m.ref);
  outIds.forEach(id => relationBuildingWayIds.add(id));
  inIds.forEach(id => relationBuildingWayIds.add(id));

  const outRings = stitchRings(outIds).map(r => ensureCCW(r.map(toLocalEN))).filter(r => r.length >= 3);
  const inRings = stitchRings(inIds).map(r => ensureCW(r.map(toLocalEN))).filter(r => r.length >= 3);
  if (!outRings.length) continue;

  const center = centroidEN(outRings[0]);
  if (!inCampusEN(center)) continue;
  buildingEntries.push({
    osmRef: "relation/" + rel.id,
    tags: rel.tags,
    outer: outRings[0],
    holes: inRings,
    center,
    area: Math.abs(signedArea2D(outRings[0])),
  });
}

// Process all ways
for (const w of ways.values()) {
  if (!w.tags) continue;
  const lonLat = getWayLonLat(w.id);
  if (lonLat.length < 2) continue;
  const ptsEN = lonLat.map(toLocalEN);

  // Buildings
  if (w.tags.building && !relationBuildingWayIds.has(w.id)) {
    const ring = ensureCCW(ptsEN);
    if (ring.length < 3) continue;
    const center = centroidEN(ring);
    if (!inCampusEN(center)) continue;
    buildingEntries.push({
      osmRef: "way/" + w.id,
      tags: w.tags,
      outer: ring,
      holes: [],
      center,
      area: Math.abs(signedArea2D(ring)),
    });
    continue;
  }

  // Water
  if (w.tags.natural === "water" || w.tags.leisure === "swimming_pool") {
    const ring = ensureCCW(ptsEN);
    if (ring.length >= 3 && inCampusEN(centroidEN(ring))) {
      layers.water.builder.addFlatPolygon(ring, [], 0);
      layers.water.sourceWayCount++;
    }
    continue;
  }

  // Sports
  if (w.tags.leisure === "pitch" || w.tags.leisure === "track" || w.tags.leisure === "stadium") {
    const ring = ensureCCW(ptsEN);
    if (ring.length >= 3 && inCampusEN(centroidEN(ring))) {
      layers.sports.builder.addFlatPolygon(ring, [], 0);
      layers.sports.sourceWayCount++;
    }
    continue;
  }

  // Grass / parks / woods inside campus
  if (
    w.tags.landuse === "grass" || w.tags.landuse === "forest" ||
    w.tags.natural === "wood" || w.tags.leisure === "park"
  ) {
    const ring = ensureCCW(ptsEN);
    if (ring.length >= 3 && inCampusEN(centroidEN(ring))) {
      layers.grass.builder.addFlatPolygon(ring, [], 0);
      layers.grass.sourceWayCount++;
    }
    continue;
  }

  // Highways (roads & footpaths)
  if (w.tags.highway) {
    const hw = w.tags.highway;
    const isFoot = /footway|path|steps|pedestrian|cycleway/.test(hw);
    const clipped = clipPolyline(ptsEN);
    if (!clipped.length) continue;

    // Classify road as internal if majority of points fall inside campus rings
    const insideCount = ptsEN.filter(inCampusEN).length;
    const isInternal = insideCount >= Math.ceil(ptsEN.length * 0.5) && !/motorway|trunk|primary/.test(hw);

    if (isFoot) {
      if (insideCount > 0) {
        for (const seg of clipped) layers.footpaths.builder.addRibbon(seg, hw === "steps" ? 3.2 : 2.6, 0);
        layers.footpaths.sourceWayCount++;
      }
    } else if (isInternal) {
      const width = hw === "tertiary" ? 7.5 : hw === "residential" ? 6.2 : 4.6;
      for (const seg of clipped) layers["internal-roads"].builder.addRibbon(seg, width, 0);
      layers["internal-roads"].sourceWayCount++;
    } else {
      const width = /motorway|trunk/.test(hw) ? 11.5 : hw === "primary" ? 10 : /secondary|tertiary/.test(hw) ? 8 : 6;
      for (const seg of clipped) layers["external-roads"].builder.addRibbon(seg, width, 0);
      layers["external-roads"].sourceWayCount++;
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Sort buildings, assign IDs, heights & review notes
// ---------------------------------------------------------------------------
// Count duplicate names in OSM so we flag them transparently in review notes
const nameCounts = new Map();
for (const b of buildingEntries) {
  const nm = (b.tags.name || "").trim();
  if (nm) nameCounts.set(nm, (nameCounts.get(nm) || 0) + 1);
}

// Deterministic ordering: named first (by Chinese locale, then north-to-south), then unnamed (north-to-south, west-to-east)
buildingEntries.sort((a, b) => {
  const an = (a.tags.name || "").trim();
  const bn = (b.tags.name || "").trim();
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  if (an && bn) {
    const cmp = an.localeCompare(bn, "zh-CN");
    if (cmp !== 0) return cmp;
  }
  return (b.center[1] - a.center[1]) || (a.center[0] - b.center[0]);
});

const manifestFeatures = [];
const reviewFeatures = [];
const buildingMeshes = [];

function classifyBuilding(name) {
  if (!name) return "candidate";
  if (/图书馆|办公大楼|博物馆|校史馆|钟鼓楼|校医院|体育中心|体育馆/.test(name)) return "landmark";
  if (/餐厅|食堂/.test(name)) return "canteen";
  if (/公寓|宿舍|专家楼/.test(name)) return "dorm";
  if (/朝阳楼|文科楼|化学楼|音乐楼|美术楼|进德楼|修业楼|宁静楼|实训楼|生物|新闻传播|学院|教学|天文台/.test(name)) return "teaching";
  return "service";
}

buildingEntries.forEach((entry, idx) => {
  const num = String(idx + 1).padStart(4, "0");
  const id = "hf-bldg-" + num;
  const rawName = (entry.tags.name || "").trim();
  const isNamed = Boolean(rawName);
  const phaseLabel = entry.center[1] >= -45 ? "一期（北区）" : "二期（南区）";
  const displayName = isNamed ? rawName : `${phaseLabel}未命名建筑 ${String(idx + 1).padStart(2, "0")}`;
  const category = classifyBuilding(rawName);

  // Height estimation from OSM height / building:levels / footprint area
  let height = 12;
  let hasLevelInfo = false;
  const parsedHeight = parseFloat(entry.tags.height);
  const parsedLevels = parseFloat(entry.tags["building:levels"]);
  if (Number.isFinite(parsedHeight) && parsedHeight > 2 && parsedHeight < 120) {
    height = parsedHeight;
    hasLevelInfo = true;
  } else if (Number.isFinite(parsedLevels) && parsedLevels >= 1 && parsedLevels <= 35) {
    height = +(parsedLevels * 3.4).toFixed(1);
    hasLevelInfo = true;
  } else {
    // Estimate by area & type
    if (entry.area < 180) height = 4.5;
    else if (entry.area < 550) height = 9.5;
    else if (entry.area < 1600) height = 15.0;
    else height = 18.5;
  }

  const builder = new MeshBuilder();
  builder.addExtrudedBuilding(entry.outer, entry.holes, height);
  buildingMeshes.push({ id, nodeName: "feature__" + id, builder });

  manifestFeatures.push({
    id,
    name: displayName,
    osmRef: entry.osmRef,
    campusZone: phaseLabel,
    category,
    modelGrade: hasLevelInfo ? "M2" : "M1+",
    status: "needs-review",
    confidence: {
      xy: "B",
      z: hasLevelInfo ? "B" : "C",
      roof: "C",
    },
    verification: isNamed ? "named" : "candidate",
    centerLocalEN: [+entry.center[0].toFixed(3), +entry.center[1].toFixed(3)],
    levels: hasLevelInfo && Number.isFinite(parsedLevels) ? parsedLevels : null,
  });

  const issues = [];
  if (!isNamed) {
    issues.push("OSM 底图中该建筑有轮廓但未填写楼名，属于待核验候选楼块。");
  } else if ((nameCounts.get(rawName) || 0) > 1) {
    issues.push(`OSM 中有 ${nameCounts.get(rawName)} 栋楼均标注为「${rawName}」（可能为相邻楼栋笔误或分馆），请结合现场校对。`);
  }
  if (hasLevelInfo && Number.isFinite(parsedLevels)) {
    issues.push(`楼高按 OSM 标注层数（${parsedLevels} 层 × 3.4 m）估算，非实测建筑立面。`);
  } else {
    issues.push("OSM 未标注层数，楼高按占地面积估算，非实测值。");
  }

  reviewFeatures.push({
    id,
    reviewStatus: "needs-review",
    osmRef: entry.osmRef,
    issues,
    references: [],
    modelName: displayName,
  });
});

// ---------------------------------------------------------------------------
// 7. Pack binary glTF 2.0 (.glb) — zero extensions, standard POSITION/NORMAL/INDICES
// ---------------------------------------------------------------------------
const gltfNodes = [];
const gltfMeshes = [];
const gltfAccessors = [];
const gltfBufferViews = [];
const gltfSceneNodes = [];
const binChunks = [];
let byteOffset = 0;

function appendTypedArray(typedArray, target) {
  // Align to 4 bytes
  const pad = (4 - (byteOffset % 4)) % 4;
  if (pad) {
    binChunks.push(Buffer.alloc(pad));
    byteOffset += pad;
  }
  const buf = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const viewIdx = gltfBufferViews.length;
  const bv = { buffer: 0, byteOffset, byteLength: buf.byteLength };
  if (target) bv.target = target;
  gltfBufferViews.push(bv);
  binChunks.push(buf);
  byteOffset += buf.byteLength;
  return viewIdx;
}

function addMeshNode(nodeName, builder) {
  if (!builder.indices.length) return;
  const posArr = new Float32Array(builder.positions);
  const normArr = new Float32Array(builder.normals);
  const idxArr = new Uint32Array(builder.indices);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < posArr.length; i += 3) {
    const x = posArr[i], y = posArr[i + 1], z = posArr[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const posView = appendTypedArray(posArr, 34962); // ARRAY_BUFFER
  const normView = appendTypedArray(normArr, 34962);
  const idxView = appendTypedArray(idxArr, 34963); // ELEMENT_ARRAY_BUFFER

  const posAcc = gltfAccessors.length;
  gltfAccessors.push({
    bufferView: posView, componentType: 5126, count: posArr.length / 3, type: "VEC3",
    min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
  });
  const normAcc = gltfAccessors.length;
  gltfAccessors.push({
    bufferView: normView, componentType: 5126, count: normArr.length / 3, type: "VEC3",
  });
  const idxAcc = gltfAccessors.length;
  gltfAccessors.push({
    bufferView: idxView, componentType: 5125, count: idxArr.length, type: "SCALAR",
  });

  const meshIdx = gltfMeshes.length;
  gltfMeshes.push({
    name: nodeName,
    primitives: [{
      attributes: { POSITION: posAcc, NORMAL: normAcc },
      indices: idxAcc,
      material: 0,
    }],
  });

  const nodeIdx = gltfNodes.length;
  gltfNodes.push({ name: nodeName, mesh: meshIdx });
  gltfSceneNodes.push(nodeIdx);
}

// Add semantic layers first, then building features
const semanticLayersMeta = [];
let totalTriangles = 0;
for (const [layerId, meta] of Object.entries(layers)) {
  const nodeName = "layer__" + layerId;
  addMeshNode(nodeName, meta.builder);
  totalTriangles += meta.builder.triangleCount;
  semanticLayersMeta.push({
    id: layerId,
    nodeName,
    label: meta.label,
    triangles: meta.builder.triangleCount,
    sourceWayCount: meta.sourceWayCount,
  });
}

for (const bm of buildingMeshes) {
  addMeshNode(bm.nodeName, bm.builder);
  totalTriangles += bm.builder.triangleCount;
}

// Pad BIN chunk to 4 bytes
const binPad = (4 - (byteOffset % 4)) % 4;
if (binPad) {
  binChunks.push(Buffer.alloc(binPad));
  byteOffset += binPad;
}
const binBuffer = Buffer.concat(binChunks);

const gltfJson = {
  asset: {
    version: "2.0",
    generator: "CampusAgentOS Huafeng OSM 3D Builder",
    copyright: "© OpenStreetMap contributors (ODbL 1.0)",
  },
  scene: 0,
  scenes: [{ name: "HuafengCampus", nodes: gltfSceneNodes }],
  nodes: gltfNodes,
  meshes: gltfMeshes,
  materials: [{
    name: "DefaultWhiteBox",
    pbrMetallicRoughness: { baseColorFactor: [0.85, 0.85, 0.82, 1], metallicFactor: 0, roughnessFactor: 1 },
  }],
  accessors: gltfAccessors,
  bufferViews: gltfBufferViews,
  buffers: [{ byteLength: binBuffer.byteLength }],
};

let jsonBuf = Buffer.from(JSON.stringify(gltfJson), "utf8");
const jsonPad = (4 - (jsonBuf.byteLength % 4)) % 4;
if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]); // space-padded JSON chunk per glTF 2.0 spec

const totalLength = 12 + 8 + jsonBuf.byteLength + 8 + binBuffer.byteLength;
const glbHeader = Buffer.alloc(12);
glbHeader.writeUInt32LE(0x46546C67, 0); // "glTF"
glbHeader.writeUInt32LE(2, 4);          // version 2
glbHeader.writeUInt32LE(totalLength, 8);

const jsonChunkHeader = Buffer.alloc(8);
jsonChunkHeader.writeUInt32LE(jsonBuf.byteLength, 0);
jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // "JSON"

const binChunkHeader = Buffer.alloc(8);
binChunkHeader.writeUInt32LE(binBuffer.byteLength, 0);
binChunkHeader.writeUInt32LE(0x004E4942, 4); // "BIN\0"

const glbBytes = Buffer.concat([glbHeader, jsonChunkHeader, jsonBuf, binChunkHeader, binBuffer]);
const glbPath = path.join(outDir, "huafeng-campus.glb");
fs.writeFileSync(glbPath, glbBytes);
const sha256 = crypto.createHash("sha256").update(glbBytes).digest("hex");

// ---------------------------------------------------------------------------
// 8. Write manifest.json, landmarks.json, buildings-review.json, NOTICE.txt
// ---------------------------------------------------------------------------
const manifest = {
  schemaVersion: 1,
  datasetId: "cwnu-huafeng",
  releaseId: "osm-huafeng-v1",
  status: "needs-review",
  generatedAt: new Date().toISOString(),
  coordinateSystem: {
    unit: "m",
    axes: { x: "east", y: "up", z: "south" },
    north: [0, 0, -1],
    logicalGroundZ: 0,
    sourceCrs: "EPSG:32648",
    originWgs84: {
      longitude: +originLon.toFixed(7),
      latitude: +originLat.toFixed(7),
      height: null,
    },
  },
  presentation: {
    style: "campus-white-box",
    renderedRoofCards: false,
  },
  model: {
    uri: "huafeng-campus.glb",
    bytes: glbBytes.byteLength,
    sha256,
    triangles: totalTriangles,
    nodes: gltfNodes.length,
    meshes: gltfMeshes.length,
    featureCount: manifestFeatures.length,
  },
  referenceMap: {
    source: "OpenStreetMap relation/19478636 (ODbL 1.0)",
    defaultVisible: false,
    campusBoundaryLocalEN: allBoundaryEN.map(([e, n]) => [+e.toFixed(3), +n.toFixed(3)]),
  },
  semanticLayers: semanticLayersMeta,
  features: manifestFeatures,
};
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

// Derive schematic gates from verified OSM gate/bridge nodes
const gateNodes = [];
const gate1 = nodes.get(4780806121);
const gate2 = nodes.get(14002570470);
if (gate1 && gate2) {
  const en1 = toLocalEN([gate1.lon, gate1.lat]);
  const en2 = toLocalEN([gate2.lon, gate2.lat]);
  const midE = (en1[0] + en2[0]) / 2;
  const midN = (en1[1] + en2[1]) / 2;
  gateNodes.push({
    id: "gate-phase1-south",
    name: "一期大门（南侧）",
    positionLocal: [+midE.toFixed(3), 0, +(-midN).toFixed(3)],
    osmNodes: [4780806121, 14002570470],
    status: "approximate",
    note: "依据 OpenStreetMap 标注的校门/门禁节点（鼎新大道与西华路交汇处）生成，位置与门名为示意，请以现场出入口为准。",
  });
}

// Check Tongxian Bridge (通贤桥) connecting Phase 1 & Phase 2 across Xihua Road
const tongxianBridgeWay = [...ways.values()].find(w => w.tags?.name === "通贤桥");
if (tongxianBridgeWay) {
  const pts = getWayLonLat(tongxianBridgeWay.id).map(toLocalEN);
  const c = centroidEN(pts);
  gateNodes.push({
    id: "gate-tongxian-bridge",
    name: "通贤桥（一期↔二期）",
    positionLocal: [+c[0].toFixed(3), 0, +(-c[1]).toFixed(3)],
    osmWay: tongxianBridgeWay.id,
    status: "approximate",
    note: "依据 OpenStreetMap 通贤桥路段中心点标注，为连接华凤校区一期（北区）与二期（南区）的跨路通道示意。",
  });
}

// Check Feihong Bridge (飞虹桥) connecting Phase 1 & Phase 2
const feihongBridgeWay = [...ways.values()].find(w => w.tags?.name === "飞虹桥");
if (feihongBridgeWay) {
  const pts = getWayLonLat(feihongBridgeWay.id).map(toLocalEN);
  const c = centroidEN(pts);
  gateNodes.push({
    id: "gate-feihong-bridge",
    name: "飞虹桥（一期↔二期）",
    positionLocal: [+c[0].toFixed(3), 0, +(-c[1]).toFixed(3)],
    osmWay: feihongBridgeWay.id,
    status: "approximate",
    note: "依据 OpenStreetMap 飞虹桥路段中心点标注，为华凤校区西侧连接一期与二期的跨路通道示意。",
  });
}

// Check Phase 2 road entrance along Shida Road Section 2 (师大路二段)
const shidaRoadNodes = new Set();
for (const w of ways.values()) {
  if (w.tags?.name && /师大路/.test(w.tags.name)) {
    (w.nodes || []).forEach(nid => shidaRoadNodes.add(nid));
  }
}
// Find residential/service road connecting Phase 2 into 师大路二段
let phase2GateCoord = null;
for (const w of ways.values()) {
  if (!w.tags?.highway || /trunk|primary|motorway/.test(w.tags.highway)) continue;
  const shared = (w.nodes || []).find(nid => shidaRoadNodes.has(nid));
  if (!shared) continue;
  const n = nodes.get(shared);
  if (!n) continue;
  const en = toLocalEN([n.lon, n.lat]);
  if (en[1] < -120 && en[1] > -650) {
    phase2GateCoord = { nodeId: shared, en, roadName: w.tags.name || w.tags.highway };
    break;
  }
}
if (phase2GateCoord) {
  gateNodes.push({
    id: "gate-phase2-east",
    name: "二期东侧出入口",
    positionLocal: [+phase2GateCoord.en[0].toFixed(3), 0, +(-phase2GateCoord.en[1]).toFixed(3)],
    osmNode: phase2GateCoord.nodeId,
    status: "approximate",
    note: "依据 OpenStreetMap 中二期校内道路与师大路二段交汇点标注，位置与门名为示意，请以现场出入口为准。",
  });
}

// Extract verified OSM campus places (lakes, plazas, named sports grounds)
const places = [];
const seenPlaceNames = new Set();
for (const w of ways.values()) {
  const name = (w.tags?.name || "").trim();
  if (!name || w.tags.building || w.tags.highway) continue;
  const isLake = w.tags.natural === "water" || w.tags.water === "lake";
  const isSquare = w.tags.place === "square";
  const isNamedPitch = w.tags.leisure === "pitch" && /灯光球场/.test(name);
  if (!isLake && !isSquare && !isNamedPitch) continue;
  const pts = getWayLonLat(w.id).map(toLocalEN);
  if (pts.length < 3) continue;
  const c = centroidEN(pts);
  if (!inCampusEN(c) || seenPlaceNames.has(name)) continue;
  seenPlaceNames.add(name);
  const placeKind = isLake ? "lake" : isSquare ? "square" : "sports";
  const phaseLabel = c[1] >= -45 ? "一期（北区）" : "二期（南区）";
  places.push({
    id: "place-" + placeKind + "-" + String(places.length + 1).padStart(2, "0"),
    name,
    kind: "place",
    placeKind,
    category: "place",
    campusZone: phaseLabel,
    positionLocal: [+c[0].toFixed(3), 0, +(-c[1]).toFixed(3)],
    osmWay: w.id,
    status: "approximate",
    note: `依据 OpenStreetMap 标注的${isLake ? "校园水体景观" : isSquare ? "校园公共广场" : "运动场地"}（${phaseLabel}，way/${w.id}）几何中心定位。`,
  });
}
places.sort((a, b) => {
  const order = { lake: 0, square: 1, sports: 2 };
  return (order[a.placeKind] - order[b.placeKind]) || a.name.localeCompare(b.name, "zh-CN");
});

const landmarks = {
  schemaVersion: 1,
  kind: "campus-gate-landmarks",
  source: "OpenStreetMap 华凤校区门禁、主干道连接点与校园广场/湖泊（ODbL 1.0）",
  coordinateSystem: "原模型局部米坐标：x东/y上/z南（EPSG:32648）",
  landmarks: gateNodes,
  places,
};
fs.writeFileSync(path.join(outDir, "landmarks.json"), JSON.stringify(landmarks, null, 2) + "\n", "utf8");

const reviewDoc = {
  schemaVersion: 1,
  kind: "building-evidence-review",
  reviewedAt: new Date().toISOString().slice(0, 10),
  scope: `hf-bldg-0001..hf-bldg-${String(reviewFeatures.length).padStart(4, "0")}`,
  geometryModified: false,
  tencent3dCompared: false,
  features: reviewFeatures,
};
fs.writeFileSync(path.join(outDir, "buildings-review.json"), JSON.stringify(reviewDoc, null, 2) + "\n", "utf8");

const notice = [
  "华凤校区三维地图（一期 + 二期）",
  "数据来源：OpenStreetMap（relation/19478636 西华师范大学(华凤校区) 及周边矢量要素）",
  "数据许可：© OpenStreetMap contributors，Open Database License 1.0",
  "https://www.openstreetmap.org/copyright",
  "模型说明：由 CampusAgentOS 基于 OSM 矢量轮廓与 EPSG:32648 局部米坐标自动生成白模（huafeng-campus.glb）。",
  "楼高依据 OSM building:levels（按 3.4m/层估算）或占地面积估算，非实测建筑立面。",
  "未命名建筑、重复楼名（如相邻公寓楼号）与出入口点位均标注待核验，请以现场指示为准。",
  "本页未调用腾讯或高德商业地图服务，未抓取商业卫星瓦片或 3D 模型。",
].join("\n") + "\n";
fs.writeFileSync(path.join(outDir, "NOTICE.txt"), notice, "utf8");

console.log("SUCCESS! Built Huafeng Campus 3D map:");
console.log("  GLB:", glbPath, `(${(glbBytes.byteLength / 1024).toFixed(1)} KB, sha256=${sha256.slice(0, 12)}...)`);
console.log("  Nodes:", gltfNodes.length, "Triangles:", totalTriangles);
console.log("  Buildings:", manifestFeatures.length, `(named=${manifestFeatures.filter(f => f.verification === "named").length}, candidate=${manifestFeatures.filter(f => f.verification === "candidate").length})`);
console.log("  Gates/Landmarks:", gateNodes.map(g => `${g.name} @ [${g.positionLocal[0]}, ${g.positionLocal[2]}]`));
console.log("  Places (lakes/plazas/sports):", places.map(p => `${p.name} (${p.placeKind}, ${p.campusZone})`));
console.log("  Semantic layers:", semanticLayersMeta.map(l => `${l.id}=${l.triangles} tris (${l.sourceWayCount} ways)`).join(", "));
