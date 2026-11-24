// User-supplied campus annotations, 2026-11-24. Keep OSM geometry and height evidence.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const corrections = {
  "hf-bldg-0115": ["研究生宿舍", "dorm", 1],
  "hf-bldg-0104": ["理科楼（A、B、C栋）", "teaching", 2],
  "hf-bldg-0102": ["西华师范大学教育信息技术中心", "service", 3],
  "hf-bldg-0042": ["第三学生食堂", "canteen", 4],
  "hf-bldg-0112": ["22公寓、23公寓", "dorm", 4],
  "hf-bldg-0114": ["24学舍", "dorm", 4],
  "hf-bldg-0103": ["灯光球场", "landmark", 4],
  "hf-bldg-0099": ["地理科学学院", "teaching", 5],
  "hf-bldg-0100": ["西华师范大学档案馆", "service", 5],
  "hf-bldg-0101": ["西华师范大学档案馆（附属楼块）", "service", 5],
};

export function applyNameCorrections(outDir) {
  const manifestPath = path.join(outDir, "manifest.json");
  const reviewPath = path.join(outDir, "buildings-review.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  for (const feature of manifest.features) {
    const correction = corrections[feature.id];
    if (!correction) continue;
    const [name, category, image] = correction;
    feature.name = name;
    feature.category = category;
    feature.verification = "named";
    feature.nameSource = { type: "user-annotation", date: "2026-11-24", image };
    const evidence = review.features.find(entry => entry.id === feature.id);
    evidence.modelName = name;
    evidence.nameSource = feature.nameSource;
    evidence.issues = evidence.issues.filter(issue => !issue.includes("未填写楼名"));
    const note = "名称依据用户于 2026-11-24 提供的校园截图标注；几何轮廓与高度仍沿用 OSM 模型。";
    if (!evidence.issues.includes(note)) evidence.issues.unshift(note);
  }
  // The footprint is one connected mesh. These are label/focus regions, not surveyed partitions.
  manifest.features.find(f => f.id === "hf-bldg-0104").parts = [
    { suffix: "a", name: "理科楼A栋", centerLocalEN: [453, -253], boundsLocalEN: [433, -292, 475.4, -219.5] },
    { suffix: "b", name: "理科楼B栋", centerLocalEN: [443, -315], boundsLocalEN: [412, -332.5, 475.4, -292] },
    { suffix: "c", name: "理科楼C栋", centerLocalEN: [380, -256], boundsLocalEN: [356.6, -311.6, 433, -222.8] },
  ];
  review.reviewedAt = "2026-11-24";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2) + "\n");

  const landmarksPath = path.join(outDir, "landmarks.json");
  const landmarks = JSON.parse(fs.readFileSync(landmarksPath, "utf8"));
  const gateCorrections = [
    { id: "gate-phase2-east", name: "南门", image: 1 },
    { id: "gate-phase1-south", name: "朝阳门", image: 2 },
    { id: "gate-dongliang", name: "栋梁门", image: 1, positionLocal: [568.1, 0, 310.2] },
    { id: "gate-zhida", name: "智达门", image: 2, positionLocal: [687.3, 0, -297.5] },
  ];
  for (const correction of gateCorrections) {
    let gate = landmarks.landmarks.find(entry => entry.id === correction.id);
    if (!gate) {
      gate = { id: correction.id };
      landmarks.landmarks.push(gate);
    }
    gate.name = correction.name;
    if (correction.positionLocal) gate.positionLocal = correction.positionLocal;
    gate.status = "approximate";
    gate.nameSource = { type: "user-annotation", date: "2026-11-24", batch: "campus-gates", image: correction.image };
    gate.note = correction.positionLocal
      ? "名称与位置依据用户于 2026-11-24 提供的校门截图，在现有模型对应道路交汇处示意标注；点位未经实测，请以现场出入口为准。"
      : "名称依据用户于 2026-11-24 提供的校门截图校正；位置保留原 OpenStreetMap 道路/门禁节点示意坐标，请以现场出入口为准。";
  }
  fs.writeFileSync(landmarksPath, JSON.stringify(landmarks, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  applyNameCorrections(path.resolve("app/static/maps/huafeng-campus"));
}
