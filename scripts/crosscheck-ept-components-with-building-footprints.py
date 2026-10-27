#!/usr/bin/env python3
"""Cross-reference elevated-return AABBs against a pinned Overture buildings release.

This is spatial triage only. It does not infer same-building identity or validate a GLB.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import Point, box, shape
from shapely.ops import transform as transform_geometry

RELEASE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d+$")
MAX_JSON_BYTES = 200 * 1024 * 1024


def read_json(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    raw = path.read_bytes()
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError(label + " exceeds the 200 MiB input limit.")
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError(label + " must be valid UTF-8 JSON.") from error
    if not isinstance(data, dict):
        raise ValueError(label + " must be a JSON object.")
    return data, raw


def finite_number(value: Any, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(label + " must be numeric.") from error
    if not math.isfinite(number):
        raise ValueError(label + " must be finite.")
    return number


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("schemaVersion") != "1.0.0":
        raise ValueError("Unsupported BRF-18 manifest schemaVersion.")
    if manifest.get("sampleId") != "brf-18-central-mississippi-footprint-crosscheck":
        raise ValueError("Unexpected BRF-18 sampleId.")
    query = manifest.get("query")
    source = manifest.get("footprintSource")
    component_input = manifest.get("componentInput")
    if not isinstance(query, dict) or not isinstance(source, dict) or not isinstance(component_input, dict):
        raise ValueError("Manifest must include query, footprintSource and componentInput objects.")
    if query.get("metricCrs") != "EPSG:26915":
        raise ValueError("This Minnesota sample must use the pinned EPSG:26915 metric CRS.")
    if query.get("maxCandidateDistanceM") != 50.0:
        raise ValueError("maxCandidateDistanceM must remain pinned at 50 metres.")
    if source.get("sourceCrs") != "EPSG:4326" or source.get("featureType") != "building":
        raise ValueError("Overture source CRS and feature type are not the expected values.")
    if component_input.get("componentCrs") != "EPSG:3857":
        raise ValueError("EPT component CRS must match the pinned EPSG:3857 source.")
    bbox_values = query.get("bboxWgs84")
    if not isinstance(bbox_values, list) or len(bbox_values) != 4:
        raise ValueError("bboxWgs84 must contain west, south, east, north.")
    west, south, east, north = [finite_number(value, "bboxWgs84 coordinate") for value in bbox_values]
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("bboxWgs84 has invalid coordinate bounds.")
    max_features = query.get("maximumFeatures")
    if not isinstance(max_features, int) or not 1 <= max_features <= 20000:
        raise ValueError("maximumFeatures must be between 1 and 20000.")
    return manifest


def _component_geometry(component: dict[str, Any], source_to_metric: Transformer) -> tuple[Any, Any, dict[str, Any]]:
    bounds = component.get("xyBounds")
    centroid = component.get("centroidXY")
    if not isinstance(bounds, dict) or not isinstance(centroid, dict):
        raise ValueError("Every EPT component requires xyBounds and centroidXY.")
    low, high = bounds.get("min"), bounds.get("max")
    if not isinstance(low, dict) or not isinstance(high, dict):
        raise ValueError("Each component xyBounds must contain min and max objects.")
    min_x = finite_number(low.get("x"), "component min x")
    min_y = finite_number(low.get("y"), "component min y")
    max_x = finite_number(high.get("x"), "component max x")
    max_y = finite_number(high.get("y"), "component max y")
    cx = finite_number(centroid.get("x"), "component centroid x")
    cy = finite_number(centroid.get("y"), "component centroid y")
    if min_x > max_x or min_y > max_y or min_x == max_x or min_y == max_y:
        raise ValueError("Each component AABB must have positive width and height.")
    source_aabb = box(min_x, min_y, max_x, max_y)
    metric_aabb = transform_geometry(source_to_metric.transform, source_aabb)
    metric_centroid = Point(*source_to_metric.transform(cx, cy))
    if metric_aabb.is_empty or not metric_aabb.is_valid or metric_aabb.area <= 0:
        raise ValueError("Transformed component AABB is invalid.")
    summary = {
        "componentId": str(component.get("componentId") or "unknown-component"),
        "pointCount": component.get("pointCount"),
        "occupiedGridCells": component.get("occupiedGridCells"),
        "componentAabbAreaM2": metric_aabb.area,
        "componentAabbBoundsMetric": [float(value) for value in metric_aabb.bounds],
    }
    return metric_aabb, metric_centroid, summary


def _feature_id(feature: dict[str, Any], index: int) -> tuple[str | None, int]:
    value = feature.get("id")
    if value is None and isinstance(feature.get("properties"), dict):
        value = feature["properties"].get("id")
    return (str(value) if value is not None else None, index)


def build_report(
    manifest: dict[str, Any],
    ept_report: dict[str, Any],
    footprint_payload: dict[str, Any],
    release: str,
    source_hashes: dict[str, str] | None = None,
) -> dict[str, Any]:
    manifest = validate_manifest(manifest)
    if not RELEASE_PATTERN.fullmatch(release):
        raise ValueError("Overture release must have YYYY-MM-DD.N format.")
    declared_release = manifest["footprintSource"].get("release")
    if release != declared_release:
        raise ValueError("Requested Overture release does not match the manifest-pinned release.")
    if footprint_payload.get("type") != "FeatureCollection":
        raise ValueError("Overture download must be a GeoJSON FeatureCollection.")
    features = footprint_payload.get("features")
    if not isinstance(features, list):
        raise ValueError("Overture FeatureCollection must contain a features array.")
    if len(features) > manifest["query"]["maximumFeatures"]:
        raise ValueError("Overture result exceeds the manifest maximum feature count.")
    if ept_report.get("status") != "sample-neighbourhood-inspected":
        raise ValueError("EPT report does not have the expected successful inspection status.")
    camera_proximity = ept_report.get("cameraClusterSpatialProximity")
    if not isinstance(camera_proximity, dict) or not isinstance(camera_proximity.get("components"), list):
        raise ValueError("EPT report is missing cameraClusterSpatialProximity.components.")
    components = camera_proximity["components"]
    if not components:
        raise ValueError("EPT report contains no elevated components to cross-reference.")

    source_to_metric = Transformer.from_crs("EPSG:3857", "EPSG:26915", always_xy=True)
    footprint_to_metric = Transformer.from_crs("EPSG:4326", "EPSG:26915", always_xy=True)
    metric_footprints: list[dict[str, Any]] = []
    skipped_invalid = 0
    skipped_unsupported = 0
    for index, feature in enumerate(features):
        if not isinstance(feature, dict) or not isinstance(feature.get("geometry"), dict):
            skipped_invalid += 1
            continue
        geometry_type = feature["geometry"].get("type")
        if geometry_type not in ("Polygon", "MultiPolygon"):
            skipped_unsupported += 1
            continue
        try:
            raw_geometry = shape(feature["geometry"])
            if raw_geometry.is_empty or not raw_geometry.is_valid or raw_geometry.area <= 0:
                skipped_invalid += 1
                continue
            if any(not math.isfinite(float(value)) for value in raw_geometry.bounds):
                skipped_invalid += 1
                continue
            geometry = transform_geometry(footprint_to_metric.transform, raw_geometry)
            if geometry.is_empty or not geometry.is_valid or geometry.area <= 0:
                skipped_invalid += 1
                continue
        except (TypeError, ValueError, OverflowError):
            skipped_invalid += 1
            continue
        feature_id, source_index = _feature_id(feature, index)
        properties = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        metric_footprints.append({
            "featureId": feature_id,
            "sourceFeatureIndex": source_index,
            "geometry": geometry,
            "properties": properties,
        })

    max_distance = float(manifest["query"]["maxCandidateDistanceM"])
    component_reports: list[dict[str, Any]] = []
    total_candidates = 0
    components_with_intersections = 0
    components_with_candidates = 0
    for component in components:
        aabb, centroid, component_summary = _component_geometry(component, source_to_metric)
        candidates: list[dict[str, Any]] = []
        for footprint in metric_footprints:
            geometry = footprint["geometry"]
            distance_aabb = float(geometry.distance(aabb))
            if distance_aabb > max_distance:
                continue
            intersection_area = float(geometry.intersection(aabb).area)
            footprint_area = float(geometry.area)
            candidate = {
                "featureId": footprint["featureId"],
                "sourceFeatureIndex": footprint["sourceFeatureIndex"],
                "distanceToComponentAabbM": distance_aabb,
                "distanceToElevatedComponentCentroidM": float(geometry.distance(centroid)),
                "intersectsComponentAabb": bool(intersection_area > 0),
                "intersectionAreaM2": intersection_area,
                "componentAabbCoverageRatio": min(1.0, intersection_area / float(aabb.area)),
                "footprintCoverageRatio": min(1.0, intersection_area / footprint_area) if footprint_area else 0.0,
            }
            props = footprint["properties"]
            for key in ("height", "num_floors", "subtype", "class", "sources"):
                value = props.get(key)
                if isinstance(value, (str, int, float, bool)) or value is None:
                    if value is not None:
                        candidate[key] = value
            candidates.append(candidate)
        candidates.sort(key=lambda item: (
            -item["intersectionAreaM2"],
            item["distanceToComponentAabbM"],
            item["distanceToElevatedComponentCentroidM"],
            str(item["featureId"] or ""),
            item["sourceFeatureIndex"],
        ))
        if candidates:
            components_with_candidates += 1
        if any(item["intersectsComponentAabb"] for item in candidates):
            components_with_intersections += 1
        total_candidates += len(candidates)
        component_reports.append({
            **component_summary,
            "cameraViewCountInsideAabb": component.get("cameraViewCountInsideAabb"),
            "cameraViewCountWithinThresholdM": component.get("cameraViewCountWithinThresholdM"),
            "candidateCountWithinDistance": len(candidates),
            "intersectingFootprintCount": sum(1 for item in candidates if item["intersectsComponentAabb"]),
            "candidates": candidates[:20],
            "candidateListTruncated": len(candidates) > 20,
        })

    if not features:
        status = "no-footprints-returned"
    elif not metric_footprints:
        status = "no-valid-footprints"
    elif total_candidates == 0:
        status = "no-footprint-candidates-within-threshold"
    else:
        status = "cross-reference-complete-needs-visual-review"

    query = manifest["query"]
    source = manifest["footprintSource"]
    return {
        "schemaVersion": "1.0.0",
        "sampleId": manifest["sampleId"],
        "status": status,
        "evaluationStage": "independent-footprint-cross-reference-only",
        "generatedAtUtc": None,
        "source": {
            "dataset": source["dataset"],
            "release": release,
            "theme": source["theme"],
            "featureType": source["featureType"],
            "license": source["license"],
            "attribution": source["attribution"],
            "bboxWgs84": query["bboxWgs84"],
            "sourceCrs": source["sourceCrs"],
            "componentSourceCrs": manifest["componentInput"]["componentCrs"],
            "metricCrs": query["metricCrs"],
            "maxCandidateDistanceM": max_distance,
            "footprintDatasetHomepage": source["homepage"],
            "footprintDocumentation": source["documentation"],
        },
        "integrity": source_hashes or {},
        "counts": {
            "sourceFootprintFeatures": len(features),
            "validFootprintFeatures": len(metric_footprints),
            "skippedInvalidFootprints": skipped_invalid,
            "skippedUnsupportedGeometryFeatures": skipped_unsupported,
            "elevatedComponents": len(components),
            "componentsWithFootprintCandidates": components_with_candidates,
            "componentsWithIntersectingFootprints": components_with_intersections,
            "totalFootprintCandidatesWithinThreshold": total_candidates,
        },
        "components": component_reports,
        "interpretation": "Spatial cross-reference only; overlap and proximity rank candidates but do not identify the pictured building.",
        "identityReview": {
            "sameBuildingIdentityVerified": False,
            "candidateGlbGenerated": False,
            "independentReferenceVerified": False,
            "heldOutCheckpointAccuracyVerified": False,
        },
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
        "limitations": manifest.get("limitations", []),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--ept-report", required=True)
    parser.add_argument("--footprints", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    try:
        manifest, manifest_bytes = read_json(Path(args.manifest), "BRF-18 manifest")
        ept_report, ept_bytes = read_json(Path(args.ept_report), "EPT report")
        footprints, footprints_bytes = read_json(Path(args.footprints), "Overture footprints")
        hashes = {
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "eptReportSha256": hashlib.sha256(ept_bytes).hexdigest(),
            "overtureFootprintsSha256": hashlib.sha256(footprints_bytes).hexdigest(),
        }
        report = build_report(manifest, ept_report, footprints, args.release, hashes)
        serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("x", encoding="utf-8") as handle:
                handle.write(serialized)
        else:
            print(serialized, end="")
        print(json.dumps({
            "status": report["status"],
            "counts": report["counts"],
            "acceptanceEligible": report["acceptanceEligible"],
            "sameBuildingIdentityVerified": report["identityReview"]["sameBuildingIdentityVerified"],
        }, sort_keys=True), file=sys.stderr)
        return 0 if report["status"] == "cross-reference-complete-needs-visual-review" else 2
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("BRF-18 cross-check failed closed: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
