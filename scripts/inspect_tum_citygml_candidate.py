#!/usr/bin/env python3
"""Verify and inspect one pinned TUM2TWIN CityGML object without publishing raw data."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

PROJECT_ID = 152545
PROJECT_PATH = "tum-gis/tum2twin-datasets"
SOURCE_COMMIT = "e032a71fc9b3c9c3d4869e3aca9677d1234086aa"
CATALOG_PATH = "citygml/lod3-building-datasets"
SNAPSHOT_PATH = "benchmarks/building-reconstruction/brf-30-tum-lod3-catalog-snapshot.json"
ENVELOPE_REPORT_PATH = "benchmarks/building-reconstruction/brf-31-citygml-envelope-screening.json"
CANDIDATE_FILENAME = "DEBY_LOD3_4959323.gml"
CANDIDATE_BLOB_SHA = "2fd72c942399ff0cc78e3478dced74b60180e5dd"
CANDIDATE_LFS_SHA256 = "a7b30f1596683837329e7b674e16d0dada2c98e3640092129d9092479a67ba37"
CANDIDATE_BYTES = 51178520
MAX_FULL_OBJECT_BYTES = 64 * 1024 * 1024
MAX_API_RESPONSE_BYTES = 1024 * 1024
MAX_COORDINATE_TOKENS = 30_000_000
CHUNK_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 45
API_BASE = "https://gitlab.lrz.de/api/v4"
LFS_BATCH_URL = f"https://gitlab.lrz.de/{PROJECT_PATH}.git/info/lfs/objects/batch"
USER_AGENT = "3d-geospatial-platform-BRF33/1.0"
FLOAT_TOKEN = re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?")
GEOMETRY_TAGS = {
    "Building", "BuildingPart", "Polygon", "Triangle", "MultiSurface",
    "CompositeSurface", "Solid", "MultiSolid", "LinearRing", "WallSurface",
    "RoofSurface", "GroundSurface", "Window", "Door", "BuildingInstallation",
    "ClosureSurface", "OuterCeilingSurface", "OuterFloorSurface",
}


def local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1].split(":", 1)[-1]


def attr_local(element: ET.Element, wanted: str) -> str | None:
    for key, value in element.attrib.items():
        if local_name(key) == wanted:
            return value
    return None


def header_value(headers: Any, wanted: str) -> str | None:
    for key, value in headers.items():
        if str(key).lower() == wanted.lower():
            return str(value)
    return None


def blocked(reason: str, **extra: Any) -> dict[str, Any]:
    return {"status": "blocked", "reason": reason, **extra}


def read_pointer(blob_sha: str, opener: Callable[..., Any]) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{40}", blob_sha):
        return blocked("invalid-gitlab-pointer-blob-id")
    url = f"{API_BASE}/projects/{PROJECT_ID}/repository/blobs/{blob_sha}/raw"
    request = urllib.request.Request(url, headers={
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
    })
    try:
        response = opener(request, timeout=TIMEOUT_SECONDS)
    except (urllib.error.URLError, TimeoutError, OSError):
        return blocked("lfs-pointer-request-failed")
    with response:
        status = getattr(response, "status", None) or response.getcode()
        if status != 200:
            return blocked("lfs-pointer-http-status", httpStatus=status)
        declared = header_value(response.headers, "content-length")
        if declared:
            try:
                if int(declared) > MAX_API_RESPONSE_BYTES:
                    return blocked("lfs-pointer-response-too-large")
            except ValueError:
                return blocked("lfs-pointer-invalid-content-length")
        body = response.read(MAX_API_RESPONSE_BYTES + 1)
    if len(body) > MAX_API_RESPONSE_BYTES:
        return blocked("lfs-pointer-response-too-large")
    text = body[:4096].decode("ascii", "replace")
    oid_match = re.search(r"^oid sha256:([0-9a-f]{64})\s*$", text, re.MULTILINE)
    size_match = re.search(r"^size (\d+)\s*$", text, re.MULTILINE)
    if not text.startswith("version https://git-lfs.github.com/spec/v1") or not oid_match or not size_match:
        return blocked("gitlab-blob-is-not-a-valid-lfs-pointer")
    return {
        "status": "pointer-read",
        "oidSha256": oid_match.group(1),
        "declaredBytes": int(size_match.group(1)),
        "pointerBytes": len(body),
        "pointerSha256": hashlib.sha256(body).hexdigest(),
    }


def download_verified_lfs_object(
    blob_sha: str,
    expected_oid: str,
    expected_bytes: int,
    opener: Callable[..., Any] = urllib.request.urlopen,
    max_bytes: int = MAX_FULL_OBJECT_BYTES,
) -> dict[str, Any]:
    """Download only a caller-pinned object under a strict byte ceiling."""
    if not re.fullmatch(r"[0-9a-f]{64}", expected_oid):
        return blocked("expected-lfs-sha256-invalid")
    if expected_bytes <= 0 or expected_bytes > max_bytes:
        return blocked("expected-object-size-outside-download-cap", expectedBytes=expected_bytes, maxBytes=max_bytes)
    pointer = read_pointer(blob_sha, opener)
    if pointer.get("status") != "pointer-read":
        return blocked(pointer.get("reason", "lfs-pointer-unavailable"))
    if pointer["oidSha256"] != expected_oid or pointer["declaredBytes"] != expected_bytes:
        return blocked(
            "lfs-pointer-does-not-match-pinned-catalog",
            pointerSha256=pointer["oidSha256"],
            pointerBytes=pointer["declaredBytes"],
        )

    batch_body = json.dumps({
        "operation": "download",
        "transfers": ["basic"],
        "objects": [{"oid": expected_oid, "size": expected_bytes}],
    }).encode("utf-8")
    batch_request = urllib.request.Request(
        LFS_BATCH_URL,
        data=batch_body,
        method="POST",
        headers={
            "Accept": "application/vnd.git-lfs+json",
            "Content-Type": "application/vnd.git-lfs+json",
            "Accept-Encoding": "identity",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        response = opener(batch_request, timeout=TIMEOUT_SECONDS)
    except (urllib.error.URLError, TimeoutError, OSError):
        return blocked("lfs-batch-request-failed", pointerSha256=pointer["pointerSha256"])
    with response:
        status = getattr(response, "status", None) or response.getcode()
        if status != 200:
            return blocked("lfs-batch-http-status", httpStatus=status, pointerSha256=pointer["pointerSha256"])
        length = header_value(response.headers, "content-length")
        if length:
            try:
                if int(length) > MAX_API_RESPONSE_BYTES:
                    return blocked("lfs-batch-response-too-large")
            except ValueError:
                return blocked("lfs-batch-invalid-content-length")
        batch_bytes = response.read(MAX_API_RESPONSE_BYTES + 1)
    if len(batch_bytes) > MAX_API_RESPONSE_BYTES:
        return blocked("lfs-batch-response-too-large")
    try:
        batch = json.loads(batch_bytes)
        item = next(obj for obj in batch["objects"] if obj.get("oid") == expected_oid)
        action = item["actions"]["download"]
        download_url = action["href"]
        download_headers = {str(k): str(v) for k, v in action.get("header", {}).items()}
    except (ValueError, KeyError, TypeError, StopIteration):
        return blocked("lfs-download-action-missing")
    parsed_url = urllib.parse.urlparse(download_url)
    if parsed_url.scheme != "https" or not parsed_url.netloc:
        return blocked("lfs-download-url-not-https")

    download_headers.setdefault("Accept-Encoding", "identity")
    download_headers.setdefault("User-Agent", USER_AGENT)
    download_request = urllib.request.Request(download_url, headers=download_headers)
    try:
        response = opener(download_request, timeout=TIMEOUT_SECONDS)
    except (urllib.error.URLError, TimeoutError, OSError):
        return blocked("lfs-object-download-failed", pointerSha256=pointer["pointerSha256"])
    chunks: list[bytes] = []
    digest = hashlib.sha256()
    total = 0
    with response:
        status = getattr(response, "status", None) or response.getcode()
        if status != 200:
            # This stage intentionally requests the complete pinned object.
            # A partial/ignored-range response is not treated as complete data.
            return blocked("lfs-full-object-http-status", httpStatus=status)
        final_url = getattr(response, "geturl", lambda: download_url)()
        if urllib.parse.urlparse(final_url).scheme != "https":
            return blocked("lfs-final-url-not-https")
        encoding = header_value(response.headers, "content-encoding")
        if encoding and encoding.lower() not in {"identity"}:
            return blocked("lfs-content-encoding-not-identity")
        declared_length = header_value(response.headers, "content-length")
        if declared_length:
            try:
                declared_size = int(declared_length)
            except ValueError:
                return blocked("lfs-content-length-invalid")
            if declared_size != expected_bytes:
                return blocked("lfs-content-length-mismatch", contentLength=declared_size)
            if declared_size > max_bytes:
                return blocked("lfs-response-exceeds-download-cap")
        while True:
            chunk = response.read(CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > expected_bytes or total > max_bytes:
                return blocked("lfs-response-exceeded-pinned-size-or-cap", bytesRead=total)
            chunks.append(chunk)
            digest.update(chunk)
    actual_sha = digest.hexdigest()
    if total != expected_bytes:
        return blocked("lfs-whole-object-size-mismatch", expectedBytes=expected_bytes, actualBytes=total)
    if actual_sha != expected_oid:
        return blocked("lfs-whole-object-sha256-mismatch", actualSha256=actual_sha, expectedSha256=expected_oid)
    return {
        "status": "verified",
        "payload": b"".join(chunks),
        "actualBytes": total,
        "actualSha256": actual_sha,
        "pointerSha256": pointer["pointerSha256"],
        "pointerBytes": pointer["pointerBytes"],
    }


def _coordinate_dimension(stack: list[ET.Element], element: ET.Element) -> int:
    for ancestor in reversed(stack):
        raw = attr_local(ancestor, "srsDimension")
        if raw:
            try:
                dimension = int(raw)
                if 2 <= dimension <= 4:
                    return dimension
            except ValueError:
                pass
    # CityGML candidate is 3D; when the model omits dimension on a coordinate
    # element, record this as an inference rather than asserting it was declared.
    return 3


def parse_full_citygml(payload: bytes, filename: str = CANDIDATE_FILENAME) -> dict[str, Any]:
    root_info: dict[str, Any] | None = None
    root_ids: list[str] = []
    building_ids: list[str] = []
    srs_names: list[str] = []
    geometry_counts: Counter[str] = Counter()
    axis_min = [math.inf, math.inf, math.inf]
    axis_max = [-math.inf, -math.inf, -math.inf]
    coordinate_tuples = 0
    coordinate_tuples_3d = 0
    coordinate_tokens = 0
    coordinate_text_errors = 0
    inferred_dimension_elements = 0
    stack: list[ET.Element] = []
    parse_error: str | None = None
    try:
        events = ET.iterparse(io.BytesIO(payload), events=("start", "end"))
        for event, element in events:
            tag = local_name(element.tag)
            if event == "start":
                stack.append(element)
                if root_info is None:
                    root_info = {
                        "element": tag,
                        "gmlId": attr_local(element, "id"),
                        "srsName": attr_local(element, "srsName"),
                    }
                srs = attr_local(element, "srsName")
                if srs and srs not in srs_names and len(srs_names) < 40:
                    srs_names.append(srs)
                gml_id = attr_local(element, "id")
                if gml_id and tag in {"CityModel", "Building", "BuildingPart"} and gml_id not in root_ids:
                    if len(root_ids) < 100:
                        root_ids.append(gml_id)
                if gml_id and tag in {"Building", "BuildingPart"} and gml_id not in building_ids:
                    if len(building_ids) < 100:
                        building_ids.append(gml_id)
                if tag in GEOMETRY_TAGS:
                    geometry_counts[tag] += 1
            else:
                if tag in {"posList", "pos"} and element.text:
                    dimension = _coordinate_dimension(stack, element)
                    if not attr_local(element, "srsDimension") and not any(
                        attr_local(ancestor, "srsDimension") for ancestor in stack[:-1]
                    ):
                        inferred_dimension_elements += 1
                    group: list[float] = []
                    for token_match in re.finditer(r"\S+", element.text):
                        token = token_match.group(0)
                        coordinate_tokens += 1
                        if coordinate_tokens > MAX_COORDINATE_TOKENS:
                            parse_error = "coordinate-token-limit-exceeded"
                            break
                        if not FLOAT_TOKEN.fullmatch(token):
                            coordinate_text_errors += 1
                            group.clear()
                            continue
                        try:
                            value = float(token)
                        except ValueError:
                            coordinate_text_errors += 1
                            group.clear()
                            continue
                        if not math.isfinite(value):
                            coordinate_text_errors += 1
                            group.clear()
                            continue
                        group.append(value)
                        if len(group) == dimension:
                            coordinate_tuples += 1
                            if dimension >= 3:
                                coordinate_tuples_3d += 1
                                for axis in range(3):
                                    axis_min[axis] = min(axis_min[axis], group[axis])
                                    axis_max[axis] = max(axis_max[axis], group[axis])
                            group.clear()
                    if group:
                        coordinate_text_errors += 1
                element.clear()
                stack.pop()
                if stack:
                    try:
                        stack[-1].remove(element)
                    except ValueError:
                        pass
                if parse_error:
                    break
    except ET.ParseError:
        parse_error = "malformed-xml-document"
    if parse_error:
        return blocked(
            parse_error,
            fullXmlDocumentValidated=False,
            coordinateTupleCount=coordinate_tuples,
            coordinateTextErrors=coordinate_text_errors,
        )
    bounds = None
    if coordinate_tuples_3d:
        bounds = {
            "minX": axis_min[0], "minY": axis_min[1], "minZ": axis_min[2],
            "maxX": axis_max[0], "maxY": axis_max[1], "maxZ": axis_max[2],
        }
    return {
        "status": "geometry-extracted" if coordinate_tuples_3d else "blocked",
        "reason": None if coordinate_tuples_3d else "no-3d-coordinate-tuples-found",
        "filename": filename,
        "root": root_info,
        "rootGmlIds": root_ids,
        "buildingGmlIds": building_ids,
        "srsNamesObserved": srs_names,
        "geometryCounts": dict(sorted(geometry_counts.items())),
        "coordinateTupleCount": coordinate_tuples,
        "coordinateTupleCount3D": coordinate_tuples_3d,
        "coordinateTokenCount": coordinate_tokens,
        "coordinateTextErrors": coordinate_text_errors,
        "coordinateDimensionInferredForElements": inferred_dimension_elements,
        "coordinateBounds": bounds,
        "fullXmlDocumentValidated": True,
        "fullGeometryPayloadParsed": True,
    }


def load_candidate_pins(snapshot_path: Path, envelope_report_path: Path) -> dict[str, Any]:
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    source = snapshot.get("source", {})
    if source.get("resolvedCommitSha") != SOURCE_COMMIT:
        raise ValueError("Catalog snapshot source commit does not match the pinned BRF-33 revision.")
    files = snapshot.get("inventory", {}).get("files")
    if not isinstance(files, list) or len(files) != 27:
        raise ValueError("Expected exactly 27 pinned CityGML catalog records.")
    candidates = [item for item in files if item.get("filename") == CANDIDATE_FILENAME]
    if len(candidates) != 1:
        raise ValueError("Pinned candidate filename must occur exactly once in the catalog snapshot.")
    candidate = candidates[0]
    if (
        candidate.get("repositoryBlobId") != CANDIDATE_BLOB_SHA
        or candidate.get("path") != f"{CATALOG_PATH}/{CANDIDATE_FILENAME}"
    ):
        raise ValueError("Candidate repository blob/path does not match the explicit BRF-33 pin.")

    screening = json.loads(envelope_report_path.read_text(encoding="utf-8"))
    if screening.get("source", {}).get("commit") != SOURCE_COMMIT:
        raise ValueError("BRF-31 envelope report source commit does not match the pinned revision.")
    models = screening.get("models")
    if not isinstance(models, list) or len(models) != 27:
        raise ValueError("Expected 27 persisted BRF-31 model inspection records.")
    matched = [item for item in models if item.get("filename") == CANDIDATE_FILENAME]
    if len(matched) != 1:
        raise ValueError("Pinned candidate must occur exactly once in the BRF-31 envelope report.")
    model = matched[0]
    if (
        model.get("repositoryBlobId") != CANDIDATE_BLOB_SHA
        or model.get("lfsDeclaredSha256") != CANDIDATE_LFS_SHA256
        or model.get("lfsDeclaredBytes") != CANDIDATE_BYTES
    ):
        raise ValueError("Candidate Git LFS pins do not match the reviewed BRF-31 screening record.")
    return {
        **candidate,
        "lfsDeclaredSha256": model["lfsDeclaredSha256"],
        "lfsDeclaredBytes": model["lfsDeclaredBytes"],
        "screeningPrefixSha256": model.get("prefixSha256"),
        "screeningSrsName": model.get("srsName"),
    }

def inspect_candidate(snapshot_path: Path, envelope_report_path: Path, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    report: dict[str, Any] = {
        "schemaVersion": "1.0.0",
        "evaluationId": "BRF-33-TUM-CITYGML-FULL-GEOMETRY-INSPECTION",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "project": PROJECT_PATH,
            "projectId": PROJECT_ID,
            "commit": SOURCE_COMMIT,
            "path": f"{CATALOG_PATH}/{CANDIDATE_FILENAME}",
            "webUrl": f"https://gitlab.lrz.de/{PROJECT_PATH}/-/blob/{SOURCE_COMMIT}/{CATALOG_PATH}/{CANDIDATE_FILENAME}",
            "repositoryBlobId": CANDIDATE_BLOB_SHA,
            "lfsExpectedSha256": CANDIDATE_LFS_SHA256,
            "lfsExpectedBytes": CANDIDATE_BYTES,
        },
        "candidateStatus": "inspection-only-not-selected",
        "assetRightsReviewStatus": "pending-exact-file-scope-review",
        "coordinateFrameStatus": "source-declared-only-no-transform",
        "sameBuildingVerified": False,
        "platformGeneratedCandidateGlbExists": False,
        "independentHeldOutCheckpointsExist": False,
        "releaseFlags": {
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        },
    }
    try:
        item = load_candidate_pins(snapshot_path, envelope_report_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        report.update({"status": "blocked", "reason": "pinned-catalog-snapshot-invalid", "detail": str(exc)[:200]})
        return report
    downloaded = download_verified_lfs_object(
        item["repositoryBlobId"], CANDIDATE_LFS_SHA256, CANDIDATE_BYTES, opener=opener
    )
    if downloaded.get("status") != "verified":
        report.update({"status": "blocked", "reason": downloaded.get("reason", "full-object-download-blocked")})
        return report
    geometry = parse_full_citygml(downloaded["payload"], CANDIDATE_FILENAME)
    report["byteVerification"] = {
        "status": "whole-object-sha256-and-size-verified",
        "actualBytes": downloaded["actualBytes"],
        "actualSha256": downloaded["actualSha256"],
        "expectedBytes": CANDIDATE_BYTES,
        "expectedSha256": CANDIDATE_LFS_SHA256,
        "gitLfsPointerSha256": downloaded["pointerSha256"],
        "gitLfsPointerBytes": downloaded["pointerBytes"],
    }
    report["geometry"] = geometry
    if geometry.get("status") != "geometry-extracted" or not geometry.get("fullXmlDocumentValidated"):
        report.update({"status": "blocked", "reason": geometry.get("reason", "full-xml-geometry-parse-failed")})
    else:
        report["status"] = "full-object-hash-verified-xml-valid-geometry-extracted"
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", default=SNAPSHOT_PATH)
    parser.add_argument("--output", default="-")
    args = parser.parse_args()
    report = inspect_candidate(Path(args.snapshot))
    output = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output == "-":
        print(output, end="")
    else:
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(output, encoding="utf-8")
        print(json.dumps({
            "status": report.get("status"),
            "reason": report.get("reason"),
            "candidateStatus": report.get("candidateStatus"),
            "actualBytes": (report.get("byteVerification") or {}).get("actualBytes"),
            "coordinateTupleCount": ((report.get("geometry") or {}).get("coordinateTupleCount")),
            "output": str(destination),
        }, indent=2))
    return 0 if report.get("status") == "full-object-hash-verified-xml-valid-geometry-extracted" else 2


if __name__ == "__main__":
    raise SystemExit(main())
