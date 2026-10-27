#!/usr/bin/env python3
"""Create a derived aerial-image overlay for BRF-18 footprint candidates.

The result is a human-review aid, not an identity classifier or accuracy pass.
Raw imagery and raw footprint geometry are inputs only and must not be uploaded.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from typing import Any

from PIL import Image, ImageDraw, ImageFont
from pyproj import Transformer
from shapely.geometry import Polygon, box, shape
from shapely.ops import transform as transform_geometry

IMAGE_SERVICE = (
    "https://imagery.nationalmap.gov/arcgis/rest/services/"
    "USGSNAIPImagery/ImageServer/exportImage"
)
ATTRIBUTION = (
    "U.S. Geological Survey, National Geospatial Program; "
    "USGS NAIP imagery service (NAIP provided in partnership with USDA FSA)."
)
MAX_INPUT_BYTES = 200 * 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_FEATURES = 20000
HEADER_PX = 58
FOOTER_PX = 52
EPSG_4326_TO_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    raw = path.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError(label + " exceeds the 200 MiB input limit.")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(label + " must be valid UTF-8 JSON.") from error
    if not isinstance(value, dict):
        raise ValueError(label + " must be a JSON object.")
    return value, raw


def validate_bbox_wgs84(raw: Any) -> tuple[float, float, float, float]:
    if not isinstance(raw, list) or len(raw) != 4:
        raise ValueError("bboxWgs84 must be [west, south, east, north].")
    try:
        west, south, east, north = (float(value) for value in raw)
    except (TypeError, ValueError) as error:
        raise ValueError("bboxWgs84 coordinates must be numeric.") from error
    if not all(math.isfinite(value) for value in (west, south, east, north)):
        raise ValueError("bboxWgs84 coordinates must be finite.")
    if not (-180 <= west < east <= 180 and -90 < south < north < 90):
        raise ValueError("bboxWgs84 has invalid bounds.")
    if east - west > 1 or north - south > 1:
        raise ValueError("BRF-19 imagery extent must be no larger than 1 degree per axis.")
    return west, south, east, north


def projected_extent(bbox_wgs84: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    west, south, east, north = bbox_wgs84
    min_x, min_y = EPSG_4326_TO_3857.transform(west, south)
    max_x, max_y = EPSG_4326_TO_3857.transform(east, north)
    extent = (float(min_x), float(min_y), float(max_x), float(max_y))
    if not all(math.isfinite(value) for value in extent) or min_x >= max_x or min_y >= max_y:
        raise ValueError("Projected imagery extent is invalid.")
    return extent


def review_extent_3857(
    bbox_wgs84: tuple[float, float, float, float],
    ept_report: dict[str, Any],
    crosscheck_report: dict[str, Any],
    footprint_payload: dict[str, Any],
    width: int,
    height: int,
) -> tuple[float, float, float, float]:
    """Fit a north-up review extent around the query, AABBs and displayed candidates."""
    base = projected_extent(bbox_wgs84)
    min_x, min_y, max_x, max_y = base
    ept_components = ept_report.get("cameraClusterSpatialProximity", {}).get("components")
    report_components = crosscheck_report.get("components")
    features = footprint_payload.get("features")
    if not isinstance(ept_components, list) or not isinstance(report_components, list):
        raise ValueError("EPT/cross-check component lists are missing.")
    if not isinstance(features, list) or len(features) > MAX_FEATURES:
        raise ValueError("Footprints must be a bounded FeatureCollection.")
    ept_by_id = {}
    for component in ept_components:
        if not isinstance(component, dict) or component.get("componentId") is None:
            raise ValueError("Every EPT component needs a stable componentId.")
        component_id = str(component["componentId"])
        if component_id in ept_by_id:
            raise ValueError("EPT component IDs must be unique.")
        ept_by_id[component_id] = component

    # Include each corresponding elevated-return AABB so none is cut off by the crop.
    for component_report in report_components:
        if not isinstance(component_report, dict):
            raise ValueError("Cross-check component entries must be objects.")
        component_id = str(component_report.get("componentId") or "")
        component = ept_by_id.get(component_id)
        if component is None:
            raise ValueError("Cross-check component does not match the EPT input: " + component_id)
        bounds = component.get("xyBounds")
        if not isinstance(bounds, dict):
            raise ValueError("EPT component AABB must contain xyBounds min/max.")
        low, high = bounds.get("min"), bounds.get("max")
        if not isinstance(low, dict) or not isinstance(high, dict):
            raise ValueError("EPT component AABB must contain xyBounds min/max.")
        aabb = tuple(float(v) for v in (low.get("x"), low.get("y"), high.get("x"), high.get("y")))
        if not all(math.isfinite(v) for v in aabb) or aabb[0] >= aabb[2] or aabb[1] >= aabb[3]:
            raise ValueError("EPT component AABB is invalid.")
        min_x, min_y = min(min_x, aabb[0]), min(min_y, aabb[1])
        max_x, max_y = max(max_x, aabb[2]), max(max_y, aabb[3])

        candidates = component_report.get("candidates")
        if not isinstance(candidates, list):
            raise ValueError("Cross-check candidates must be an array.")
        for candidate in candidates[:3]:
            if not isinstance(candidate, dict):
                raise ValueError("Candidate entries must be objects.")
            index = candidate.get("sourceFeatureIndex")
            if not isinstance(index, int) or index < 0 or index >= len(features):
                raise ValueError("Candidate sourceFeatureIndex does not map to an input footprint feature.")
            feature = features[index]
            if not isinstance(feature, dict) or not isinstance(feature.get("geometry"), dict):
                raise ValueError("Candidate source feature must have a geometry object.")
            actual_id = _feature_id(feature)
            if candidate.get("featureId") is not None and actual_id != str(candidate.get("featureId")):
                raise ValueError("Candidate feature ID does not match sourceFeatureIndex.")
            geometry = shape(feature["geometry"])
            if geometry.geom_type not in ("Polygon", "MultiPolygon") or geometry.is_empty or not geometry.is_valid:
                raise ValueError("Candidate footprint must be a valid Polygon or MultiPolygon.")
            projected = transform_geometry(
                lambda x, y, z=None: EPSG_4326_TO_3857.transform(x, y), geometry
            )
            min_x, min_y = min(min_x, projected.bounds[0]), min(min_y, projected.bounds[1])
            max_x, max_y = max(max_x, projected.bounds[2]), max(max_y, projected.bounds[3])

    dx, dy = max_x - min_x, max_y - min_y
    if dx <= 0 or dy <= 0:
        raise ValueError("Expanded review extent must have positive width and height.")
    padding_x, padding_y = max(8.0, dx * 0.12), max(8.0, dy * 0.12)
    min_x, max_x = min_x - padding_x, max_x + padding_x
    min_y, max_y = min_y - padding_y, max_y + padding_y

    # Fit, never crop, to the requested pixel aspect ratio.
    target_ratio = width / height
    dx, dy = max_x - min_x, max_y - min_y
    current_ratio = dx / dy
    center_x, center_y = (min_x + max_x) / 2, (min_y + max_y) / 2
    if current_ratio < target_ratio:
        dx = dy * target_ratio
        min_x, max_x = center_x - dx / 2, center_x + dx / 2
    else:
        dy = dx / target_ratio
        min_y, max_y = center_y - dy / 2, center_y + dy / 2
    if max_x - min_x > 2000 or max_y - min_y > 2000:
        raise ValueError("Expanded visual-review extent exceeds the 2 km safety bound.")
    return (float(min_x), float(min_y), float(max_x), float(max_y))


def image_request_url(extent_3857: tuple[float, float, float, float], width: int, height: int) -> str:
    if not (128 <= width <= 2048 and 128 <= height <= 2048):
        raise ValueError("Image width and height must be between 128 and 2048 pixels.")
    if width * height > 4_000_000:
        raise ValueError("Image request exceeds the 4-million-pixel safety bound.")
    params = {
        "bbox": ",".join(format(value, ".3f") for value in extent_3857),
        "bboxSR": "3857",
        "imageSR": "3857",
        "size": f"{width},{height}",
        "format": "png32",
        "pixelType": "U8",
        "f": "image",
    }
    return IMAGE_SERVICE + "?" + urlencode(params)


def download_imagery(url: str, timeout_seconds: int = 45) -> bytes:
    request = Request(
        url,
        headers={
            "User-Agent": "3d-geospatial-platform-BRF-19/1.0",
            "Accept": "image/png",
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        declared_length = response.headers.get("Content-Length")
        if declared_length is not None and int(declared_length) > MAX_IMAGE_BYTES:
            raise ValueError("USGS imagery response exceeds the 16 MiB safety limit.")
        content = response.read(MAX_IMAGE_BYTES + 1)
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("USGS imagery response is empty or exceeds the 16 MiB limit.")
    if not content.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("USGS imagery service did not return a PNG image.")
    return content


def load_png(image_bytes: bytes, expected_size: tuple[int, int] | None = None) -> Image.Image:
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            source.verify()
        with Image.open(BytesIO(image_bytes)) as source:
            if source.format != "PNG":
                raise ValueError("Imagery must be encoded as PNG.")
            if expected_size is not None and source.size != expected_size:
                raise ValueError("USGS image dimensions do not match the requested dimensions.")
            if source.width < 128 or source.height < 128:
                raise ValueError("USGS image is too small for visual review.")
            return source.convert("RGB")
    except (OSError, Image.DecompressionBombError) as error:
        raise ValueError("USGS imagery is not a valid safe PNG image.") from error


def map_point_to_pixel(
    x: float,
    y: float,
    extent_3857: tuple[float, float, float, float],
    width: int,
    height: int,
    y_offset: int = HEADER_PX,
) -> tuple[int, int]:
    min_x, min_y, max_x, max_y = extent_3857
    if not all(math.isfinite(value) for value in (x, y)):
        raise ValueError("Map coordinates must be finite.")
    if min_x >= max_x or min_y >= max_y:
        raise ValueError("Map extent must have positive width and height.")
    px = round((x - min_x) / (max_x - min_x) * (width - 1))
    py = y_offset + round((max_y - y) / (max_y - min_y) * (height - 1))
    return px, py


def _feature_id(feature: dict[str, Any]) -> str | None:
    value = feature.get("id")
    if value is None and isinstance(feature.get("properties"), dict):
        value = feature["properties"].get("id")
    return str(value) if value is not None else None


def _project_polygon(feature: dict[str, Any], viewport: Any) -> Any:
    raw_geometry = feature.get("geometry")
    if not isinstance(raw_geometry, dict):
        raise ValueError("Candidate footprint feature has no geometry object.")
    geometry = shape(raw_geometry)
    if geometry.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError("Candidate footprint geometry must be Polygon or MultiPolygon.")
    if geometry.is_empty or not geometry.is_valid:
        raise ValueError("Candidate footprint geometry is empty or invalid.")
    projected = transform_geometry(
        lambda x, y, z=None: EPSG_4326_TO_3857.transform(x, y),
        geometry,
    )
    clipped = projected.intersection(viewport)
    if clipped.is_empty:
        raise ValueError("A ranked candidate footprint lies outside the imagery extent.")
    if clipped.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError("Clipped candidate footprint is not polygonal.")
    return clipped


def _pixel_ring(
    coords: Any,
    extent: tuple[float, float, float, float],
    width: int,
    height: int,
) -> list[tuple[int, int]]:
    return [
        map_point_to_pixel(float(x), float(y), extent, width, height)
        for x, y, *_ in coords
    ]


def _draw_polygon_outline(
    draw: ImageDraw.ImageDraw,
    geometry: Any,
    extent: tuple[float, float, float, float],
    width: int,
    height: int,
    color: tuple[int, int, int],
    line_width: int = 4,
) -> None:
    parts = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    for polygon in parts:
        points = _pixel_ring(polygon.exterior.coords, extent, width, height)
        if len(points) >= 3:
            draw.line(points + [points[0]], fill=color, width=line_width, joint="curve")


def _draw_dashed_box(
    draw: ImageDraw.ImageDraw,
    bounds: tuple[float, float, float, float],
    extent: tuple[float, float, float, float],
    width: int,
    height: int,
    color: tuple[int, int, int],
) -> tuple[int, int]:
    min_x, min_y, max_x, max_y = bounds
    corners = [
        map_point_to_pixel(min_x, max_y, extent, width, height),
        map_point_to_pixel(max_x, max_y, extent, width, height),
        map_point_to_pixel(max_x, min_y, extent, width, height),
        map_point_to_pixel(min_x, min_y, extent, width, height),
    ]
    for start, end in zip(corners, corners[1:] + corners[:1]):
        length = math.hypot(end[0] - start[0], end[1] - start[1])
        if length <= 0:
            continue
        dash_px = 10
        steps = max(1, int(length / dash_px))
        for step in range(0, steps, 2):
            t0 = step / steps
            t1 = min(1.0, (step + 1) / steps)
            p0 = (round(start[0] + (end[0] - start[0]) * t0),
                  round(start[1] + (end[1] - start[1]) * t0))
            p1 = (round(start[0] + (end[0] - start[0]) * t1),
                  round(start[1] + (end[1] - start[1]) * t1))
            draw.line([p0, p1], fill=color, width=3)
    return corners[0]


def _label(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, color: tuple[int, int, int]) -> None:
    font = ImageFont.load_default()
    canvas_width, canvas_height = draw._image.size
    x, y = xy
    x = max(2, min(x, canvas_width - 8))
    y = max(HEADER_PX + 2, min(y, canvas_height - 14))
    box_rect = draw.textbbox((x, y), text, font=font)
    if box_rect[2] + 3 > canvas_width:
        x = max(2, canvas_width - (box_rect[2] - box_rect[0]) - 5)
        box_rect = draw.textbbox((x, y), text, font=font)
    if box_rect[3] + 2 > canvas_height:
        y = max(HEADER_PX + 2, canvas_height - (box_rect[3] - box_rect[1]) - 3)
        box_rect = draw.textbbox((x, y), text, font=font)
    draw.rectangle((box_rect[0] - 2, box_rect[1] - 1, box_rect[2] + 3, box_rect[3] + 2), fill=color)
    draw.text((x, y), text, font=font, fill=(255, 255, 255))


def build_review_artifacts(
    manifest: dict[str, Any],
    ept_report: dict[str, Any],
    crosscheck_report: dict[str, Any],
    footprint_payload: dict[str, Any],
    imagery_bytes: bytes,
    *,
    imagery_url: str,
    input_hashes: dict[str, str],
    width: int = 800,
    height: int = 1400,
    retrieved_at_utc: str | None = None,
) -> tuple[bytes, dict[str, Any]]:
    if manifest.get("schemaVersion") != "1.0.0" or manifest.get("sampleId") != "brf-18-central-mississippi-footprint-crosscheck":
        raise ValueError("Unexpected BRF-18 manifest identity.")
    if crosscheck_report.get("schemaVersion") != "1.0.0" or crosscheck_report.get("sampleId") != manifest["sampleId"]:
        raise ValueError("BRF-18 cross-check report does not match the pinned sample.")
    if crosscheck_report.get("status") != "cross-reference-complete-needs-visual-review":
        raise ValueError("BRF-18 cross-check report is not ready for visual review.")
    identity = crosscheck_report.get("identityReview")
    if not isinstance(identity, dict) or identity.get("sameBuildingIdentityVerified") is not False:
        raise ValueError("Visual review requires identity to remain explicitly unverified.")
    for flag in ("acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"):
        if crosscheck_report.get(flag) is not False:
            raise ValueError("Upstream release flag " + flag + " must remain false.")
    features = footprint_payload.get("features")
    if footprint_payload.get("type") != "FeatureCollection" or not isinstance(features, list) or len(features) > MAX_FEATURES:
        raise ValueError("Footprints must be a bounded GeoJSON FeatureCollection.")
    if not (128 <= width <= 2048 and 128 <= height <= 2048) or width * height > 4_000_000:
        raise ValueError("Visual review raster dimensions exceed the safety bounds.")
    raw_bbox = manifest.get("query", {}).get("bboxWgs84")
    bbox_wgs84 = validate_bbox_wgs84(raw_bbox)
    extent = review_extent_3857(bbox_wgs84, ept_report, crosscheck_report, footprint_payload, width, height)
    base_image = load_png(imagery_bytes, (width, height))
    canvas = Image.new("RGB", (width, height + HEADER_PX + FOOTER_PX), (255, 255, 255))
    canvas.paste(base_image, (0, HEADER_PX))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((10, 8), "BRF-19 | Aerial-image review of footprint candidates", fill=(20, 20, 20), font=font)
    draw.text((10, 25), "Overlay only: candidate polygons and EPT AABBs do not prove building identity.", fill=(50, 50, 50), font=font)
    draw.text((10, 42), "Imagery: USGS NAIP service; imagery acquisition date is not resolved here.", fill=(50, 50, 50), font=font)

    width_px, height_px = base_image.size
    viewport = box(*extent)
    ept_components = ept_report.get("cameraClusterSpatialProximity", {}).get("components")
    report_components = crosscheck_report.get("components")
    if not isinstance(ept_components, list) or not isinstance(report_components, list) or not report_components:
        raise ValueError("EPT/cross-check component lists are missing.")
    ept_by_id: dict[str, dict[str, Any]] = {}
    for component in ept_components:
        if not isinstance(component, dict) or component.get("componentId") is None:
            raise ValueError("Every EPT component needs a stable componentId for visual review.")
        component_id = str(component["componentId"])
        if component_id in ept_by_id:
            raise ValueError("EPT component IDs must be unique.")
        ept_by_id[component_id] = component

    source_components: list[dict[str, Any]] = []
    selected_candidates: list[dict[str, Any]] = []
    candidate_colors = [(220, 45, 55), (0, 150, 210), (205, 145, 0)]
    component_color = (170, 0, 185)
    seen_candidate_keys: set[int] = set()
    # A source feature can rank for more than one component. Draw each unique
    # polygon once using its best observed rank; preserve every component/rank
    # relationship in candidateReview below.
    candidate_best_rank: dict[int, int] = {}
    candidate_ids: dict[int, str | None] = {}
    for report in report_components:
        for rank, candidate in enumerate(report.get("candidates", [])[:3], start=1):
            index = candidate.get("sourceFeatureIndex")
            if not isinstance(index, int) or index < 0 or index >= len(features):
                raise ValueError("Candidate sourceFeatureIndex does not map to an input footprint feature.")
            feature = features[index]
            actual_id = _feature_id(feature) if isinstance(feature, dict) else None
            if candidate.get("featureId") is not None and actual_id != str(candidate.get("featureId")):
                raise ValueError("Candidate feature ID does not match sourceFeatureIndex.")
            candidate_ids[index] = actual_id
            candidate_best_rank[index] = min(rank, candidate_best_rank.get(index, rank))
    feature_labels = {index: "F" + str(position) for position, index in enumerate(sorted(candidate_best_rank), start=1)}
    component_labels = {str(report.get("componentId")): "E" + str(position)
                        for position, report in enumerate(report_components, start=1)}

    for component_report in report_components:
        if not isinstance(component_report, dict):
            raise ValueError("Cross-check component entries must be objects.")
        component_id = str(component_report.get("componentId") or "")
        source_component = ept_by_id.get(component_id)
        if source_component is None:
            raise ValueError("Cross-check component does not match the EPT input: " + component_id)
        bounds = source_component.get("xyBounds")
        low = bounds.get("min") if isinstance(bounds, dict) else None
        high = bounds.get("max") if isinstance(bounds, dict) else None
        if not isinstance(low, dict) or not isinstance(high, dict):
            raise ValueError("EPT component AABB must contain min/max XY coordinates.")
        aabb = (
            float(low.get("x")), float(low.get("y")),
            float(high.get("x")), float(high.get("y")),
        )
        if not all(math.isfinite(value) for value in aabb) or aabb[0] >= aabb[2] or aabb[1] >= aabb[3]:
            raise ValueError("EPT component AABB is invalid.")
        component_box = box(*aabb)
        if component_box.intersects(viewport):
            label_xy = _draw_dashed_box(draw, aabb, extent, width_px, height_px, component_color)
            _label(draw, label_xy, component_labels.get(component_id, "E?"), component_color)
        source_components.append({
            "componentId": component_id,
            "reviewLabel": component_labels.get(component_id),
            "aabbCrs": "EPSG:3857",
            "aabbBounds": list(aabb),
            "aabbIsRoofFootprint": False,
        })

        candidates = component_report.get("candidates")
        if not isinstance(candidates, list):
            raise ValueError("Cross-check candidates must be an array.")
        for rank, candidate in enumerate(candidates[:3], start=1):
            if not isinstance(candidate, dict):
                raise ValueError("Candidate entries must be objects.")
            index = candidate.get("sourceFeatureIndex")
            if not isinstance(index, int) or index < 0 or index >= len(features):
                raise ValueError("Candidate sourceFeatureIndex does not map to an input footprint feature.")
            feature = features[index]
            if not isinstance(feature, dict):
                raise ValueError("Candidate source feature must be an object.")
            actual_id = _feature_id(feature)
            declared_id = candidate.get("featureId")
            if declared_id is not None and actual_id != str(declared_id):
                raise ValueError("Candidate feature ID does not match sourceFeatureIndex.")
            projected = _project_polygon(feature, viewport)
            if index not in seen_candidate_keys:
                best_rank = candidate_best_rank[index]
                _draw_polygon_outline(
                    draw, projected, extent, width_px, height_px,
                    candidate_colors[best_rank - 1], line_width=max(2, 5 - best_rank),
                )
                label_point = map_point_to_pixel(
                    float(projected.centroid.x), float(projected.centroid.y),
                    extent, width_px, height_px,
                )
                _label(draw, label_point, feature_labels[index] + " R" + str(best_rank), candidate_colors[best_rank - 1])
                seen_candidate_keys.add(index)
            selected_candidates.append({
                "componentId": component_id,
                "rank": rank,
                "featureLabel": feature_labels[index],
                "bestObservedRank": candidate_best_rank[index],
                "featureId": actual_id,
                "sourceFeatureIndex": index,
                "distanceToComponentAabbM": candidate.get("distanceToComponentAabbM"),
                "intersectionAreaM2": candidate.get("intersectionAreaM2"),
                "intersectsComponentAabb": candidate.get("intersectsComponentAabb"),
                "humanVisualReviewStatus": "pending",
            })

    # A compact legend and attribution are rendered into the review image.
    footer_y = HEADER_PX + height_px + 7
    draw.line((10, footer_y + 4, 35, footer_y + 4), fill=candidate_colors[0], width=4)
    draw.text((40, footer_y), "F# = candidate; red = best observed rank 1", fill=(20, 20, 20), font=font)
    draw.line((365, footer_y + 4, 390, footer_y + 4), fill=candidate_colors[1], width=4)
    draw.text((395, footer_y), "cyan / amber = ranks 2 / 3", fill=(20, 20, 20), font=font)
    draw.line((10, footer_y + 19, 35, footer_y + 19), fill=component_color, width=3)
    draw.text((40, footer_y + 15), "E# = EPT AABB (not roof outline)", fill=(20, 20, 20), font=font)
    draw.text((10, footer_y + 21), ATTRIBUTION, fill=(40, 40, 40), font=font)

    output = BytesIO()
    canvas.save(output, format="PNG", optimize=True)
    rendered_bytes = output.getvalue()
    if len(rendered_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("Rendered overlay exceeds the 16 MiB artifact safety limit.")
    generated_at = retrieved_at_utc or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    review_report = {
        "schemaVersion": "1.0.0",
        "sampleId": manifest["sampleId"],
        "status": "visual-overlay-generated-needs-human-review",
        "generatedAtUtc": generated_at,
        "evaluationStage": "aerial-image-and-footprint-visual-triage",
        "imagery": {
            "service": "USGS National Map USGSNAIPImagery ImageServer",
            "serviceUrl": IMAGE_SERVICE,
            "requestUrl": imagery_url,
            "sourceCrs": "EPSG:3857",
            "extentCrs": "EPSG:3857",
            "extentBounds": list(extent),
            "extentExpansion": "Expanded to include all displayed candidate polygon bounds and matching EPT AABBs, padded, then aspect-fitted without cropping.",
            "inputQueryExtentBounds": list(projected_extent(bbox_wgs84)),
            "inputBboxWgs84": list(bbox_wgs84),
            "widthPx": width,
            "heightPx": height,
            "sourceSha256": sha256_bytes(imagery_bytes),
            "retrievedAtUtc": generated_at,
            "acquisitionDate": None,
            "attribution": ATTRIBUTION,
            "acquisitionDateLimitation": "The service mosaic request does not establish an exact image acquisition date for this crop.",
        },
        "integrity": {
            **input_hashes,
            "renderedOverlaySha256": sha256_bytes(rendered_bytes),
        },
        "overlay": {
            "eptAabbCount": len(source_components),
            "candidatePolygonCount": len(seen_candidate_keys),
            "candidatePairCount": len(selected_candidates),
            "candidateLabels": {feature_labels[index]: {"sourceFeatureIndex": index, "featureId": candidate_ids.get(index), "bestObservedRank": candidate_best_rank[index]} for index in sorted(candidate_best_rank)},
            "componentLabels": {item["reviewLabel"]: item["componentId"] for item in source_components},
            "candidateRankColors": {"1": "#DC2D37", "2": "#0096D2", "3": "#CD9100"},
            "candidateColorInterpretation": "Each unique source polygon is drawn once using its best observed rank across all EPT components; candidateReview preserves per-component ranks.",
            "componentAabbColor": "#AA00B9",
            "componentAabbInterpretation": "EPSG:3857 projected axis-aligned component bounds; not roof polygons.",
        },
        "components": source_components,
        "candidateReview": selected_candidates,
        "humanReview": {
            "status": "pending-human-review",
            "sameBuildingIdentityVerified": False,
            "reviewer": None,
            "reviewedAtUtc": None,
            "requiredChecks": [
                "Confirm each candidate outline covers the pictured roof/building rather than an adjacent structure.",
                "Confirm the EPT component AABB is spatially associated with the same physical building; do not treat it as a roof footprint.",
                "Record any occlusion, date mismatch, roof-edge ambiguity or imagery resolution limitation.",
                "Use separate survey/reference evidence before computing GLB accuracy.",
            ],
        },
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
        "limitations": [
            "The NAIP mosaic may be from a different capture date than the drone images; the exact crop acquisition date is not resolved.",
            "Visual proximity or overlap is a reviewer aid, not automatic same-building identity verification.",
            "Overture polygons are spatial candidates and may reflect roofs or conflated source geometry, not survey truth.",
            "EPT AABBs are elevated-return cluster bounds and are not actual roof polygons.",
            "This packet does not generate a candidate GLB, independent reference geometry or held-out checkpoints.",
        ],
    }
    return rendered_bytes, review_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--ept-report", required=True)
    parser.add_argument("--footprints", required=True)
    parser.add_argument("--crosscheck-report", required=True)
    parser.add_argument("--output-image", required=True)
    parser.add_argument("--output-report", required=True)
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=1400)
    args = parser.parse_args(argv)
    try:
        manifest, manifest_bytes = read_json(Path(args.manifest), "BRF-18 manifest")
        ept_report, ept_bytes = read_json(Path(args.ept_report), "EPT report")
        footprints, footprint_bytes = read_json(Path(args.footprints), "Overture footprints")
        crosscheck, crosscheck_bytes = read_json(Path(args.crosscheck_report), "BRF-18 cross-check report")
        bbox = validate_bbox_wgs84(manifest.get("query", {}).get("bboxWgs84"))
        extent = review_extent_3857(bbox, ept_report, crosscheck, footprints, args.width, args.height)
        image_url = image_request_url(extent, args.width, args.height)
        imagery_bytes = download_imagery(image_url)
        input_hashes = {
            "manifestSha256": sha256_bytes(manifest_bytes),
            "eptReportSha256": sha256_bytes(ept_bytes),
            "overtureFootprintsSha256": sha256_bytes(footprint_bytes),
            "crosscheckReportSha256": sha256_bytes(crosscheck_bytes),
        }
        overlay_bytes, report = build_review_artifacts(
            manifest, ept_report, crosscheck, footprints, imagery_bytes,
            imagery_url=image_url, input_hashes=input_hashes,
            width=args.width, height=args.height,
        )
        image_path = Path(args.output_image)
        report_path = Path(args.output_report)
        image_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with image_path.open("xb") as handle:
            handle.write(overlay_bytes)
        try:
            with report_path.open("x", encoding="utf-8") as handle:
                handle.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
        except Exception:
            image_path.unlink(missing_ok=True)
            raise
        print(json.dumps({
            "status": report["status"],
            "overlaySha256": report["integrity"]["renderedOverlaySha256"],
            "candidatePolygonCount": report["overlay"]["candidatePolygonCount"],
            "sameBuildingIdentityVerified": False,
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        }, sort_keys=True))
        return 0
    except (OSError, ValueError, TypeError, KeyError, HTTPError, URLError) as error:
        print("BRF-19 visual review preparation failed closed: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
