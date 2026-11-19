"""Evaluate labeled face pairs locally without creating accounts or sessions.

Run from the project root:
    python -m tools.calibrate_face_threshold pairs.csv

CSV columns: enrollment,probe,same_person (1 or 0).
Image paths are relative to the CSV. Use distinct captures and consenting subjects.
"""

import argparse
import csv
from functools import lru_cache
from pathlib import Path

from app.services.face_service import FaceError, MAX_IMAGE_BYTES, compare_score, extract_feature


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pairs", type=Path)
    parser.add_argument("--thresholds", type=float, nargs="+", default=[0.55, 0.60, 0.65, 0.70, 0.75])
    args = parser.parse_args()
    if any(not 0 < value <= 1 for value in args.thresholds):
        parser.error("Thresholds must be greater than 0 and at most 1.")

    @lru_cache(maxsize=256)
    def embedding(relative_path):
        path = args.pairs.parent / relative_path
        if path.stat().st_size > MAX_IMAGE_BYTES:
            raise FaceError("Image exceeds size limit")
        vector, _ = extract_feature(path.read_bytes())
        return vector

    scores = {0: [], 1: []}
    rejected = {0: 0, 1: 0}
    with args.pairs.open(encoding="utf-8-sig", newline="") as file:
        rows = csv.DictReader(file)
        if not {"enrollment", "probe", "same_person"}.issubset(rows.fieldnames or []):
            parser.error("CSV must contain enrollment, probe and same_person.")
        for row in rows:
            if row["same_person"] not in ("0", "1") or not row["enrollment"] or not row["probe"]:
                parser.error(f"Invalid pair on CSV line {rows.line_num}.")
            label = int(row["same_person"])
            try:
                enrolled = embedding(row["enrollment"])
            except (OSError, FaceError) as exc:
                parser.error(f"Enrollment image on CSV line {rows.line_num}: {exc}")
            try:
                probe = embedding(row["probe"])
            except FaceError:
                rejected[label] += 1
                continue
            except OSError as exc:
                parser.error(f"Probe image on CSV line {rows.line_num}: {exc}")
            scores[label].append(compare_score(enrolled, probe))

    totals = {label: len(scores[label]) + rejected[label] for label in scores}
    if not all(totals.values()):
        parser.error("Provide both same-person and different-person pairs.")
    print(f"Quality rejects: same-person {rejected[1]}, different-person {rejected[0]}")
    print("Threshold  False accepts (different person)  False rejects (same person)")
    for threshold in sorted(set(args.thresholds)):
        accepts = sum(score >= threshold for score in scores[0])
        rejects = rejected[1] + sum(score < threshold for score in scores[1])
        print(f"{threshold:>9.2f}  {accepts:>5}/{totals[0]:<5} ({accepts / totals[0]:.1%})"
              f"                     {rejects:>5}/{totals[1]:<5} ({rejects / totals[1]:.1%})")


if __name__ == "__main__":
    main()
