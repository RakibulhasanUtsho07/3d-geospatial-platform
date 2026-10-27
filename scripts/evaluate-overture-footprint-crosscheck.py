#!/usr/bin/env python3
"""Cross-check live EPT elevated-return clusters against bounded Overture building polygons.

This is a spatial triage tool, not an identity verdict or survey-accuracy evaluator.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import Point, Polygon, MultiPolygon, box, shape
from shapely.ops import transform, unary_union
from shapely.validation import make_valid


def fail(message: str) -> None:
    raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        fail(f"{label} must be a finite number.")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a finite number.") from error
    if not math.isfinite(number):
        fail(f"{label} must be a finite number.")
    return number


def round_m(value: float | None) -> float | None:
    return round(float(value), 3) if value is not None else None


def polygonal_only(geometry: Any) -> Any:
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry
    if geometry.geom_type == "GeometryCollection":
        polygons = []
        for member in geometry.geoms:
            extracted = polygonal_only(member)
            if extracted is not None and not extracted.is_empty:
                if extracted.geom_type == "Polygon":
                    polygons.append(extracted)
                else:
                    polygons.extend(list(extracted.geoms))
        return unary_union(polygons) if polygons else None
    return None


def feature_identifier(feature: dict[str, Any], geometry_json: str) -> str:
    value = feature.get("id")
    properties = feature.get("properties")
    if value is None and isinstance(properties, dict):
        for key in ("id", "feature_id", "building_id"):
            if properties.get(key) is not None:
                value = properties[key]
                break
    if value is None or str(value).strip() == "":
        value = "geometry-sha256:" + hashlib.sha256(geometry_json.encode("utf-8")).hexdigest()[:20]
    return str(value)[:256]


def compact_properties(properties: Any) -> dict[str, Any]:
    if not isinstance(properties, dict):
        return {}
    keep = ("subtype", "class", "height", "num_floors", "names", "sources", "confidence")
    result: dict[str, Any] = {}
    for key in keep:
        if key not in properties:
            continue
        value = properties[key]
        if isinstance(value, (str, int, float, bool)) or value is None:
            result[key] = value
        elif isinstance(value, list):
            result[key] = value[:4]
        elif isinstance(value, dict):
            result[key] = {str(k): v for k, v in list(value.items())[:6]
                           if isinstance(v, (str, int, float, bool)) or v is None}
    return result


def parse_footprints(
    geojson: dict[str, Any],
    query_bbox: list[float],
    transformer: Transformer,
    max_features: int,
) -> list[dict[str, Any]]:
    if not isinstance(geojson, dict) or geojson.get("type") != "FeatureCollection":
        fail("Footprint input must be a GeoJSON FeatureCollection.")
    features = geojson.get("features")
    if not isinstance(features, list):
        fail("Footprint FeatureCollection must contain a features array.")
    if len(features) > max_features:
        fail(f"Footprint query returned {len(features)} features; cap is {max_features}. Narrow the query before reviewing.")
    # GeoJSON coordinates are WGS 84 longitude/latitude unless a legacy CRS member says otherwise.
    crs = geojson.get("crs")
    if crs is not None:
        crs_text = json.dumps(crs, sort_keys=True).upper()
        if "4326" not in crs_text and "CRS84" not in crs_text:
            fail("Footprint GeoJSON declares a non-WGS84 coordinate reference system.")
    query_west, query_south, query_east, query_north = query_bbox
    query_area = box(query_west, query_south, query_east, query_north)
    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, feature in enumerate(features):
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            fail(f"Footprint feature {index} is not a GeoJSON Feature.")
        geometry_payload = feature.get("geometry")
        if not isinstance(geometry_payload, dict):
            fail(f"Footprint feature {index} has no geometry.")
        try:
            source_geometry = shape(geometry_payload)
        except Exception as error:
            raise ValueError(f"Footprint feature {index} has unparseable geometry.") from error
        if source_geometry.is_empty:
            continue
        if not source_geometry.is_valid:
            source_geometry = make_valid(source_geometry)
        source_geometry = polygonal_only(source_geometry)
        if source_geometry is None or source_geometry.is_empty:
            continue
        # The query may return full polygons extending beyond the requested bbox.
        if not source_geometry.intersects(query_area):
            continue
        geometry_text = json.dumps(geometry_payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
        feature_id = feature_identifier(feature, geometry_text)
        if feature_id in seen_ids:
            fail(f"Duplicate Overture footprint identifier: {feature_id}")
        seen_ids.add(feature_id)
        projected = transform(transformer.transform, source_geometry)
        if projected.is_empty or not projected.is_valid or not math.isfinite(projected.area) or projected.area <= 0:
            continue
        if projected.area > 5_000_000:
            # A single building footprint larger than 5 km² is implausible for this local sample;
            # fail closed rather than let malformed geometry skew candidate ranking.
            fail(f"Implausibly large building footprint {feature_id}: {projected.area:.1f} m².")
        minx, miny, maxx, maxy = projected.bounds
        properties = feature.get("properties") or {}
        results.append({
            "featureId": feature_id,
            "geometry": projected,
            "areaM2": float(projected.area),
            "boundsEpsg3857": [float(minx), float(miny), float(maxx), float(maxy)],
            "properties": compact_properties(properties),
            "sourceFeaturePropertiesHash": hashlib.sha256(
                json.dumps(properties, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
            ).hexdigest(),
        })
    results.sort(key=lambda item: item["featureId"])
    return results


def build_report(
    manifest_path: Path,
    ept_report_path: Path,
    footprints_path: Path,
) -> dict[str, Any]:
    manifest = read_json(manifest_path)
    ept_report = read_json(ept_report_path)
    footprint_geojson = read_json(footprints_path)
    if manifest.get("schemaVersion") != "1.0.0":
        fail("Unsupported BRF-18 manifest schemaVersion.")
    if manifest.get("evaluationStage") != "independent-footprint-spatial-crosscheck-only":
        fail("Manifest evaluationStage does not permit this spatial cross-check.")
    query = manifest.get("query") or {}
    bbox = query.get("bboxWgs84")
    if not isinstance(bbox, list) or len(bbox) != 4:
        fail("Manifest must declare query.bboxWgs84 as [west,south,east,north].")
    west, south, east, north = [finite_number(value, "query.bboxWgs84 coordinate") for value in bbox]
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        fail("Manifest query bbox is invalid.")
    maximum = query.get("maximumFeatures", 5000)
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 20000:
        fail("query.maximumFeatures must be an integer in [1, 20000].")

    if ept_report.get("status") != "sample-neighbourhood-inspected":
        fail("EPT input report is not a successful sample-neighbourhood inspection.")
    horizontal_crs = str((ept_report.get("source") or {}).get("horizontalCrs") or "").upper()
    if horizontal_crs not in ("EPSG:3857", "3857"):
        fail("EPT report horizontal CRS must be EPSG:3857.")
    proximity = ept_report.get("cameraClusterSpatialProximity")
    if not isinstance(proximity, dict):
        fail("EPT report lacks cameraClusterSpatialProximity.")
    camera_views = proximity.get("views")
    components = proximity.get("components")
    if not isinstance(camera_views, list) or not camera_views:
        fail("EPT report must include projected camera views.")
    if not isinstance(components, list) or not components:
        fail("EPT report must include elevated-return components for footprint comparison.")
    for view in camera_views:
        finite_number(view.get("projectedX"), "camera projectedX")
        finite_number(view.get("projectedY"), "camera projectedY")
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    footprints = parse_footprints(footprint_geojson, [west, south, east, north], transformer, maximum)
    if not footprints:
        status = "no-footprints-found"
    else:
        status = "complete-needs-visual-identity-review"

    component_reports: list[dict[str, Any]] = []
    for component in components:
        cid = str(component.get("componentId") or "unknown-component")
        bounds = component.get("xyBounds") or {}
        lower, upper = bounds.get("min") or {}, bounds.get("max") or {}
        minx = finite_number(lower.get("x"), f"{cid} bounds min x")
        miny = finite_number(lower.get("y"), f"{cid} bounds min y")
        maxx = finite_number(upper.get("x"), f"{cid} bounds max x")
        maxy = finite_number(upper.get("y"), f"{cid} bounds max y")
        if minx > maxx or miny > maxy:
            fail(f"{cid} has inverted bounds.")
        component_box = box(minx, miny, maxx, maxy)
        if component_box.area <= 0:
            fail(f"{cid} has a zero-area AABB; cannot calculate overlap fraction.")
        centroid_raw = component.get("centroidXY") or {}
        centroid = Point(
            finite_number(centroid_raw.get("x"), f"{cid} centroid x"),
            finite_number(centroid_raw.get("y"), f"{cid} centroid y"),
        )
        candidates = []
        for footprint in footprints:
            geometry = footprint["geometry"]
            intersection_area = float(component_box.intersection(geometry).area)
            centroid_distance = float(geometry.distance(centroid))
            candidates.append({
                "featureId": footprint["featureId"],
                "intersectionAreaM2": round(intersection_area, 3),
                "componentAabbOverlapFraction": round(intersection_area / component_box.area, 6),
                "footprintOverlapFraction": round(min(1.0, intersection_area / footprint["areaM2"]), 6),
                "componentCentroidToFootprintDistanceM": round_m(centroid_distance),
                "componentCentroidInsideFootprint": bool(geometry.covers(centroid)),
                "footprintAreaM2": round(footprint["areaM2"], 3),
                "properties": footprint["properties"],
            })
        candidates.sort(key=lambda item: (
            -item["componentAabbOverlapFraction"],
            item["componentCentroidToFootprintDistanceM"],
            item["featureId"],
        ))
        component_reports.append({
            "componentId": cid,
            "elevatedPointCount": component.get("pointCount"),
            "occupiedGridCells": component.get("occupiedGridCells"),
            "eptComponentAabbEpsg3857": [minx, miny, maxx, maxy],
            "eptAabbAreaM2": round(component_box.area, 3),
            "candidatesRankedByAabbOverlapThenCentroidDistance": candidates[:5],
            "bestCandidateOverlapFraction": candidates[0]["componentAabbOverlapFraction"] if candidates else 0.0,
            "candidateFootprintIntersectsComponentAabb": bool(candidates and candidates[0]["intersectionAreaM2"] > 0),
        })

    camera_reports: list[dict[str, Any]] = []
    for view in camera_views:
        camera_point = Point(
            finite_number(view.get("projectedX"), "camera projectedX"),
            finite_number(view.get("projectedY"), "camera projectedY"),
        )
        distances = [{
            "featureId": footprint["featureId"],
            "distanceCameraPointToFootprintM": round_m(float(footprint["geometry"].distance(camera_point))),
            "cameraPointInsideFootprint": bool(footprint["geometry"].covers(camera_point)),
            "properties": footprint["properties"],
        } for footprint in footprints]
        distances.sort(key=lambda item: (item["distanceCameraPointToFootprintM"], item["featureId"]))
        camera_reports.append({
            "viewId": view.get("viewId"),
            "filename": view.get("filename"),
            "nearestFootprints": distances[:3],
            "interpretation": "Camera GPS is the camera centre, not the observed building point; these distances are not identity evidence.",
        })

    footprint_summaries = [{
        "featureId": item["featureId"],
        "areaM2": round(item["areaM2"], 3),
        "boundsEpsg3857": [round(value, 3) for value in item["boundsEpsg3857"]],
        "properties": item["properties"],
        "sourceFeaturePropertiesHash": item["sourceFeaturePropertiesHash"],
    } for item in footprints]

    return {
        "schemaVersion": "1.0.0",
        "sampleId": manifest["sampleId"],
        "status": status,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "footprints": {
                "name": (manifest.get("source") or {}).get("name"),
                "release": (manifest.get("source") or {}).get("release"),
                "schemaVersion": (manifest.get("source") or {}).get("schemaVersion"),
                "featureType": (manifest.get("source") or {}).get("featureType"),
                "license": (manifest.get("source") or {}).get("license"),
                "attribution": (manifest.get("source") or {}).get("attribution"),
                "coordinateReferenceSystem": "assumed OGC:CRS84 per GeoJSON; reprojected to EPSG:3857",
                "queryBboxWgs84": bbox,
                "manifestSha256": sha256_file(manifest_path),
                "inputGeoJsonSha256": sha256_file(footprints_path),
                "inputGeoJsonBytes": footprints_path.stat().st_size,
                "validPolygonFeatureCount": len(footprints),
            },
            "ept": {
                "reportSha256": sha256_file(ept_report_path),
                "sourceMetadataSha256": (ept_report.get("source") or {}).get("metadataSha256"),
                "horizontalCrs": horizontal_crs,
                "sameBuildingIdentityVerified": False,
            },
            "cameraSourceManifestSha256": (
                ((proximity.get("sourceManifest") or {}).get("manifestSha256"))
            ),
        },
        "counts": {
            "cameraViewsCompared": len(camera_reports),
            "elevatedComponentsCompared": len(component_reports),
            "queriedFootprintFeatures": len(footprint_geojson.get("features", [])),
            "validPolygonFootprints": len(footprints),
            "componentsWithAnyFootprintAabbOverlap": sum(1 for item in component_reports
                if item["candidateFootprintIntersectsComponentAabb"]),
            "componentsWithCentroidInsideFootprint": sum(1 for item in component_reports
                if item["candidatesRankedByAabbOverlapThenCentroidDistance"]
                and item["candidatesRankedByAabbOverlapThenCentroidDistance"][0]["componentCentroidInsideFootprint"]),
        },
        "components": component_reports,
        "cameraViews": camera_reports,
        "footprints": footprint_summaries,
        "limitations": [
            "Overture footprint polygons are secondary map data, not independently surveyed geometry.",
            "Intersection uses an EPT elevated-return component's axis-aligned bounding box, not the actual point-cluster polygon or a reconstructed mesh.",
            "A footprint overlap can arise from trees, adjacent structures, stale footprints or coarse cluster bounds; it does not establish that the photographed building is the same object.",
            "Camera GPS positions are camera centres; their proximity to a footprint does not prove what the camera sees.",
            "This cross-check does not generate a candidate GLB, establish GPS-to-COLMAP registration, or produce held-out metric accuracy.",
            "The sample is in Minnesota and must not be interpreted as a Dhaka building accuracy result.",
        ],
        "sameBuildingIdentityVerified": False,
        "candidateGlbGenerated": False,
        "independentReferenceVerified": False,
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--ept-report", required=True)
    parser.add_argument("--footprints", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args(argv)
    try:
        report = build_report(Path(args.manifest), Path(args.ept_report), Path(args.footprints))
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with report_path.open("x", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, allow_nan=False)
            handle.write("\n")
        print(json.dumps({
            "status": report["status"],
            "sampleId": report["sampleId"],
            "counts": report["counts"],
            "sources": {
                "footprintRelease": report["sources"]["footprints"]["release"],
                "validPolygonFeatureCount": report["sources"]["footprints"]["validPolygonFeatureCount"],
                "inputGeoJsonSha256": report["sources"]["footprints"]["inputGeoJsonSha256"],
                "eptReportSha256": report["sources"]["ept"]["reportSha256"],
            },
            "releaseFlags": {
                "acceptanceEligible": report["acceptanceEligible"],
                "publicationEligible": report["publicationEligible"],
                "mapReady": report["mapReady"],
                "automaticApproval": report["automaticApproval"],
            },
        }, indent=2))
        return 0 if report["status"] == "complete-needs-visual-identity-review" else 2
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"BRF-18 footprint cross-check failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
