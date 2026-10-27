#!/usr/bin/env python3
"""Fetch a small, bounded USGS 3DEP EPT subset and inspect nearby point classes."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import tempfile
import time
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ALLOWED_HOSTS = {
    "s3-us-west-2.amazonaws.com",
    "usgs-lidar-public.s3.us-west-2.amazonaws.com",
}
EXPECTED_BASE = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/MN_CentralMissRiver_4_B22/"
NODE_RE = re.compile(r"^(\d+)-(\d+)-(\d+)-(\d+)$")
MAX_METADATA_BYTES = 2_000_000
MAX_DEFAULT_HIERARCHY_BYTES = 12_000_000
MAX_DEFAULT_NODE_BYTES = 10_000_000
MAX_DEFAULT_TOTAL_BYTES = 100_000_000
MAX_DEFAULT_HIERARCHY_DOCUMENTS = 300
MAX_DEFAULT_NODES = 96
USER_AGENT = "3d-geospatial-platform-brf16-ept-inspector/1.0"


def fail(message: str) -> None:
    raise ValueError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_public_ept_url(value: str, base_url: str = EXPECTED_BASE) -> str:
    if not isinstance(value, str):
        fail("EPT URL must be a string.")
    parsed = urlparse(value)
    base = urlparse(base_url)
    if parsed.hostname == base.hostname:
        expected_prefix = base.path
    elif parsed.hostname == "usgs-lidar-public.s3.us-west-2.amazonaws.com":
        expected_prefix = "/MN_CentralMissRiver_4_B22/"
    else:
        expected_prefix = base.path
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_HOSTS
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.query
        or parsed.fragment
        or base.scheme != "https"
        or base.hostname not in ALLOWED_HOSTS
        or not parsed.path.startswith(expected_prefix)
        or ".." in parsed.path.split("/")
    ):
        fail("EPT URL is outside the allowlisted public USGS EPT asset path.")
    return value


def bounded_get(url: str, max_bytes: int, timeout_seconds: int = 25, retries: int = 2) -> bytes:
    validate_public_ept_url(url)
    if not isinstance(max_bytes, int) or max_bytes < 1:
        raise ValueError("max_bytes must be positive.")
    if not isinstance(timeout_seconds, int) or not 1 <= timeout_seconds <= 120:
        raise ValueError("timeout_seconds must be between 1 and 120.")
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            request = Request(url, headers={"Accept": "application/json, application/octet-stream", "User-Agent": USER_AGENT})
            with urlopen(request, timeout=timeout_seconds) as response:
                final_url = response.geturl()
                validate_public_ept_url(final_url)
                status = getattr(response, "status", 200)
                if status != 200:
                    fail("EPT source returned HTTP " + str(status) + ".")
                declared = response.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    fail("EPT response declares " + declared + " bytes, exceeding the configured safety limit.")
                payload = response.read(max_bytes + 1)
                if len(payload) > max_bytes:
                    fail("EPT response exceeded the configured byte limit.")
                return payload
        except HTTPError as error:
            last_error = error
            if error.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
        except (TimeoutError, URLError, OSError) as error:
            last_error = error
            if attempt == retries:
                raise
        if attempt < retries:
            time.sleep(1 + attempt)
    if last_error:
        raise last_error
    fail("EPT download failed with no response.")


def parse_ept_metadata(payload: bytes, expected_horizontal: str = "EPSG:3857") -> dict[str, Any]:
    try:
        value = json.loads(payload)
    except Exception as error:
        raise ValueError("EPT metadata is not valid JSON: " + str(error)) from error
    if not isinstance(value, dict):
        fail("EPT metadata must be a JSON object.")
    # EPT node indices are partitioned against the octree root "bounds";
    # boundsConforming is a tighter data extent and must only be used to test
    # whether a point is within the actual source extent, never for node math.
    raw_tree_bounds = value.get("bounds")
    raw_conforming_bounds = value.get("boundsConforming") or raw_tree_bounds
    if not isinstance(raw_tree_bounds, list) or len(raw_tree_bounds) != 6:
        fail("EPT metadata must include six-dimensional tree bounds.")
    if not isinstance(raw_conforming_bounds, list) or len(raw_conforming_bounds) != 6:
        fail("EPT metadata must include six-dimensional boundsConforming.")
    bounds = [float(item) for item in raw_tree_bounds]
    conforming_bounds = [float(item) for item in raw_conforming_bounds]
    for label, candidate in (("tree bounds", bounds), ("conforming bounds", conforming_bounds)):
        if not all(math.isfinite(item) for item in candidate):
            fail("EPT metadata " + label + " contain a non-finite value.")
        if not (candidate[0] < candidate[3] and candidate[1] < candidate[4] and candidate[2] < candidate[5]):
            fail("EPT " + label + " must have positive extent in X, Y and Z.")
    if not all(
        bounds[axis] <= conforming_bounds[axis] < conforming_bounds[axis + 3] <= bounds[axis + 3]
        for axis in range(3)
    ):
        fail("EPT boundsConforming must be contained within tree bounds.")
    points = value.get("points")
    span = value.get("span")
    if not isinstance(points, int) or points <= 0:
        fail("EPT metadata points must be a positive integer.")
    if not isinstance(span, int) or span < 2:
        fail("EPT metadata span must be an integer of at least 2.")
    data_type = value.get("dataType")
    if data_type not in ("laszip", "binary"):
        fail("EPT dataType must be laszip or binary.")
    srs = value.get("srs")
    if not isinstance(srs, dict):
        fail("EPT metadata is missing its spatial reference object.")
    horizontal = srs.get("horizontal")
    authority = srs.get("authority")
    horizontal_text = str(horizontal).strip() if horizontal is not None else ""
    if authority and horizontal_text.isdigit():
        horizontal_text = str(authority).upper() + ":" + horizontal_text
    if horizontal_text.upper() not in ("3857", "EPSG:3857"):
        fail("EPT horizontal CRS does not match the expected EPSG:3857: " + repr(horizontal_text))
    schema = value.get("schema")
    if not isinstance(schema, list) or not schema:
        fail("EPT schema is missing or empty.")
    dimensions = {str(item.get("name", "")).lower(): item for item in schema if isinstance(item, dict)}
    missing_axes = [axis for axis in ("x", "y", "z") if axis not in dimensions]
    if missing_axes:
        fail("EPT schema is missing coordinate dimensions: " + ", ".join(missing_axes))
    return {
        "raw": value,
        "bounds": bounds,
        "boundsConforming": conforming_bounds,
        "points": points,
        "span": span,
        "dataType": data_type,
        "srs": srs,
        "schema": schema,
        "dimensions": sorted(dimensions),
        "horizontalCrs": horizontal_text.upper() if ":" in horizontal_text else "EPSG:" + horizontal_text,
    }


def parse_node_key(key: str) -> tuple[int, int, int, int]:
    if not isinstance(key, str) or not NODE_RE.fullmatch(key):
        fail("Invalid EPT node key: " + repr(key))
    return tuple(int(item) for item in key.split("-"))  # type: ignore[return-value]


def node_bounds(key: str, root_bounds: list[float]) -> list[float]:
    depth, x, y, z = parse_node_key(key)
    divisions = 2**depth
    if any(index < 0 or index >= divisions for index in (x, y, z)):
        fail("EPT node index lies outside its tree depth: " + key)
    min_x, min_y, min_z, max_x, max_y, max_z = root_bounds
    step_x = (max_x - min_x) / divisions
    step_y = (max_y - min_y) / divisions
    step_z = (max_z - min_z) / divisions
    return [
        min_x + x * step_x,
        min_y + y * step_y,
        min_z + z * step_z,
        min_x + (x + 1) * step_x,
        min_y + (y + 1) * step_y,
        min_z + (z + 1) * step_z,
    ]


def overlaps_xy(bounds: list[float], query_bounds: list[float]) -> bool:
    return bounds[0] <= query_bounds[2] and bounds[3] >= query_bounds[0] and bounds[1] <= query_bounds[3] and bounds[4] >= query_bounds[1]


def node_key_depth(key: str) -> int:
    return parse_node_key(key)[0]


def summarize_unclassified_elevations_above_ground(
    unclassified_xyz: list[tuple[float, float, float]],
    ground_xyz: list[tuple[float, float, float]],
    max_ground_distance_m: float = 12.0,
    grid_cell_size_m: float = 2.0,
) -> dict[str, Any]:
    """Compare LAS class-1 points to nearby class-2 ground returns, without assuming class 1 means buildings."""
    if max_ground_distance_m <= 0 or grid_cell_size_m <= 0:
        raise ValueError("Ground-comparison distance and grid cell size must be positive.")
    cell_size = 5.0
    cells: dict[tuple[int, int], list[tuple[float, float, float]]] = {}
    for x, y, z in ground_xyz:
        key = (math.floor(x / cell_size), math.floor(y / cell_size))
        cells.setdefault(key, []).append((x, y, z))

    search_cells = math.ceil(max_ground_distance_m / cell_size)
    compared: list[tuple[float, float, float, float]] = []
    unmatched = 0
    max_distance_sq = max_ground_distance_m * max_ground_distance_m
    for x, y, z in unclassified_xyz:
        cell_x = math.floor(x / cell_size)
        cell_y = math.floor(y / cell_size)
        nearest: tuple[float, float, float] | None = None
        nearest_distance_sq = max_distance_sq
        for offset_x in range(-search_cells, search_cells + 1):
            for offset_y in range(-search_cells, search_cells + 1):
                for gx, gy, gz in cells.get((cell_x + offset_x, cell_y + offset_y), ()):
                    distance_sq = (gx - x) ** 2 + (gy - y) ** 2
                    if distance_sq <= nearest_distance_sq:
                        nearest_distance_sq = distance_sq
                        nearest = (gx, gy, gz)
        if nearest is None:
            unmatched += 1
            continue
        height_above_ground = z - nearest[2]
        compared.append((x, y, z, height_above_ground))

    heights = sorted(point[3] for point in compared)
    def percentile(values: list[float], fraction: float) -> float | None:
        if not values:
            return None
        return float(values[min(len(values) - 1, max(0, round((len(values) - 1) * fraction)))])

    thresholds: dict[str, Any] = {}
    for threshold in (2.0, 3.0, 5.0, 10.0):
        elevated = [point for point in compared if point[3] >= threshold]
        occupied_cells = {
            (math.floor(point[0] / grid_cell_size_m), math.floor(point[1] / grid_cell_size_m))
            for point in elevated
        }
        thresholds[str(int(threshold))] = {
            "heightThresholdM": threshold,
            "pointCount": len(elevated),
            "occupiedGridCells": len(occupied_cells),
            "gridCellSizeM": grid_cell_size_m,
            "xyzBounds": {
                "min": {
                    "x": min((point[0] for point in elevated), default=None),
                    "y": min((point[1] for point in elevated), default=None),
                    "z": min((point[2] for point in elevated), default=None),
                },
                "max": {
                    "x": max((point[0] for point in elevated), default=None),
                    "y": max((point[1] for point in elevated), default=None),
                    "z": max((point[2] for point in elevated), default=None),
                },
            },
        }
    above_two = thresholds["2"]
    candidate_surface = above_two["pointCount"] >= 25 and above_two["occupiedGridCells"] >= 6
    return {
        "method": "nearest-class2-ground-return-within-radius",
        "groundClass": 2,
        "testedUnclassifiedClass": 1,
        "unclassifiedPointsInsideValidationRadius": len(unclassified_xyz),
        "groundPointsInsideValidationRadiusPlusPadding": len(ground_xyz),
        "pointsComparedToGround": len(compared),
        "pointsWithoutNearbyGround": unmatched,
        "maximumGroundNeighbourDistanceM": max_ground_distance_m,
        "heightAboveNearestGroundM": {
            "min": min(heights) if heights else None,
            "median": percentile(heights, 0.5),
            "p90": percentile(heights, 0.9),
            "p95": percentile(heights, 0.95),
            "max": max(heights) if heights else None,
        },
        "elevatedReturnThresholds": thresholds,
        "potentialElevatedUnclassifiedSurfaceDetected": candidate_surface,
        "interpretation": "Elevated class-1 points may be buildings, trees, vehicles or other above-ground objects. This metric alone cannot identify a building or validate image-to-building correspondence.",
    }


def assess_sample_building_coverage(
    points_within_radius: int,
    classification_counts: dict[int, int] | Counter[int],
    inspected_node_count: int,
    selected_node_count: int,
    elevated_unclassified_summary: dict[str, Any] | None = None,
) -> tuple[list[str], list[str]]:
    """Fail closed only if neither building labels nor a spatially supported elevated surface is present."""
    blockers: list[str] = []
    warnings: list[str] = []
    if points_within_radius <= 0:
        blockers.append("no-point-returns-fall-within-the-sample-radius")
    has_class6 = int(classification_counts.get(6, 0)) > 0
    has_elevated_unclassified = bool(
        elevated_unclassified_summary
        and elevated_unclassified_summary.get("potentialElevatedUnclassifiedSurfaceDetected") is True
    )
    if not has_class6 and not has_elevated_unclassified:
        blockers.append("no-building-label-or-supported-elevated-unclassified-surface-within-sample-radius")
        warnings.append(
            "No class-6 points or spatially supported elevated class-1 surface were detected within the validation radius; this point-cloud neighbourhood is not yet a usable building-surface reference."
        )
    elif not has_class6 and has_elevated_unclassified:
        warnings.append(
            "The source has no class-6 building labels in the checked neighbourhood, but class-1 returns form a spatially supported elevated surface above nearby class-2 ground. It may be a building or vegetation and requires building-footprint/image identity review before it can be accepted."
        )
    if inspected_node_count < selected_node_count:
        blockers.append("one-or-more-selected-ept-nodes-were-not-completely-inspected")
    return sorted(set(blockers)), warnings


def read_manifest(manifest_path: Path) -> dict[str, Any]:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != "1.0.0":
        fail("Manifest must be an object with schemaVersion 1.0.0.")
    if not isinstance(manifest.get("dataset"), dict) or not isinstance(manifest.get("coverage"), dict):
        fail("Manifest dataset and coverage are required.")
    dataset = manifest["dataset"]
    if dataset.get("url") != EXPECTED_BASE + "ept.json":
        fail("Manifest does not point to the pinned official USGS EPT metadata URL.")
    if dataset.get("publicAssetBaseUrl") != EXPECTED_BASE:
        fail("Manifest EPT base URL does not match the allowlisted project prefix.")
    for flag in ("acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"):
        if manifest.get(flag) is not False:
            fail(flag + " must remain false while only reference intake is being checked.")
    sample = manifest["coverage"].get("samplePoint")
    if not isinstance(sample, dict):
        fail("Manifest coverage.samplePoint is required.")
    lon, lat = sample.get("longitude"), sample.get("latitude")
    if not isinstance(lon, (int, float)) or not math.isfinite(lon) or not -180 <= lon <= 180:
        fail("Sample longitude must be finite and within [-180, 180].")
    if not isinstance(lat, (int, float)) or not math.isfinite(lat) or not -85 <= lat <= 85:
        fail("Sample latitude must be finite and within [-85, 85].")
    return manifest


def safe_ept_json(base_url: str, relative_path: str, max_bytes: int, timeout: int) -> tuple[dict[str, Any], bytes]:
    if relative_path.startswith("/") or ".." in relative_path.split("/"):
        fail("EPT relative path is unsafe.")
    url = base_url + relative_path
    validate_public_ept_url(url, base_url)
    payload = bounded_get(url, max_bytes, timeout)
    try:
        decoded = json.loads(payload)
    except Exception as error:
        raise ValueError("EPT JSON at " + relative_path + " is invalid: " + str(error)) from error
    if not isinstance(decoded, dict):
        fail("EPT JSON at " + relative_path + " must be an object.")
    return decoded, payload


def inspect_ept_reference(
    manifest_path: Path,
    report_path: Path | None = None,
    fetch_bytes=bounded_get,
) -> dict[str, Any]:
    manifest = read_manifest(manifest_path)
    dataset = manifest["dataset"]
    coverage = manifest["coverage"]
    config = manifest.get("processing", {})
    base = dataset["publicAssetBaseUrl"]
    timeout = int(config.get("httpTimeoutSeconds", 25))
    max_hier_docs = int(config.get("maxHierarchyDocuments", MAX_DEFAULT_HIERARCHY_DOCUMENTS))
    max_hier_bytes = int(config.get("maxHierarchyBytes", MAX_DEFAULT_HIERARCHY_BYTES))
    max_node_bytes = int(config.get("maxNodeBytes", MAX_DEFAULT_NODE_BYTES))
    max_total_bytes = int(config.get("maxTotalNodeBytes", MAX_DEFAULT_TOTAL_BYTES))
    max_nodes = int(config.get("maxPointNodes", MAX_DEFAULT_NODES))
    target_depth = int(config.get("targetNodeDepth", 8))
    radius = float(coverage.get("sampleRadiusMeters", 50))
    validation_radius = float(coverage.get("validationRadiusMeters", 50))
    raw_radii = coverage.get("diagnosticRadiiMeters", [validation_radius, radius])
    if not isinstance(raw_radii, list) or not raw_radii:
        fail("coverage.diagnosticRadiiMeters must be a non-empty list.")
    diagnostic_radii = sorted({float(value) for value in raw_radii})
    if validation_radius not in diagnostic_radii:
        diagnostic_radii.append(validation_radius)
        diagnostic_radii.sort()
    if not (1 <= max_hier_docs <= 1000 and 1 <= max_nodes <= 1000 and 1 <= target_depth <= 20 and 1 <= radius <= 1000):
        fail("EPT processing bounds fall outside the allowed safety limits.")
    if (
        not (1 <= validation_radius <= radius <= 1000)
        or any(not math.isfinite(value) or value < 1 or value > radius for value in diagnostic_radii)
    ):
        fail("EPT diagnostic radii must be finite, >= 1 metre and no larger than sampleRadiusMeters.")
    expected_metadata_hash = manifest.get("expectedMetadataSha256")
    if expected_metadata_hash is not None and (not isinstance(expected_metadata_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_metadata_hash)):
        fail("expectedMetadataSha256 must be null or 64 lowercase hexadecimal characters.")

    metadata_url = dataset["url"]
    metadata_payload = fetch_bytes(metadata_url, MAX_METADATA_BYTES, timeout)
    metadata_hash = sha256_bytes(metadata_payload)
    if expected_metadata_hash and metadata_hash != expected_metadata_hash:
        fail("EPT metadata SHA-256 does not match the pinned manifest.")
    metadata = parse_ept_metadata(metadata_payload)
    ept = metadata["raw"]
    bounds = metadata["bounds"]  # EPT octree node math uses tree bounds.
    conforming_bounds = metadata["boundsConforming"]  # Actual data extent only.

    try:
        from pyproj import Transformer
        import laspy
        import numpy as np
    except ImportError as error:
        fail("Install runtime dependencies first: pip install 'laspy[lazrs]' pyproj numpy (" + str(error) + ").")

    transformer = Transformer.from_crs("EPSG:4326", metadata["horizontalCrs"], always_xy=True)
    sample = coverage["samplePoint"]
    target_x, target_y = transformer.transform(float(sample["longitude"]), float(sample["latitude"]))
    if not (conforming_bounds[0] <= target_x <= conforming_bounds[3] and conforming_bounds[1] <= target_y <= conforming_bounds[4]):
        out_of_bounds_report = {
            "schemaVersion": "1.0.0",
            "sampleId": manifest["sampleId"],
            "status": "sample-outside-ept-bounds",
            "inspectedAt": datetime.now(timezone.utc).isoformat(),
            "source": {"url": metadata_url, "metadataSha256": metadata_hash, "metadataPinned": bool(expected_metadata_hash)},
            "ept": {"points": metadata["points"], "dataType": metadata["dataType"], "span": metadata["span"], "bounds": bounds, "boundsConforming": conforming_bounds, "srs": metadata["srs"]},
            "samplePoint3857": {"x": target_x, "y": target_y},
            "blockers": ["sample-gps-point-outside-ept-bounds"],
            "warnings": [],
            "nodeReports": [],
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
                json.dump(out_of_bounds_report, handle, indent=2)
                handle.write("\\n")
        return out_of_bounds_report

    query_bounds = [target_x - radius, target_y - radius, target_x + radius, target_y + radius]
    hierarchy_hashes: dict[str, str] = {}
    node_counts: dict[str, int] = {}
    queue = deque(["0-0-0-0"])
    visited_pages: set[str] = set()
    blockers: list[str] = []
    warnings: list[str] = []
    hierarchy_download_bytes = 0
    hierarchy_doc_count = 0
    selected_depth_max = min(target_depth + 2, 20)

    while queue:
        page_key = queue.popleft()
        if page_key in visited_pages:
            continue
        visited_pages.add(page_key)
        if hierarchy_doc_count >= max_hier_docs:
            blockers.append("ept-hierarchy-document-limit-exceeded")
            break
        page, page_bytes = safe_ept_json(
            base, "ept-hierarchy/" + page_key + ".json", min(max_hier_bytes, MAX_METADATA_BYTES * 6), timeout
        )
        hierarchy_doc_count += 1
        hierarchy_download_bytes += len(page_bytes)
        if hierarchy_download_bytes > max_hier_bytes:
            blockers.append("ept-hierarchy-byte-limit-exceeded")
            break
        hierarchy_hashes[page_key] = sha256_bytes(page_bytes)

        for key, raw_count in page.items():
            depth, _, _, _ = parse_node_key(key)
            if not isinstance(raw_count, int) or raw_count < -1:
                blockers.append("invalid-ept-node-count:" + key)
                continue
            node_box = node_bounds(key, bounds)
            if not overlaps_xy(node_box, query_bounds):
                continue
            if raw_count > 0:
                node_counts[key] = raw_count
            if raw_count == -1 and depth < selected_depth_max:
                queue.append(key)

    candidate_nodes = [
        key for key, count in node_counts.items()
        if count > 0 and target_depth <= node_key_depth(key) <= selected_depth_max
        and overlaps_xy(node_bounds(key, bounds), query_bounds)
    ]
    if not candidate_nodes:
        shallower = [
            key for key, count in node_counts.items()
            if count > 0 and node_key_depth(key) < target_depth
            and overlaps_xy(node_bounds(key, bounds), query_bounds)
        ]
        if shallower:
            deepest = max(node_key_depth(key) for key in shallower)
            candidate_nodes = [key for key in shallower if node_key_depth(key) == deepest]
            warnings.append("Only coarser EPT nodes were available at or above target depth; point counts may include wider spatial context.")
        else:
            blockers.append("no-nonempty-ept-point-nodes-intersect-the-sample-neighbourhood")

    def sort_key(key: str) -> tuple[float, int, str]:
        node_box = node_bounds(key, bounds)
        centre_x = (node_box[0] + node_box[3]) / 2
        centre_y = (node_box[1] + node_box[4]) / 2
        distance = math.hypot(centre_x - target_x, centre_y - target_y)
        return (distance, -node_key_depth(key), key)

    candidate_nodes = sorted(set(candidate_nodes), key=sort_key)
    node_limit_exceeded = len(candidate_nodes) > max_nodes
    if node_limit_exceeded:
        blockers.append("ept-point-node-limit-exceeded")
        candidate_nodes = candidate_nodes[:max_nodes]

    node_reports: list[dict[str, Any]] = []
    whole_classes: Counter[int] = Counter()
    ground_padding_m = float(config.get("groundComparisonPaddingMeters", 15.0))
    max_ground_neighbour_m = float(config.get("maxGroundNeighbourDistanceM", 12.0))
    high_return_grid_cell_m = float(config.get("highReturnGridCellSizeM", 2.0))
    if not (1 <= ground_padding_m <= 100 and 1 <= max_ground_neighbour_m <= 50 and 0.5 <= high_return_grid_cell_m <= 10):
        fail("Ground comparison limits fall outside the allowed safety bounds.")
    validation_class1_points: list[tuple[float, float, float]] = []
    validation_ground_points: list[tuple[float, float, float]] = []
    radius_point_counts: dict[float, int] = {value: 0 for value in diagnostic_radii}
    radius_class_counts: dict[float, Counter[int]] = {value: Counter() for value in diagnostic_radii}
    nearest_class6: dict[str, Any] | None = None
    total_points_read = 0
    node_bytes_downloaded = 0
    point_data_suffix = {"laszip": ".laz", "binary": ".bin"}[metadata["dataType"]]
    if metadata["dataType"] != "laszip":
        blockers.append("ept-data-type-is-not-laszip; binary point schema decoding is not enabled")
        candidate_nodes = []

    with tempfile.TemporaryDirectory(prefix="brf16-ept-") as temp:
        root = Path(temp)
        for index, key in enumerate(candidate_nodes):
            relative = "ept-data/" + key + point_data_suffix
            url = base + relative
            node_payload = fetch_bytes(url, max_node_bytes, timeout)
            node_bytes_downloaded += len(node_payload)
            if node_bytes_downloaded > max_total_bytes:
                blockers.append("ept-point-data-download-byte-limit-exceeded")
                break
            digest = sha256_bytes(node_payload)
            file_path = root / (key + point_data_suffix)
            file_path.write_bytes(node_payload)
            with laspy.open(str(file_path), mode="r") as reader:
                point_count = int(reader.header.point_count)
                node_total_classes: Counter[int] = Counter()
                node_radius_counts: dict[float, int] = {value: 0 for value in diagnostic_radii}
                node_radius_classes: dict[float, Counter[int]] = {value: Counter() for value in diagnostic_radii}
                read_points = 0
                for points in reader.chunk_iterator(1_000_000):
                    read_points += len(points)
                    class_values = np.asarray(points.classification)
                    for cls, n in zip(*np.unique(class_values, return_counts=True)):
                        node_total_classes[int(cls)] += int(n)
                        whole_classes[int(cls)] += int(n)
                    xs = np.asarray(points.x)
                    ys = np.asarray(points.y)
                    zs = np.asarray(points.z)
                    dx = xs - target_x
                    dy = ys - target_y
                    distance_sq = dx * dx + dy * dy
                    validation_mask = distance_sq <= validation_radius * validation_radius
                    class1_mask = validation_mask & (class_values == 1)
                    class2_ground_mask = (
                        (distance_sq <= (validation_radius + ground_padding_m) ** 2)
                        & (class_values == 2)
                    )
                    for point_index in np.flatnonzero(class1_mask):
                        validation_class1_points.append((
                            float(xs[point_index]), float(ys[point_index]), float(zs[point_index])
                        ))
                    for point_index in np.flatnonzero(class2_ground_mask):
                        validation_ground_points.append((
                            float(xs[point_index]), float(ys[point_index]), float(zs[point_index])
                        ))
                    class6_indices = np.flatnonzero(class_values == 6)
                    if class6_indices.size:
                        candidate_distances_sq = distance_sq[class6_indices]
                        nearest_index = int(class6_indices[int(np.argmin(candidate_distances_sq))])
                        nearest_distance = float(math.sqrt(float(distance_sq[nearest_index])))
                        if nearest_class6 is None or nearest_distance < nearest_class6["distanceM"]:
                            nearest_class6 = {
                                "distanceM": nearest_distance,
                                "x": float(xs[nearest_index]),
                                "y": float(ys[nearest_index]),
                                "z": float(zs[nearest_index]),
                                "classification": 6,
                                "nodeKey": key,
                            }
                    for diagnostic_radius in diagnostic_radii:
                        within = distance_sq <= diagnostic_radius * diagnostic_radius
                        count_here = int(within.sum())
                        node_radius_counts[diagnostic_radius] += count_here
                        radius_point_counts[diagnostic_radius] += count_here
                        if count_here:
                            for cls, n in zip(*np.unique(class_values[within], return_counts=True)):
                                node_radius_classes[diagnostic_radius][int(cls)] += int(n)
                                radius_class_counts[diagnostic_radius][int(cls)] += int(n)
                total_points_read += read_points
            node_box = node_bounds(key, bounds)
            node_reports.append({
                "nodeKey": key,
                "hierarchyPointCount": node_counts.get(key),
                "observedPointCount": point_count,
                "observedPointsRead": read_points,
                "byteSize": len(node_payload),
                "sha256": digest,
                "bounds": node_box,
                "pointsWithinDiagnosticRadii": {
                    str(int(value) if value.is_integer() else value): node_radius_counts[value]
                    for value in diagnostic_radii
                },
                "classificationCounts": {str(k): v for k, v in sorted(node_total_classes.items())},
                "classificationCountsByDiagnosticRadius": {
                    str(int(value) if value.is_integer() else value): {
                        str(k): v for k, v in sorted(node_radius_classes[value].items())
                    }
                    for value in diagnostic_radii
                },
            })

    local_point_count = radius_point_counts[validation_radius]
    local_classes = radius_class_counts[validation_radius]
    class6 = local_classes.get(6, 0)
    elevated_unclassified_summary = summarize_unclassified_elevations_above_ground(
        validation_class1_points,
        validation_ground_points,
        max_ground_distance_m=max_ground_neighbour_m,
        grid_cell_size_m=high_return_grid_cell_m,
    )
    coverage_blockers, coverage_warnings = assess_sample_building_coverage(
        local_point_count,
        local_classes,
        len(node_reports),
        len(candidate_nodes),
        elevated_unclassified_summary,
    )
    blockers.extend(coverage_blockers)
    warnings.extend(coverage_warnings)

    horizontal = str(metadata["horizontalCrs"])
    vertical_code = metadata["srs"].get("vertical")
    source_report = {
        "url": metadata_url,
        "productId": dataset["sourceProductId"],
        "citation": dataset["citation"],
        "metadataSha256": metadata_hash,
        "metadataSha256Pinned": bool(expected_metadata_hash),
        "metadataBytes": len(metadata_payload),
        "srs": metadata["srs"],
        "horizontalCrs": horizontal,
        "verticalSrsCode": vertical_code,
        "pointDataType": metadata["dataType"],
        "span": metadata["span"],
        "schemaDimensions": metadata["dimensions"],
        "totalPointCountInEpt": metadata["points"],
        "rootBounds": bounds,
        "rootBoundsConforming": conforming_bounds,
    }
    status = "sample-neighbourhood-inspected" if not blockers else "blocked"
    report = {
        "schemaVersion": "1.0.0",
        "sampleId": manifest["sampleId"],
        "status": status,
        "inspectedAt": datetime.now(timezone.utc).isoformat(),
        "source": source_report,
        "samplePoint": {
            "longitude": sample["longitude"],
            "latitude": sample["latitude"],
            "inputCrs": "EPSG:4326",
            "projectedX": target_x,
            "projectedY": target_y,
            "validationRadiusMeters": validation_radius,
            "maximumInspectionRadiusMeters": radius,
            "diagnosticRadiiMeters": diagnostic_radii,
            "samplePointWithinEptRootBounds": True,
            "sourcePointRole": "GPS-derived location query, not an independent surveyed control",
        },
        "counts": {
            "hierarchyDocumentsRead": hierarchy_doc_count,
            "hierarchyBytesRead": hierarchy_download_bytes,
            "hierarchyNodesWithPointCountsInSearchWindow": len(node_counts),
            "selectedPointNodes": len(candidate_nodes),
            "inspectedPointNodes": len(node_reports),
            "nodeDataBytesDownloaded": node_bytes_downloaded,
            "totalPointsReadFromSelectedNodes": total_points_read,
            "pointsWithinValidationRadius": local_point_count,
            "class6BuildingPointsWithinValidationRadius": class6,
            "class6BuildingPointShareWithinValidationRadius": class6 / local_point_count if local_point_count else None,
            "pointsAndClassificationsByDiagnosticRadius": {
                str(int(value) if value.is_integer() else value): {
                    "points": radius_point_counts[value],
                    "classificationCounts": {str(k): v for k, v in sorted(radius_class_counts[value].items())},
                    "class6BuildingPoints": radius_class_counts[value].get(6, 0),
                }
                for value in diagnostic_radii
            },
            "nearestClass6PointInInspectedNodes": nearest_class6,
            "unclassifiedElevatedSurfaceDiagnostics": elevated_unclassified_summary,
        },
        "classificationCountsWithinValidationRadius": {str(k): v for k, v in sorted(local_classes.items())},
        "classificationCountsAcrossInspectedNodes": {str(k): v for k, v in sorted(whole_classes.items())},
        "hierarchyDocumentSha256": hierarchy_hashes,
        "nodeReports": node_reports,
        "blockers": sorted(set(blockers)),
        "warnings": warnings,
        "interpretation": "This is a bounded source-point-cloud preflight. It verifies metadata and reads selected point nodes near the GPS search point; it does not prove image-to-building identity, produce a candidate GLB, solve GPS↔COLMAP registration or evaluate held-out geometry accuracy.",
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
    parser = argparse.ArgumentParser(description="Inspect a bounded neighbourhood of the USGS Central Mississippi EPT point cloud.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--report")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        report = inspect_ept_reference(Path(args.manifest), Path(args.report) if args.report else None)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps({
        "status": report["status"],
        "source": report.get("source"),
        "samplePoint": report.get("samplePoint"),
        "counts": report.get("counts"),
        "classificationCountsWithinSampleRadius": report.get("classificationCountsWithinSampleRadius"),
        "blockers": report.get("blockers", []),
        "warnings": report.get("warnings", []),
        "candidateGlbGenerated": False,
        "independentReferenceVerified": False,
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
    }, indent=2))
    return 0 if report["status"] == "sample-neighbourhood-inspected" else 2


if __name__ == "__main__":
    raise SystemExit(main())
