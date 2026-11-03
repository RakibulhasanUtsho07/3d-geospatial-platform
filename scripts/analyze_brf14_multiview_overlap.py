#!/usr/bin/env python3
"""Build a bounded, hash-bound pairwise image-match graph for BRF-14 views.

This diagnostic helps a reviewer triage possible visual overlap. It is not a
same-building classifier, camera calibration, reconstruction, or accuracy gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_FILENAME = re.compile(r"^[A-Za-z0-9_.-]+$")
MAX_VIEWS = 32
MAX_IMAGE_BYTES = 100 * 1024 * 1024
MAX_IMAGE_PIXELS = 100_000_000
MAX_TOTAL_BYTES = 500 * 1024 * 1024
MAX_TOTAL_PIXELS = 500_000_000
MAX_DIMENSION = 960
MAX_FEATURES = 1800
RATIO_TEST = 0.75
MIN_RATIO_MATCHES = 12
MIN_INLIERS = 10
MIN_INLIER_RATIO = 0.20
HOMOGRAPHY_RANSAC_PX = 4.0
FUNDAMENTAL_RANSAC_PX = 2.5


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_sha256(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def safe_file(root: Path, filename: str) -> Path:
    require(isinstance(filename, str) and SAFE_FILENAME.fullmatch(filename) is not None,
            "Image filename must be a safe basename.")
    path = root / filename
    require(path.parent == root, "Image path escapes the explicit asset root.")
    require(not path.is_symlink(), "Image asset must not be a symlink: " + filename)
    require(path.is_file(), "Image asset is missing or not a regular file: " + filename)
    return path


def validate_inputs(manifest: Any, verification: Any) -> list[dict[str, Any]]:
    require(isinstance(manifest, dict), "Source manifest must be a JSON object.")
    require(manifest.get("schemaVersion") == "1.0.0", "Unsupported source manifest schema.")
    require(manifest.get("evaluationStage") == "multiview-source-byte-intake-only",
            "Only the BRF-14 multi-view source-intake manifest is supported.")
    for flag in ("acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"):
        require(manifest.get(flag) is False, "Source manifest must keep " + flag + " false.")
    require(isinstance(verification, dict), "Byte-verification report must be a JSON object.")
    require(verification.get("schemaVersion") == "1.0.0" and
            verification.get("status") == "views-byte-verified",
            "All image bytes must pass the BRF-14 verifier before overlap analysis.")
    require(verification.get("sampleId") == manifest.get("sampleId"),
            "Byte-verification sampleId does not match the source manifest.")
    views, result_views = manifest.get("views"), verification.get("views")
    require(isinstance(views, list) and 3 <= len(views) <= MAX_VIEWS,
            "Manifest must contain between 3 and " + str(MAX_VIEWS) + " views.")
    require(isinstance(result_views, list) and len(result_views) == len(views),
            "Verification report must contain exactly one result per selected view.")
    result_by_id: dict[str, dict[str, Any]] = {}
    for result in result_views:
        require(isinstance(result, dict) and isinstance(result.get("id"), str),
                "Each verifier result must have a view id.")
        require(result["id"] not in result_by_id, "Verification report has duplicate view IDs.")
        result_by_id[result["id"]] = result

    seen_ids: set[str] = set()
    seen_filenames: set[str] = set()
    seen_hashes: set[str] = set()
    total_bytes = 0
    for index, view in enumerate(views):
        label = "views[" + str(index) + "]"
        require(isinstance(view, dict), label + " must be an object.")
        view_id, filename, digest, size = (
            view.get("id"), view.get("filename"), view.get("expectedSha256"), view.get("expectedByteSize")
        )
        require(isinstance(view_id, str) and view_id and view_id not in seen_ids,
                label + " has a missing or duplicate view ID.")
        require(isinstance(filename, str) and SAFE_FILENAME.fullmatch(filename) is not None and
                filename not in seen_filenames, label + " has an unsafe or duplicate filename.")
        require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None and digest not in seen_hashes,
                label + " has an invalid or duplicate expected hash.")
        require(isinstance(size, int) and not isinstance(size, bool) and 0 < size <= MAX_IMAGE_BYTES,
                label + " expected byte size is outside the supported limit.")
        require(view.get("mediaType") == "image/jpeg", label + " must declare JPEG.")
        width, height = view.get("declaredWidth"), view.get("declaredHeight")
        require(isinstance(width, int) and isinstance(height, int) and
                1 <= width <= 10_000 and 1 <= height <= 10_000 and
                width * height <= MAX_IMAGE_PIXELS, label + " has unsafe dimensions.")
        result = result_by_id.get(view_id)
        require(result is not None and result.get("status") == "passed" and
                result.get("filename") == filename and
                result.get("expectedSha256") == digest and result.get("actualSha256") == digest and
                result.get("expectedByteSize") == size and result.get("actualByteSize") == size,
                label + " does not have a matching passing byte-verification result.")
        seen_ids.add(view_id)
        seen_filenames.add(filename)
        seen_hashes.add(digest)
        total_bytes += size
    require(set(result_by_id) == seen_ids, "Verification report has unknown or missing view IDs.")
    require(manifest.get("expectedTotalBytes") == total_bytes and total_bytes <= MAX_TOTAL_BYTES,
            "Declared total image bytes are inconsistent or exceed the analysis budget.")
    return views


def load_grayscale(path: Path, view: dict[str, Any]) -> tuple[np.ndarray, tuple[int, int]]:
    with Image.open(path) as decoded:
        require(decoded.format in {"JPEG", "MPO"}, "Decoder reported non-JPEG source for " + view["id"])
        width, height = decoded.size
        require((width, height) == (view["declaredWidth"], view["declaredHeight"]),
                "Decoded dimensions disagree with manifest for " + view["id"])
        require(width * height <= MAX_IMAGE_PIXELS, "Decoded image exceeds pixel limit.")
        # The image is read as source pixels; resize is only for the bounded feature detector.
        scale = min(1.0, MAX_DIMENSION / max(width, height))
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        resized = decoded.convert("L").resize(target, Image.Resampling.LANCZOS)
        array = np.asarray(resized, dtype=np.uint8).copy()
    return array, (width, height)


def unique_ratio_matches(desc_a: np.ndarray, desc_b: np.ndarray) -> list[Any]:
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    try:
        pairs = matcher.knnMatch(desc_a, desc_b, k=2)
    except cv2.error:
        return []
    good = [pair[0] for pair in pairs if len(pair) >= 2 and pair[0].distance < RATIO_TEST * pair[1].distance]
    # Enforce one-to-one descriptor correspondences, preferring the lowest Hamming distance.
    good.sort(key=lambda match: (match.distance, match.queryIdx, match.trainIdx))
    filtered = []
    seen_query: set[int] = set()
    seen_train: set[int] = set()
    for match in good:
        if match.queryIdx in seen_query or match.trainIdx in seen_train:
            continue
        filtered.append(match)
        seen_query.add(match.queryIdx)
        seen_train.add(match.trainIdx)
    return filtered


def geometric_inliers(points_a: np.ndarray, points_b: np.ndarray) -> dict[str, Any]:
    results = []
    if len(points_a) >= 4:
        try:
            h, mask = cv2.findHomography(points_a, points_b, cv2.RANSAC, HOMOGRAPHY_RANSAC_PX,
                                         maxIters=2000, confidence=0.995)
            if h is not None and mask is not None:
                count = int(mask.ravel().sum())
                results.append(("homography-ransac", count))
        except cv2.error:
            pass
    if len(points_a) >= 8:
        try:
            fundamental, mask = cv2.findFundamentalMat(points_a, points_b, cv2.FM_RANSAC,
                                                        FUNDAMENTAL_RANSAC_PX, 0.995, 2000)
            if fundamental is not None and mask is not None:
                count = int(mask.ravel().sum())
                results.append(("fundamental-ransac", count))
        except cv2.error:
            pass
    if not results:
        return {"model": None, "inlierCount": 0, "inlierRatio": 0.0}
    # Highest support first; for ties prefer the more general epipolar model.
    model, count = sorted(results, key=lambda result: (result[1], result[0] == "fundamental-ransac"), reverse=True)[0]
    ratio = count / len(points_a) if len(points_a) else 0.0
    return {"model": model, "inlierCount": count, "inlierRatio": round(ratio, 6)}


def analyze_pair(view_a: dict[str, Any], view_b: dict[str, Any],
                 feature_a: dict[str, Any], feature_b: dict[str, Any]) -> dict[str, Any]:
    kp_a, desc_a = feature_a["keypoints"], feature_a["descriptors"]
    kp_b, desc_b = feature_b["keypoints"], feature_b["descriptors"]
    result: dict[str, Any] = {
        "viewA": view_a["id"],
        "viewB": view_b["id"],
        "filenameA": view_a["filename"],
        "filenameB": view_b["filename"],
        "sha256A": view_a["expectedSha256"],
        "sha256B": view_b["expectedSha256"],
        "keypointCountA": len(kp_a),
        "keypointCountB": len(kp_b),
        "ratioFilteredMatchCount": 0,
        "geometricModel": None,
        "geometricInlierCount": 0,
        "geometricInlierRatio": 0.0,
        "candidateOverlapEdge": False,
        "status": "weak-or-no-evidence",
        "reason": None,
    }
    if desc_a is None or desc_b is None or len(desc_a) < 2 or len(desc_b) < 2:
        result["reason"] = "one-or-both-views-have-too-few-descriptors"
        return result
    matches = unique_ratio_matches(desc_a, desc_b)
    result["ratioFilteredMatchCount"] = len(matches)
    if len(matches) < 8:
        result["reason"] = "fewer-than-eight-ratio-filtered-matches"
        return result
    points_a = np.float32([kp_a[match.queryIdx].pt for match in matches]).reshape(-1, 2)
    points_b = np.float32([kp_b[match.trainIdx].pt for match in matches]).reshape(-1, 2)
    geom = geometric_inliers(points_a, points_b)
    result["geometricModel"] = geom["model"]
    result["geometricInlierCount"] = geom["inlierCount"]
    result["geometricInlierRatio"] = geom["inlierRatio"]
    candidate = (
        len(matches) >= MIN_RATIO_MATCHES and
        geom["inlierCount"] >= MIN_INLIERS and
        geom["inlierRatio"] >= MIN_INLIER_RATIO
    )
    result["candidateOverlapEdge"] = bool(candidate)
    if candidate:
        result["status"] = "candidate-match-requires-visual-review"
        result["reason"] = "geometric-local-feature-support-exceeds-triage-thresholds"
    elif geom["inlierCount"] == 0:
        result["reason"] = "no-usable-geometric-consensus"
    else:
        result["reason"] = "geometric-support-below-triage-thresholds"
    return result


def analyze_overlap(manifest: dict[str, Any], asset_root: Path, verification: dict[str, Any],
                    output_dir: Path, analyzed_at_utc: str | None = None) -> dict[str, Any]:
    views = validate_inputs(manifest, verification)
    requested_root = asset_root.expanduser().absolute()
    require(not requested_root.is_symlink() and requested_root.is_dir(),
            "Asset root must be an existing real directory, not a symlink.")
    root = requested_root.resolve(strict=True)
    images = []
    feature_total_pixels = 0
    actual_total_bytes = 0
    actual_hashes: set[str] = set()

    orb = cv2.ORB_create(nfeatures=MAX_FEATURES, scaleFactor=1.2, nlevels=8,
                         edgeThreshold=15, firstLevel=0, WTA_K=2,
                         scoreType=cv2.ORB_HARRIS_SCORE, patchSize=31, fastThreshold=12)
    cv2.setNumThreads(1)
    cv2.setRNGSeed(0)
    feature_records = []
    for view in views:
        file_path = safe_file(root, view["filename"])
        size = file_path.stat().st_size
        require(size == view["expectedByteSize"] and size <= MAX_IMAGE_BYTES,
                "Image byte size changed or exceeds budget for " + view["id"])
        digest = sha256_file(file_path)
        require(digest == view["expectedSha256"],
                "Image SHA-256 changed after byte verification for " + view["id"])
        grayscale, dimensions = load_grayscale(file_path, view)
        feature_total_pixels += grayscale.shape[0] * grayscale.shape[1]
        require(feature_total_pixels <= MAX_TOTAL_PIXELS,
                "Reduced images exceed the total feature-analysis pixel budget.")
        keypoints, descriptors = orb.detectAndCompute(grayscale, None)
        feature_records.append({
            "id": view["id"],
            "filename": view["filename"],
            "sha256": digest,
            "byteSize": size,
            "originalDimensions": list(dimensions),
            "analysisDimensions": [int(grayscale.shape[1]), int(grayscale.shape[0])],
            "keypointCount": len(keypoints),
        })
        images.append({"view": view, "image": grayscale, "keypoints": keypoints, "descriptors": descriptors})
        actual_total_bytes += size
        actual_hashes.add(digest)

    require(actual_total_bytes == manifest["expectedTotalBytes"],
            "Actual input byte total does not match the manifest.")
    expected_pairs = len(images) * (len(images) - 1) // 2
    require(expected_pairs <= MAX_VIEWS * (MAX_VIEWS - 1) // 2,
            "Pair count exceeds the configured maximum.")

    pairs = []
    degree = {item["view"]["id"]: 0 for item in images}
    for index, item_a in enumerate(images):
        for item_b in images[index + 1:]:
            edge = analyze_pair(item_a["view"], item_b["view"], item_a, item_b)
            pairs.append(edge)
            if edge["candidateOverlapEdge"]:
                degree[edge["viewA"]] += 1
                degree[edge["viewB"]] += 1
    output_dir = output_dir.expanduser().absolute()
    output_dir.mkdir(parents=True, exist_ok=True)
    require(not output_dir.is_symlink(), "Output directory must not be a symlink.")
    output_dir = output_dir.resolve(strict=True)
    graph_path = output_dir / "pairwise-overlap-graph.png"
    report_path = output_dir / "pairwise-overlap-report.json"
    make_overlap_graph(images, pairs, degree).save(graph_path, format="PNG", optimize=False, compress_level=9)
    candidate_edges = sum(1 for pair in pairs if pair["candidateOverlapEdge"])
    connected_views = sum(1 for value in degree.values() if value > 0)
    report = {
        "schemaVersion": "1.0.0",
        "sampleId": manifest["sampleId"],
        "evaluationStage": "pairwise-image-feature-overlap-triage-only",
        "status": "pairwise-analysis-complete-needs-human-review",
        "analyzedAtUtc": analyzed_at_utc or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "analyzer": {
            "name": "OpenCV ORB descriptor matching with geometric-consensus triage",
            "opencvVersion": cv2.__version__,
            "maxAnalysisDimension": MAX_DIMENSION,
            "maxFeaturesPerImage": MAX_FEATURES,
            "ratioTest": RATIO_TEST,
            "candidateThresholds": {
                "minimumRatioFilteredMatches": MIN_RATIO_MATCHES,
                "minimumGeometricInliers": MIN_INLIERS,
                "minimumGeometricInlierRatio": MIN_INLIER_RATIO,
                "homographyRansacThresholdPixels": HOMOGRAPHY_RANSAC_PX,
                "fundamentalRansacThresholdPixels": FUNDAMENTAL_RANSAC_PX,
            },
            "randomSeed": 0,
            "opencvThreads": 1,
        },
        "sourceManifest": {
            "metadataCommit": manifest["dataset"]["sourceRepositoryCommit"],
            "selectedViewCount": len(views),
            "declaredTotalBytes": manifest["expectedTotalBytes"],
            "actualTotalBytes": actual_total_bytes,
            "byteVerificationStatus": verification["status"],
            "byteVerificationReportCanonicalJsonSha256": canonical_json_sha256(verification),
        },
        "counts": {
            "views": len(views),
            "possiblePairs": expected_pairs,
            "evaluatedPairs": len(pairs),
            "candidateOverlapEdges": candidate_edges,
            "viewsWithAtLeastOneCandidateEdge": connected_views,
            "viewsWithNoCandidateEdges": len(views) - connected_views,
        },
        "views": [
            {
                **record,
                "candidateEdgeDegree": degree[record["id"]],
                "visualReviewRequired": True,
            } for record in feature_records
        ],
        "pairs": pairs,
        "humanReview": {
            "status": "pending-human-review",
            "reviewer": None,
            "reviewedAtUtc": None,
            "candidateEdgesVisuallyConfirmed": False,
            "weakEdgesReviewed": False,
            "sameBuildingIdentityVerified": False,
            "overlapReviewed": False,
            "sourceUpAxisReviewed": False,
            "notes": None,
        },
        "graphArtifact": {
            "filename": graph_path.name,
            "byteSize": graph_path.stat().st_size,
            "sha256": sha256_file(graph_path),
            "candidateEdgeStyle": "solid red line with match-count label; requires visual inspection",
            "weakEdgeStyle": "thin grey line; counts below candidate thresholds",
        },
        "rawImageBytesIncluded": False,
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
        "interpretation": [
            "A candidate edge is only a local-feature/geometric-consensus hint for human review.",
            "Repeated roof texture, lawn, pavement or other common patterns can produce false matches.",
            "A weak edge can arise from blur, viewpoint change, occlusion, low texture, illumination or limited overlap; it does not prove a different building.",
            "The graph is not a metric camera solution, survey registration, candidate GLB, or accuracy measurement.",
            "No review confirmation or release flag is set by this analyzer.",
        ],
    }
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return report


def make_overlap_graph(images: list[dict[str, Any]], pairs: list[dict[str, Any]],
                       degree: dict[str, int]) -> Image.Image:
    width, height = 1500, 1150
    canvas = Image.new("RGB", (width, height), "#ffffff")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((32, 20), "BRF-21 — Pairwise image-feature overlap triage", fill="#132238", font=font)
    draw.text((32, 42), "Candidate edges require visual confirmation; the graph is not proof of identity or survey accuracy.",
              fill="#475569", font=font)
    cx, cy, radius = width // 2, 555, 365
    node_xy: dict[str, tuple[int, int]] = {}
    total = len(images)
    for index, item in enumerate(images):
        theta = -math.pi / 2 + 2 * math.pi * index / total
        node_xy[item["view"]["id"]] = (
            int(cx + radius * math.cos(theta)), int(cy + radius * math.sin(theta))
        )
    for pair in pairs:
        x1, y1 = node_xy[pair["viewA"]]
        x2, y2 = node_xy[pair["viewB"]]
        if pair["candidateOverlapEdge"]:
            draw.line((x1, y1, x2, y2), fill="#c2413b", width=3)
            mx, my = (x1 + x2) // 2, (y1 + y2) // 2
            draw.text((mx, my), str(pair["geometricInlierCount"]), fill="#991b1b", font=font)
        elif pair["ratioFilteredMatchCount"] >= 4:
            draw.line((x1, y1, x2, y2), fill="#d7dee7", width=1)
    for index, item in enumerate(images):
        view_id = item["view"]["id"]
        x, y = node_xy[view_id]
        d = degree[view_id]
        fill = "#0f766e" if d >= 2 else "#d97706" if d == 1 else "#64748b"
        draw.ellipse((x - 26, y - 26, x + 26, y + 26), fill=fill, outline="#ffffff", width=3)
        label = "V" + str(index + 1).zfill(2)
        draw.text((x - 13, y - 5), label, fill="#ffffff", font=font)
        angle = math.atan2(y - cy, x - cx)
        lx = int(x + (37 if math.cos(angle) >= 0 else -112))
        ly = int(y + (31 if math.sin(angle) >= 0 else -22))
        draw.text((lx, ly), view_id, fill="#334155", font=font)
    legend_y = 965
    draw.line((38, legend_y, 74, legend_y), fill="#c2413b", width=4)
    draw.text((84, legend_y - 6), "Candidate local-feature edge — inspect actual images", fill="#7f1d1d", font=font)
    draw.line((560, legend_y, 596, legend_y), fill="#d7dee7", width=2)
    draw.text((606, legend_y - 6), "Weak matches below candidate thresholds", fill="#475569", font=font)
    draw.ellipse((1020, legend_y - 9, 1038, legend_y + 9), fill="#0f766e")
    draw.text((1047, legend_y - 6), "2+ candidate edges", fill="#334155", font=font)
    draw.ellipse((1240, legend_y - 9, 1258, legend_y + 9), fill="#d97706")
    draw.text((1267, legend_y - 6), "1 edge", fill="#334155", font=font)
    draw.text((32, 1020), "Feature matching is sensitive to repetitive textures, camera angle, lighting and occlusion.",
              fill="#475569", font=font)
    draw.text((32, 1042), "Isolated views are not automatically rejected: lack of an edge is not proof of no overlap.",
              fill="#475569", font=font)
    draw.text((32, 1080), "All human-review fields remain pending. This output never approves a source or model.",
              fill="#7f1d1d", font=font)
    return canvas


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--asset-root", required=True, type=Path)
    parser.add_argument("--verification-report", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        verification = json.loads(args.verification_report.read_text(encoding="utf-8"))
        report = analyze_overlap(manifest, args.asset_root, verification, args.output_dir)
        print(json.dumps({
            "sampleId": report["sampleId"],
            "status": report["status"],
            "viewCount": report["counts"]["views"],
            "evaluatedPairs": report["counts"]["evaluatedPairs"],
            "candidateOverlapEdges": report["counts"]["candidateOverlapEdges"],
            "viewsWithNoCandidateEdges": report["counts"]["viewsWithNoCandidateEdges"],
            "graph": report["graphArtifact"],
            "reportPath": str((args.output_dir / "pairwise-overlap-report.json").resolve()),
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        }, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError, cv2.error) as error:
        print("BRF-21 overlap analysis blocked: " + str(error))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
