#!/usr/bin/env python3
"""Inspect a pinned USGS LAZ tile without publishing or uploading the raw cloud."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{1,99}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
MAX_DOWNLOAD_BYTES = 100_000_000
CHUNK_SIZE = 750_000


def fail(message: str) -> None:
    raise ValueError(message)


def read_manifest(manifest_path: Path) -> dict[str, Any]:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != "1.0.0":
        fail("Manifest must be an object with schemaVersion 1.0.0.")
    if not SAFE_ID.fullmatch(str(manifest.get("sampleId", ""))):
        fail("Manifest sampleId is invalid.")
    dataset = manifest.get("dataset")
    coverage = manifest.get("coverage")
    frame = manifest.get("coordinateFrameExpectation")
    if not isinstance(dataset, dict) or not isinstance(coverage, dict) or not isinstance(frame, dict):
        fail("Manifest dataset, coverage and coordinateFrameExpectation objects are required.")
    if dataset.get("format") != "LAZ" or dataset.get("fileName") != "USGS_LPC_MN_CentralMissRiver_B22_4690_49885.laz":
        fail("Manifest does not identify the pinned Central Mississippi LAZ tile.")
    if dataset.get("sourceId") != "65078ad9d34eb6693be8c524":
        fail("Manifest sourceId does not match the pinned TNM product.")
    url = dataset.get("downloadUrl")
    if not isinstance(url, str) or not url.startswith("https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/MN_CentralMissRiver_B22/MN_CentralMissRiver_4_B22/LAZ/"):
        fail("Manifest download URL is outside the allowlisted USGS LAZ project path.")
    if not isinstance(dataset.get("expectedByteSize"), int) or dataset["expectedByteSize"] <= 0:
        fail("Manifest expectedByteSize must be a positive integer.")
    expected_hash = dataset.get("expectedSha256")
    if expected_hash is not None and (not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash)):
        fail("Manifest expectedSha256 must be null or 64 lowercase hexadecimal characters.")
    point = coverage.get("samplePoint")
    if not isinstance(point, dict):
        fail("coverage.samplePoint is required.")
    lon, lat = point.get("longitude"), point.get("latitude")
    if not isinstance(lon, (int, float)) or not math.isfinite(lon) or not -180 <= lon <= 180:
        fail("Sample longitude must be finite and within [-180, 180].")
    if not isinstance(lat, (int, float)) or not math.isfinite(lat) or not -85 <= lat <= 85:
        fail("Sample latitude must be finite and within [-85, 85].")
    if not isinstance(manifest.get("maximumDownloadBytes"), int) or not 1 <= dataset["expectedByteSize"] <= manifest["maximumDownloadBytes"] <= MAX_DOWNLOAD_BYTES:
        fail("Download size limit is invalid or smaller than the expected asset.")
    for flag in ("acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"):
        if manifest.get(flag) is not False:
            fail("Manifest " + flag + " must remain false for source intake.")
    return manifest


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while True:
            chunk = handle.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def crs_summary(crs: Any) -> dict[str, Any]:
    if crs is None:
        return {
            "present": False,
            "horizontalEpsg": None,
            "horizontalName": None,
            "horizontalType": None,
            "horizontalUnits": [],
            "verticalName": None,
            "verticalUnits": None,
            "wkt": None,
        }

    components = list(getattr(crs, "sub_crs_list", []) or [])
    horizontal = next((item for item in components if getattr(item, "is_projected", False)), None)
    vertical = next((item for item in components if getattr(item, "is_vertical", False)), None)
    if horizontal is None and (getattr(crs, "is_projected", False) or getattr(crs, "is_geographic", False)):
        horizontal = crs
    axes = getattr(horizontal, "axis_info", []) if horizontal is not None else []
    vertical_axes = getattr(vertical, "axis_info", []) if vertical is not None else []
    try:
        horizontal_epsg = horizontal.to_epsg() if horizontal is not None else None
    except Exception:
        horizontal_epsg = None
    return {
        "present": True,
        "name": getattr(crs, "name", None),
        "isCompound": bool(getattr(crs, "is_compound", False)),
        "horizontalEpsg": horizontal_epsg,
        "horizontalName": getattr(horizontal, "name", None),
        "horizontalType": "projected" if getattr(horizontal, "is_projected", False) else "geographic" if horizontal is not None else None,
        "horizontalUnits": [
            {"name": getattr(axis, "unit_name", None), "conversionFactor": getattr(axis, "unit_conversion_factor", None)}
            for axis in axes
        ],
        "verticalName": getattr(vertical, "name", None),
        "verticalUnits": [
            {"name": getattr(axis, "unit_name", None), "conversionFactor": getattr(axis, "unit_conversion_factor", None)}
            for axis in vertical_axes
        ],
        "wkt": crs.to_wkt() if hasattr(crs, "to_wkt") else None,
    }


def inspect_laz(manifest_path: Path, laz_path: Path, report_path: Path | None = None) -> dict[str, Any]:
    manifest = read_manifest(manifest_path)
    dataset = manifest["dataset"]
    point = manifest["coverage"]["samplePoint"]

    absolute = laz_path.resolve(strict=True)
    if laz_path.is_symlink() or not absolute.is_file():
        fail("LAZ input must be a regular non-symlink file.")
    stat = absolute.stat()
    if stat.st_size > manifest["maximumDownloadBytes"]:
        fail("LAZ input exceeds the configured download-size limit.")
    expected_size = dataset["expectedByteSize"]
    actual_hash = sha256_file(absolute)
    size_matches = stat.st_size == expected_size
    expected_hash = dataset.get("expectedSha256")
    hash_pinned = isinstance(expected_hash, str)
    hash_matches = bool(hash_pinned and actual_hash == expected_hash)
    if hash_pinned and not hash_matches:
        fail("Downloaded LAZ SHA-256 does not match the pinned manifest digest.")
    if not size_matches:
        fail("Downloaded LAZ size " + str(stat.st_size) + " differs from expected size " + str(expected_size) + ".")

    try:
        import laspy
        from pyproj import CRS, Transformer
    except ImportError as error:
        fail("Install the runtime dependencies first: pip install 'laspy[lazrs]' pyproj (" + str(error) + ").")

    header = None
    all_classifications: Counter[int] = Counter()
    sample_classifications: Counter[int] = Counter()
    total_points_seen = 0
    sample_points_seen = 0
    sample_xy = None
    horizontal_crs = None
    crs = None
    transformer = None
    coordinate_summary: dict[str, Any] = {}
    warnings: list[str] = []
    blockers: list[str] = []
    header_info: dict[str, Any] = {}

    with laspy.open(str(absolute), mode="r") as reader:
        header = reader.header
        try:
            crs = header.parse_crs()
        except Exception as error:
            warnings.append("LAS WKT/GeoTIFF CRS could not be parsed: " + str(error))
            crs = None
        coordinate_summary = crs_summary(crs)
        components = list(getattr(crs, "sub_crs_list", []) or []) if crs is not None else []
        horizontal_crs = next((item for item in components if getattr(item, "is_projected", False)), None)
        if horizontal_crs is None and crs is not None and getattr(crs, "is_projected", False):
            horizontal_crs = crs

        if horizontal_crs is None:
            blockers.append("projected-horizontal-crs-not-found-in-laz-header")
        else:
            try:
                transformer = Transformer.from_crs(
                    CRS.from_epsg(4326), horizontal_crs, always_xy=True
                )
                sx, sy = transformer.transform(float(point["longitude"]), float(point["latitude"]))
                sample_xy = (float(sx), float(sy))
            except Exception as error:
                blockers.append("sample-point-could-not-be-transformed-to-header-crs: " + str(error))

        min_x, min_y, min_z = [float(value) for value in header.mins]
        max_x, max_y, max_z = [float(value) for value in header.maxs]
        units = [axis.get("name") for axis in coordinate_summary.get("horizontalUnits", [])]
        expected_epsg = manifest["coordinateFrameExpectation"].get("inheritedWorkUnitHorizontalEpsg")
        actual_epsg = coordinate_summary.get("horizontalEpsg")
        epsg_matches = actual_epsg == expected_epsg
        if actual_epsg != expected_epsg:
            warnings.append(
                "LAZ horizontal EPSG (" + str(actual_epsg) + ") differs from the inherited work-unit expectation (" + str(expected_epsg) + "); reconcile exact metadata before frame alignment."
            )

        if sample_xy is not None:
            within = min_x <= sample_xy[0] <= max_x and min_y <= sample_xy[1] <= max_y
            if not within:
                blockers.append("sample-gps-point-outside-actual-laz-header-bounds")
        else:
            within = False

        if not coordinate_summary["present"]:
            blockers.append("laz-header-has-no-readable-crs")
        if coordinate_summary.get("verticalName") is None:
            warnings.append("LAZ header has no parsed vertical CRS component; vertical datum is not established by the header.")
        if not units or any(unit not in ("metre", "meter", "metres", "meters") for unit in units[:2]):
            warnings.append("Horizontal axes are not both clearly declared in metres by the parsed CRS.")
        if getattr(header, "point_count", 0) <= 0:
            blockers.append("laz-header-point-count-is-zero")

        radius = 50.0
        radius_sq = radius * radius
        for points in reader.chunk_iterator(CHUNK_SIZE):
            count = len(points)
            total_points_seen += count
            classifications = points.classification
            for cls, n in zip(*__import__("numpy").unique(classifications, return_counts=True)):
                all_classifications[int(cls)] += int(n)
            if sample_xy is not None:
                dx = points.x - sample_xy[0]
                dy = points.y - sample_xy[1]
                local = (dx * dx + dy * dy) <= radius_sq
                local_count = int(local.sum())
                sample_points_seen += local_count
                if local_count:
                    for cls, n in zip(*__import__("numpy").unique(classifications[local], return_counts=True)):
                        sample_classifications[int(cls)] += int(n)

        header_info = {
            "lasVersion": str(header.version),
            "pointFormatId": int(header.point_format.id),
            "pointRecordLength": int(header.point_format.size),
            "pointCountHeader": int(header.point_count),
            "pointCountRead": total_points_seen,
            "scales": [float(value) for value in header.scales],
            "offsets": [float(value) for value in header.offsets],
            "bounds": {
                "min": {"x": min_x, "y": min_y, "z": min_z},
                "max": {"x": max_x, "y": max_y, "z": max_z},
            },
            "vlrCount": len(header.vlrs),
            "evlrCount": int(getattr(header, "number_of_evlrs", 0) or 0),
            "crs": coordinate_summary,
            "samplePointInHeaderCrs": {
                "x": sample_xy[0], "y": sample_xy[1],
                "horizontalEpsgMatchesInheritedWorkUnitExpectation": epsg_matches,
                "withinActualHeaderBounds": within,
                "spatialCheckRole": "point-cloud tile containment preflight only, not a building-identity/survey-control proof",
            } if sample_xy is not None else None,
            "classificationCountsWholeTile": {str(key): value for key, value in sorted(all_classifications.items())},
            "classificationCountsWithin50mOfSamplePoint": {str(key): value for key, value in sorted(sample_classifications.items())},
            "pointsWithin50mOfSamplePoint": sample_points_seen,
            "sampleRadiusM": radius,
        }

    if not sample_classifications.get(6, 0):
        warnings.append("No LAS class 6 (building) points were observed within 50 m of the sample GPS point; inspect imagery/point-cloud alignment and other point classes.")
    if not sample_classifications.get(1, 0) and not sample_classifications.get(6, 0):
        warnings.append("No unclassified/class-1 or building/class-6 points were observed in the 50 m sample radius; building presence remains unconfirmed.")

    if blockers:
        status = "blocked"
    elif not hash_pinned:
        status = "tile-inspected-hash-needs-pinning"
        warnings.append("No upstream SHA-256 was available from TNM; pin the observed first-download digest in the manifest and rerun before claiming repeatable byte verification.")
    else:
        status = "tile-inspected-pinned"

    report = {
        "schemaVersion": "1.0.0",
        "sampleId": manifest["sampleId"],
        "status": status,
        "inspectedAt": datetime.now(timezone.utc).isoformat(),
        "asset": {
            "fileName": dataset["fileName"],
            "downloadUrl": dataset["downloadUrl"],
            "metadataUrl": dataset["metadataUrl"],
            "vendorMetadataUrl": dataset["vendorMetadataUrl"],
            "sourceId": dataset["sourceId"],
            "publicationDate": dataset["publicationDate"],
            "sourceProject": dataset["sourceProject"],
            "workUnit": dataset["workUnit"],
            "tileId": dataset["tileId"],
            "expectedByteSize": expected_size,
            "actualByteSize": stat.st_size,
            "byteSizeMatches": size_matches,
            "expectedSha256": expected_hash,
            "actualSha256": actual_hash,
            "sha256PinnedBeforeRun": hash_pinned,
            "sha256MatchesPinnedValue": hash_matches if hash_pinned else None,
            "licenseDeclaration": dataset["declaredLicense"],
        },
        "tileHeader": header_info,
        "blockers": blockers,
        "warnings": warnings,
        "interpretation": "File bytes/header inspected. This does not independently prove the precise photographed building is represented, does not prove the reference is held-out from fitting, and does not evaluate candidate GLB accuracy.",
        "candidateGlbGenerated": False,
        "independentReferenceVerified": False,
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
    }
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with report_path.open("x", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
            handle.write("\n")
    return report


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect the exact USGS Central Mississippi LAZ tile. The report is evidence only and never approves a model."
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--report")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        report = inspect_laz(Path(args.manifest), Path(args.file), Path(args.report) if args.report else None)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps({
        "status": report["status"],
        "asset": report["asset"],
        "tileHeader": report["tileHeader"],
        "blockers": report["blockers"],
        "warnings": report["warnings"],
        "candidateGlbGenerated": False,
        "independentReferenceVerified": False,
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
    }, indent=2))
    return 0 if report["status"] in ("tile-inspected-hash-needs-pinning", "tile-inspected-pinned") else 2


if __name__ == "__main__":
    raise SystemExit(main())
