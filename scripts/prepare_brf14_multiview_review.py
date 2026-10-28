#!/usr/bin/env python3
"""Prepare a human-reviewable BRF-14 multi-view packet without exporting source imagery."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_FILENAME = re.compile(r"^[A-Za-z0-9_.-]+$")
MAX_VIEWS = 32
MAX_IMAGE_BYTES = 100 * 1024 * 1024
MAX_IMAGE_PIXELS = 100_000_000
MAX_TOTAL_BYTES = 500 * 1024 * 1024
MAX_TOTAL_PIXELS = 500_000_000
CONTACT_COLUMNS = 4
CELL_WIDTH = 450
CELL_HEIGHT = 420
SHEET_MARGIN = 24


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_file(root: Path, filename: str) -> Path:
    require(isinstance(filename, str) and SAFE_FILENAME.fullmatch(filename) is not None,
            "Image filename must be a simple safe basename.")
    path = root / filename
    require(path.parent == root, "Image path escapes the explicit asset root.")
    require(not path.is_symlink(), "Image asset must not be a symlink: " + filename)
    require(path.is_file(), "Image asset is missing or not a regular file: " + filename)
    return path


def validate_manifest(manifest: Any, verification: Any) -> list[dict[str, Any]]:
    require(isinstance(manifest, dict), "Source manifest must be a JSON object.")
    require(manifest.get("schemaVersion") == "1.0.0", "Unsupported source manifest schema.")
    require(manifest.get("evaluationStage") == "multiview-source-byte-intake-only",
            "Only a BRF-14 multi-view source-intake manifest is supported.")
    require(manifest.get("acceptanceEligible") is False and
            manifest.get("publicationEligible") is False and
            manifest.get("mapReady") is False and
            manifest.get("automaticApproval") is False,
            "Source manifest must keep all acceptance/publication flags false.")
    require(isinstance(verification, dict), "Byte-verification report must be a JSON object.")
    require(verification.get("schemaVersion") == "1.0.0" and
            verification.get("status") == "views-byte-verified",
            "All source image bytes must pass the BRF-14 verifier before review rendering.")
    require(verification.get("sampleId") == manifest.get("sampleId"),
            "Byte-verification report sampleId does not match the source manifest.")
    views = manifest.get("views")
    report_views = verification.get("views")
    require(isinstance(views, list) and 3 <= len(views) <= MAX_VIEWS,
            "Manifest must contain between 3 and " + str(MAX_VIEWS) + " views.")
    require(isinstance(report_views, list) and len(report_views) == len(views),
            "Verification report must contain exactly one result per selected view.")
    if manifest.get("selectionMethod", {}).get("expectedViewCount") is not None:
        require(manifest["selectionMethod"]["expectedViewCount"] == len(views),
                "Selection method expectedViewCount disagrees with manifest.")
    report_by_id = {}
    for result in report_views:
        require(isinstance(result, dict) and isinstance(result.get("id"), str),
                "Each verification result must have a view id.")
        require(result["id"] not in report_by_id, "Verification report contains duplicate view IDs.")
        report_by_id[result["id"]] = result
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    total_bytes = 0
    for index, view in enumerate(views):
        label = "views[" + str(index) + "]"
        require(isinstance(view, dict), label + " must be an object.")
        view_id = view.get("id")
        filename = view.get("filename")
        require(isinstance(view_id, str) and view_id and view_id not in seen_ids,
                label + " has a missing or duplicate id.")
        require(isinstance(filename, str) and SAFE_FILENAME.fullmatch(filename) is not None and
                filename not in seen_names, label + " has a missing, unsafe or duplicate filename.")
        seen_ids.add(view_id)
        seen_names.add(filename)
        size = view.get("expectedByteSize")
        expected_hash = view.get("expectedSha256")
        require(isinstance(size, int) and not isinstance(size, bool) and 0 < size <= MAX_IMAGE_BYTES,
                label + " expectedByteSize is outside the supported limits.")
        require(isinstance(expected_hash, str) and SHA256.fullmatch(expected_hash) is not None,
                label + " expectedSha256 must be lowercase SHA-256 hex.")
        require(view.get("mediaType") == "image/jpeg", label + " must declare JPEG media type.")
        width, height = view.get("declaredWidth"), view.get("declaredHeight")
        require(isinstance(width, int) and isinstance(height, int) and
                1 <= width <= 10_000 and 1 <= height <= 10_000 and
                width * height <= MAX_IMAGE_PIXELS,
                label + " image dimensions exceed review limits.")
        pose = view.get("colmapPose")
        require(isinstance(pose, dict) and
                isinstance(pose.get("cameraCenterLocalM"), list) and
                len(pose["cameraCenterLocalM"]) == 3 and
                all(isinstance(n, (int, float)) and math.isfinite(n) for n in pose["cameraCenterLocalM"]) and
                isinstance(pose.get("centerAzimuthDegrees"), (int, float)) and
                math.isfinite(pose["centerAzimuthDegrees"]) and
                0 <= pose["centerAzimuthDegrees"] < 360 and
                isinstance(pose.get("centerElevationDegrees"), (int, float)) and
                math.isfinite(pose["centerElevationDegrees"]) and
                -90 <= pose["centerElevationDegrees"] <= 90,
                label + " has invalid or missing source COLMAP pose fields.")
        result = report_by_id.get(view_id)
        require(result is not None and result.get("status") == "passed",
                label + " has no passing byte-verification result.")
        require(result.get("filename") == filename and
                result.get("expectedSha256") == expected_hash and
                result.get("actualSha256") == expected_hash and
                result.get("expectedByteSize") == size and
                result.get("actualByteSize") == size,
                label + " byte-verification record does not match its pinned manifest.")
        total_bytes += size
    require(set(report_by_id) == seen_ids, "Verification report includes unknown or missing view IDs.")
    require(total_bytes <= MAX_TOTAL_BYTES, "Selected image set exceeds the total byte limit.")
    require(manifest.get("expectedTotalBytes") == total_bytes,
            "expectedTotalBytes does not equal the sum of selected image sizes.")
    return views


def make_contact_sheet(items: list[dict[str, Any]]) -> Image.Image:
    rows = math.ceil(len(items) / CONTACT_COLUMNS)
    sheet = Image.new("RGB", (CONTACT_COLUMNS * CELL_WIDTH, rows * CELL_HEIGHT), "#f3f5f8")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, item in enumerate(items):
        view = item["view"]
        image = item["image"]
        col, row = index % CONTACT_COLUMNS, index // CONTACT_COLUMNS
        x, y = col * CELL_WIDTH, row * CELL_HEIGHT
        draw.rectangle((x + 7, y + 7, x + CELL_WIDTH - 8, y + CELL_HEIGHT - 8),
                       fill="#ffffff", outline="#bac4d0", width=2)
        draw.text((x + 16, y + 15), view["id"] + "  |  " + str(index + 1).zfill(2),
                  fill="#132238", font=font)
        image.thumbnail((CELL_WIDTH - 36, 284), Image.Resampling.LANCZOS)
        ix = x + (CELL_WIDTH - image.width) // 2
        iy = y + 42 + (284 - image.height) // 2
        sheet.paste(image.convert("RGB"), (ix, iy))
        pose = view["colmapPose"]
        center = pose["cameraCenterLocalM"]
        lines = [
            view["filename"],
            "Captured: " + str(view.get("capturedAt", "not supplied")),
            "Source azimuth/elevation: " + format(pose["centerAzimuthDegrees"], ".1f") +
            " / " + format(pose["centerElevationDegrees"], ".1f") + " deg",
            "Look angle: " + format(pose.get("lookAngleToCaptureCenterDegrees", float("nan")), ".1f") +
            " deg | Local C: " + ", ".join(format(v, ".1f") for v in center),
            "SHA-256: " + item["actualSha256"][:20] + "…",
        ]
        for line_index, line in enumerate(lines):
            draw.text((x + 16, y + 334 + line_index * 14), line[:64], fill="#344256", font=font)
    return sheet


def make_coverage_plot(items: list[dict[str, Any]]) -> Image.Image:
    width, height = 1200, 680
    image = Image.new("RGB", (width, height), "#ffffff")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()
    left, top, right, bottom = 110, 110, 1140, 570
    draw.text((32, 24), "BRF-14 source camera-angle coverage", fill="#132238", font=font)
    draw.text((32, 46), "Source COLMAP azimuth/elevation metadata only; not georeferenced or axis-validated",
              fill="#475569", font=font)
    for azimuth in range(0, 361, 45):
        x = left + (right - left) * azimuth / 360
        draw.line((x, top, x, bottom), fill="#e2e8f0", width=1)
        draw.text((x - 10, bottom + 12), str(azimuth), fill="#475569", font=font)
    for elevation in range(-90, 91, 30):
        y = bottom - (bottom - top) * (elevation + 90) / 180
        draw.line((left, y, right, y), fill="#e2e8f0", width=1)
        draw.text((left - 38, y - 5), str(elevation), fill="#475569", font=font)
    draw.rectangle((left, top, right, bottom), outline="#64748b", width=2)
    draw.text((left + 360, bottom + 38), "Azimuth (degrees)", fill="#334155", font=font)
    draw.text((14, top - 16), "Elevation", fill="#334155", font=font)
    for index, item in enumerate(items):
        pose = item["view"]["colmapPose"]
        azimuth = pose["centerAzimuthDegrees"]
        elevation = pose["centerElevationDegrees"]
        x = left + (right - left) * azimuth / 360
        y = bottom - (bottom - top) * (elevation + 90) / 180
        draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill="#d94841", outline="#7f1d1d")
        label = item["view"]["id"].replace("flat-roof-view-", "V")
        draw.text((x + 7, y - 10), label, fill="#7f1d1d", font=font)
    draw.text((32, 635),
              "Angles are relative to source capture-centre metadata. Visual overlap and building identity remain unreviewed.",
              fill="#475569", font=font)
    return image


def image_record(path: Path) -> dict[str, Any]:
    return {"filename": path.name, "byteSize": path.stat().st_size, "sha256": sha256_file(path)}


def prepare_review_packet(manifest: Any, asset_root: Path, verification: Any,
                          output_dir: Path, generated_at_utc: str | None = None) -> dict[str, Any]:
    views = validate_manifest(manifest, verification)
    requested_root = asset_root.expanduser().absolute()
    require(not requested_root.is_symlink() and requested_root.is_dir(),
            "Asset root must be an existing real directory, not a symlink.")
    root = requested_root.resolve(strict=True)
    items = []
    actual_total_bytes = 0
    actual_total_pixels = 0
    for view in views:
        file_path = safe_file(root, view["filename"])
        size = file_path.stat().st_size
        require(size == view["expectedByteSize"], "Byte size changed after BRF-14 verification: " + view["id"])
        actual_hash = sha256_file(file_path)
        require(actual_hash == view["expectedSha256"], "SHA-256 changed after BRF-14 verification: " + view["id"])
        require(size <= MAX_IMAGE_BYTES, "Image exceeds maximum byte size: " + view["id"])
        try:
            with file_path.open("rb") as source_stream:
                signature = source_stream.read(3)
            require(signature == b"\xff\xd8\xff",
                    "Image bytes do not have a JPEG SOI signature: " + view["id"])
            with Image.open(file_path) as check:
                require(check.format in {"JPEG", "MPO"},
                        "Decoder reported an unsupported JPEG-family format for " + view["id"] +
                        ": " + str(check.format))
                width, height = check.size
                require(width == view["declaredWidth"] and height == view["declaredHeight"],
                        "Decoded image dimensions disagree with manifest: " + view["id"])
                require(width * height <= MAX_IMAGE_PIXELS,
                        "Decoded image exceeds maximum pixel count: " + view["id"])
                check.verify()
            with Image.open(file_path) as decoded:
                decoded.thumbnail((CELL_WIDTH - 36, 284), Image.Resampling.LANCZOS)
                thumb = decoded.convert("RGB").copy()
        except Exception as error:
            if isinstance(error, ValueError):
                raise
            raise ValueError("Could not decode selected image " + view["id"] + ": " + str(error)) from error
        actual_total_bytes += size
        actual_total_pixels += width * height
        require(actual_total_pixels <= MAX_TOTAL_PIXELS, "Image set exceeds total decoded pixel budget.")
        items.append({"view": view, "actualSha256": actual_hash, "actualByteSize": size, "image": thumb})
    require(actual_total_bytes == manifest["expectedTotalBytes"],
            "Actual total image bytes disagree with the manifest.")

    output_dir = output_dir.expanduser().absolute()
    output_dir.mkdir(parents=True, exist_ok=True)
    require(not output_dir.is_symlink(), "Output directory must not be a symlink.")
    output_dir = output_dir.resolve(strict=True)
    sheet_path = output_dir / "multiview-contact-sheet.png"
    plot_path = output_dir / "camera-angle-coverage.png"
    report_path = output_dir / "multiview-review-manifest.json"
    make_contact_sheet(items).save(sheet_path, format="PNG", optimize=False, compress_level=9)
    make_coverage_plot(items).save(plot_path, format="PNG", optimize=False, compress_level=9)

    report = {
        "schemaVersion": "1.0.0",
        "sampleId": manifest["sampleId"],
        "evaluationStage": "multiview-human-review-packet-only",
        "status": "review-packet-generated-pending-human-review",
        "generatedAtUtc": generated_at_utc or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sourceManifest": {
            "sampleId": manifest["sampleId"],
            "metadataCommit": manifest["dataset"]["sourceRepositoryCommit"],
            "selectedViewCount": len(views),
            "declaredTotalBytes": manifest["expectedTotalBytes"],
            "actualTotalBytes": actual_total_bytes,
            "byteVerificationStatus": verification["status"],
            "byteVerificationCheckedAt": verification.get("checkedAt"),
            "byteVerificationReportCanonicalJsonSha256": None,
        },
        "dataset": manifest["dataset"],
        "coordinateFrameMetadata": manifest["coordinateFrameMetadata"],
        "sourceViews": [
            {
                "id": item["view"]["id"],
                "filename": item["view"]["filename"],
                "sourceUrl": item["view"]["sourceUrl"],
                "capturedAt": item["view"]["capturedAt"],
                "expectedByteSize": item["view"]["expectedByteSize"],
                "actualByteSize": item["actualByteSize"],
                "expectedSha256": item["view"]["expectedSha256"],
                "actualSha256": item["actualSha256"],
                "declaredDimensions": [item["view"]["declaredWidth"], item["view"]["declaredHeight"]],
                "gpsMetadata": item["view"].get("gps"),
                "sourceColmapPose": item["view"]["colmapPose"],
                "review": {
                    "sameBuildingIdentity": "pending",
                    "imageOverlap": "pending",
                    "roofAndFacadeCoverage": "pending",
                    "occlusionAndMovingObjects": "pending",
                    "blurringExposureAndImageQuality": "pending",
                    "reviewer": None,
                    "reviewedAtUtc": None,
                    "notes": None,
                },
            }
            for item in items
        ],
        "humanReview": {
            "status": "pending-human-review",
            "reviewer": None,
            "reviewedAtUtc": None,
            "sameBuildingIdentityVerified": False,
            "overlapReviewed": False,
            "sourceUpAxisReviewed": False,
            "facadeAndRoofCoverageAccepted": False,
            "notes": None,
        },
        "cameraCoveragePlot": {
            "filename": plot_path.name,
            "interpretation": "Scatter plot of source-reported local COLMAP azimuth versus elevation. It is not a georeferenced camera plan and does not establish image overlap.",
            "sourceAxisConventionValidated": False,
            "gpsRegistrationVerified": False,
        },
        "reviewChecklist": [
            "Confirm every tile depicts the same physical building, not just the same capture-folder label.",
            "Review image overlap and identify disconnected/weakly connected views.",
            "Mark roof, every available facade, occlusions, blur, exposure issues and moving objects.",
            "Resolve source coordinate convention/up-axis before COLMAP reconstruction.",
            "Record reviewer identity, UTC timestamp and evidence-based notes; do not set a flag from metadata alone.",
        ],
        "outputArtifacts": {
            "contactSheet": image_record(sheet_path),
            "cameraCoveragePlot": image_record(plot_path),
        },
        "rawImageBytesIncluded": False,
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
        "limitations": [
            "A contact sheet is for human review, not a semantic same-building classifier.",
            "Pose coverage is derived from source COLMAP metadata and is not independently surveyed or registered to GPS.",
            "This packet does not run COLMAP, generate a candidate GLB, create independent survey truth, or score model accuracy.",
            "The source-declared CC BY 4.0 imagery licence is not independently authenticated by this workflow.",
        ],
    }
    # Hash the exact verification report payload, without depending on its key order.
    report["sourceManifest"]["byteVerificationReportSha256"] = hashlib.sha256(
        json.dumps(verification, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return report


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
        report = prepare_review_packet(manifest, args.asset_root, verification, args.output_dir)
        print(json.dumps({
            "sampleId": report["sampleId"],
            "status": report["status"],
            "selectedViewCount": len(report["sourceViews"]),
            "contactSheet": report["outputArtifacts"]["contactSheet"],
            "cameraCoveragePlot": report["outputArtifacts"]["cameraCoveragePlot"],
            "report": str((args.output_dir / "multiview-review-manifest.json").resolve()),
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        }, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print("BRF-20 review packet blocked: " + str(error))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
