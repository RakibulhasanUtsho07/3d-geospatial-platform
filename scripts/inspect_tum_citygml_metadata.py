#!/usr/bin/env python3
"""Inspect pinned CityGML metadata from bounded prefixes; never download full models."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

PROJECT_ID = 152545
PROJECT_PATH = "tum-gis/tum2twin-datasets"
GITLAB_HOST = "https://gitlab.lrz.de"
API_BASE = f"{GITLAB_HOST}/api/v4"
LFS_BATCH_URL = f"{GITLAB_HOST}/{PROJECT_PATH}.git/info/lfs/objects/batch"
EXPECTED_SOURCE_COMMIT = "e032a71fc9b3c9c3d4869e3aca9677d1234086aa"
DEFAULT_SNAPSHOT = "benchmarks/building-reconstruction/brf-30-tum-lod3-catalog-snapshot.json"
USER_AGENT = "3d-geospatial-platform-BRF31/1.0"
MAX_PREFIX_BYTES = 128 * 1024
MAX_API_RESPONSE_BYTES = 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 30
MAX_FILES = 27
ULS_BOUNDS = {
    "minX": 690787.9737446384,
    "maxX": 691169.3342446384,
    "minY": 5335827.531815179,
    "maxY": 5336383.198915179,
    "minZ": 530.5947850988182,
    "maxZ": 606.4985850988182,
}


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].split(":", 1)[-1]


def attribute_by_local_name(element: ET.Element, name: str) -> str | None:
    for key, value in element.attrib.items():
        if local_name(key) == name:
            return value
    return None


def parse_corner(text: str | None) -> list[float] | None:
    if not text:
        return None
    try:
        values = [float(part) for part in text.replace(",", " ").split()]
    except ValueError:
        return None
    if len(values) < 2 or any(not (value == value and abs(value) != float("inf")) for value in values):
        return None
    return values


def parse_lfs_pointer(prefix: bytes) -> dict[str, Any] | None:
    text = prefix[:1024].decode("ascii", "replace")
    if not text.startswith("version https://git-lfs.github.com/spec/v1"):
        return None
    oid = re.search(r"^oid sha256:([0-9a-f]{64})\s*$", text, re.MULTILINE)
    size = re.search(r"^size (\d+)\s*$", text, re.MULTILINE)
    if not oid or not size:
        return {"status": "invalid-lfs-pointer", "pointerText": text[:500]}
    return {"status": "lfs-pointer", "oidSha256": oid.group(1), "declaredObjectBytes": int(size.group(1))}


def parse_citygml_prefix(prefix: bytes, filename: str) -> dict[str, Any]:
    pointer = parse_lfs_pointer(prefix)
    if pointer:
        return pointer
    safe_end = prefix.rfind(b">")
    if safe_end < 0:
        return {"status": "blocked", "reason": "no-complete-xml-tag-in-prefix", "prefixBytes": len(prefix)}

    parser = ET.XMLPullParser(events=("start", "end"))
    parser_errors: list[str] = []
    xml_bytes = prefix[:safe_end + 1]
    try:
        parser.feed(xml_bytes)
    except ET.ParseError as exc:
        # A bounded prefix commonly ends mid-document. Keep any complete events
        # already parsed, but do not treat a malformed prefix as a full XML pass.
        parser_errors.append(str(exc)[:300])

    root_element: dict[str, Any] | None = None
    srs_names: list[str] = []
    root_gml_ids: list[str] = []
    building_gml_ids: list[str] = []
    envelopes: list[dict[str, Any]] = []
    envelope_stack: list[dict[str, Any]] = []
    complete_events = 0

    try:
        events = list(parser.read_events())
    except ET.ParseError as exc:
        events = []
        parser_errors.append(str(exc)[:300])

    for event, element in events:
        complete_events += 1
        tag = local_name(element.tag)
        srs_name = attribute_by_local_name(element, "srsName")
        if event == "start":
            gml_id = attribute_by_local_name(element, "id")
            if srs_name and srs_name not in srs_names:
                srs_names.append(srs_name)
            if root_element is None:
                root_element = {
                    "element": tag,
                    "gmlId": gml_id,
                    "srsName": srs_name,
                    "attributes": {local_name(k): v for k, v in element.attrib.items()},
                }
            if gml_id and tag in {"CityModel", "Building", "BuildingPart"}:
                if gml_id not in root_gml_ids:
                    root_gml_ids.append(gml_id)
                if tag in {"Building", "BuildingPart"} and gml_id not in building_gml_ids:
                    building_gml_ids.append(gml_id)
            if tag == "Envelope":
                envelope_stack.append({
                    "srsName": srs_name,
                    "srsDimension": attribute_by_local_name(element, "srsDimension"),
                    "lowerCorner": None,
                    "upperCorner": None,
                    "complete": False,
                })
        elif event == "end":
            if tag in {"lowerCorner", "upperCorner"} and envelope_stack:
                key = "lowerCorner" if tag == "lowerCorner" else "upperCorner"
                envelope_stack[-1][key] = parse_corner(element.text)
            elif tag == "Envelope" and envelope_stack:
                envelope = envelope_stack.pop()
                envelope["complete"] = bool(envelope["lowerCorner"] and envelope["upperCorner"])
                if envelope["complete"]:
                    envelopes.append(envelope)
            # Clear only after using the text/attributes for the current event.
            element.clear()

    model_id = re.search(r"DEBY_LOD3_(\d+)\.gml$", filename, re.IGNORECASE)
    result: dict[str, Any] = {
        "status": "metadata-prefix-parsed" if root_element else "blocked",
        "reason": None if root_element else "xml-root-not-found-in-prefix",
        "filename": filename,
        "filenameLdbvId": model_id.group(1) if model_id else None,
        "root": root_element,
        "rootGmlIds": root_gml_ids[:50],
        "buildingGmlIds": building_gml_ids[:50],
        "srsNamesObserved": srs_names[:30],
        "envelopes": envelopes[:10],
        "prefixXmlBytesParsed": len(xml_bytes),
        "completeXmlEvents": complete_events,
        "parserNotes": parser_errors[:5],
        "fullXmlDocumentValidated": False,
    }
    if not envelopes:
        result["envelopeStatus"] = "not-found-in-bounded-prefix"
    else:
        env = envelopes[0]
        lower, upper = env["lowerCorner"], env["upperCorner"]
        result["envelopeStatus"] = "found-in-prefix"
        result["firstEnvelope"] = env
        result["horizontalOverlapWithUlsHeaderBounds"] = compare_xy_bounds(
            lower, upper, env.get("srsName"), ULS_BOUNDS
        )
    return result


def compare_xy_bounds(
    lower: list[float] | None,
    upper: list[float] | None,
    srs_name: str | None,
    uls_bounds: dict[str, float],
) -> dict[str, Any]:
    if not lower or not upper or len(lower) < 2 or len(upper) < 2:
        return {"status": "not-comparable", "reason": "missing-envelope-coordinates"}
    crs_text = srs_name or ""
    epsgs = sorted(set(re.findall(r"(?<!\d)(?:EPSG(?::|/|::)|::)(25832|32632)(?!\d)", crs_text, re.IGNORECASE)))
    if not epsgs:
        epsgs = sorted(set(re.findall(r"(?<!\d)(25832|32632)(?!\d)", crs_text)))
    if not epsgs:
        return {"status": "not-comparable", "reason": "envelope-srsname-not-recognized", "srsName": srs_name}
    min_x, max_x = sorted((lower[0], upper[0]))
    min_y, max_y = sorted((lower[1], upper[1]))
    overlaps = not (
        max_x < uls_bounds["minX"] or min_x > uls_bounds["maxX"] or
        max_y < uls_bounds["minY"] or min_y > uls_bounds["maxY"]
    )
    if "32632" in epsgs:
        status = "same-crs-label-overlap-only" if overlaps else "same-crs-label-no-xy-overlap"
    else:
        status = "different-datum-grid-overlap-needs-transform" if overlaps else "different-datum-grid-no-xy-overlap"
    return {
        "status": status,
        "srsName": srs_name,
        "epsgCodesRecognized": epsgs,
        "envelopeMinX": min_x,
        "envelopeMaxX": max_x,
        "envelopeMinY": min_y,
        "envelopeMaxY": max_y,
        "ulsHeaderMinX": uls_bounds["minX"],
        "ulsHeaderMaxX": uls_bounds["maxX"],
        "ulsHeaderMinY": uls_bounds["minY"],
        "ulsHeaderMaxY": uls_bounds["maxY"],
        "xyEnvelopeOverlap": overlaps,
        "transformApplied": False,
        "sameBuildingProven": False,
        "caution": "An XY envelope overlap is only a discovery signal, not proof of same-building identity, correct transformation, vertical registration, or accuracy.",
    }


def bounded_range_get(
    url: str,
    extra_headers: dict[str, str] | None = None,
    opener: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    headers = {
        "Range": f"bytes=0-{MAX_PREFIX_BYTES - 1}",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
    }
    if extra_headers:
        headers.update(extra_headers)
    request = urllib.request.Request(url, headers=headers)
    open_fn = opener or urllib.request.urlopen
    try:
        response = open_fn(request, timeout=REQUEST_TIMEOUT_SECONDS)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"status": "blocked", "reason": "range-request-failed", "error": str(exc)[:300]}

    with response:
        status_code = getattr(response, "status", None) or response.getcode()
        response_headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
        if status_code != 206:
            # Never read a response body if Range was not honored.
            return {
                "status": "blocked",
                "reason": "origin-did-not-honor-range-request",
                "httpStatus": status_code,
            }
        content_range = response_headers.get("content-range", "")
        match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", content_range.strip(), re.IGNORECASE)
        if not match:
            return {"status": "blocked", "reason": "invalid-content-range", "httpStatus": status_code}
        start, end = int(match.group(1)), int(match.group(2))
        total = int(match.group(3)) if match.group(3) != "*" else None
        if start != 0 or end < start or end >= MAX_PREFIX_BYTES:
            return {"status": "blocked", "reason": "range-outside-byte-ceiling", "contentRange": content_range}
        expected_length = end - start + 1
        declared_length = response_headers.get("content-length")
        if declared_length:
            try:
                if int(declared_length) != expected_length:
                    return {
                        "status": "blocked",
                        "reason": "content-length-does-not-match-content-range",
                        "contentRange": content_range,
                        "contentLength": declared_length,
                    }
            except ValueError:
                return {"status": "blocked", "reason": "invalid-content-length", "contentRange": content_range}
        body = response.read(expected_length)
        if len(body) != expected_length or len(body) > MAX_PREFIX_BYTES:
            return {
                "status": "blocked",
                "reason": "range-body-length-mismatch",
                "contentRange": content_range,
                "bytesRead": len(body),
            }
        return {
            "status": "range-read",
            "httpStatus": status_code,
            "contentRange": content_range,
            "reportedTotalFileBytes": total,
            "prefixBytes": len(body),
            "prefixSha256": hashlib.sha256(body).hexdigest(),
            "body": body,
        }


def small_api_request(
    url: str,
    method: str,
    headers: dict[str, str],
    body: bytes | None = None,
    opener: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=headers, data=body, method=method)
    open_fn = opener or urllib.request.urlopen
    try:
        response = open_fn(request, timeout=REQUEST_TIMEOUT_SECONDS)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"status": "blocked", "reason": "api-request-failed", "error": str(exc)[:300]}
    with response:
        status_code = getattr(response, "status", None) or response.getcode()
        if status_code != 200:
            return {"status": "blocked", "reason": "api-non-200", "httpStatus": status_code}
        length_header = response.headers.get("Content-Length")
        if length_header:
            try:
                if int(length_header) > MAX_API_RESPONSE_BYTES:
                    return {"status": "blocked", "reason": "api-response-too-large"}
            except ValueError:
                return {"status": "blocked", "reason": "api-content-length-invalid"}
        payload = response.read(MAX_API_RESPONSE_BYTES + 1)
        if len(payload) > MAX_API_RESPONSE_BYTES:
            return {"status": "blocked", "reason": "api-response-too-large"}
        return {"status": "ok", "body": payload}


def get_model_prefix(path: str, opener: Callable[..., Any] | None = None) -> dict[str, Any]:
    quoted_path = urllib.parse.quote(path, safe="")
    raw_url = (
        f"{API_BASE}/projects/{PROJECT_ID}/repository/files/{quoted_path}/raw"
        f"?ref={EXPECTED_SOURCE_COMMIT}"
    )
    first = bounded_range_get(raw_url, opener=opener)
    if first.get("status") != "range-read":
        return {
            "status": "blocked",
            "reason": first.get("reason", "raw-prefix-read-failed"),
            "httpStatus": first.get("httpStatus"),
            "sourceUrl": raw_url,
        }
    pointer = parse_lfs_pointer(first["body"])
    if not pointer or pointer.get("status") != "lfs-pointer":
        return {
            **first,
            "sourceMethod": "gitlab-repository-files-raw",
            "lfsObject": None,
            "sourceUrl": raw_url,
        }

    # Resolve only the signed LFS download URL; raw model bytes remain bounded.
    batch_headers = {
        "Accept": "application/vnd.git-lfs+json",
        "Content-Type": "application/vnd.git-lfs+json",
        "User-Agent": USER_AGENT,
    }
    batch_body = json.dumps({
        "operation": "download",
        "transfers": ["basic"],
        "objects": [{"oid": pointer["oidSha256"], "size": pointer["declaredObjectBytes"]}],
    }).encode("utf-8")
    batch = small_api_request(LFS_BATCH_URL, "POST", batch_headers, batch_body, opener=opener)
    if batch.get("status") != "ok":
        return {
            "status": "blocked",
            "reason": "lfs-batch-request-failed",
            "lfsObject": pointer,
            "sourceUrl": raw_url,
        }
    try:
        payload = json.loads(batch["body"])
        item = payload["objects"][0]
        action = item["actions"]["download"]
        download_url = action["href"]
        download_headers = {str(k): str(v) for k, v in action.get("header", {}).items()}
    except (ValueError, KeyError, TypeError, IndexError):
        return {
            "status": "blocked",
            "reason": "lfs-download-action-missing",
            "lfsObject": pointer,
            "sourceUrl": raw_url,
        }
    parsed_url = urllib.parse.urlparse(download_url)
    if parsed_url.scheme != "https" or not parsed_url.netloc:
        return {
            "status": "blocked",
            "reason": "lfs-download-url-not-https",
            "lfsObject": pointer,
            "sourceUrl": raw_url,
        }
    result = bounded_range_get(download_url, extra_headers=download_headers, opener=opener)
    if result.get("status") != "range-read":
        return {
            "status": "blocked",
            "reason": "lfs-range-read-failed",
            "lfsObject": pointer,
            "lfsHttpStatus": result.get("httpStatus"),
            "lfsError": result.get("reason"),
            "sourceUrl": raw_url,
        }
    result["sourceMethod"] = "git-lfs-batch-download-range"
    result["lfsObject"] = {
        "oidSha256Declared": pointer["oidSha256"],
        "declaredObjectBytes": pointer["declaredObjectBytes"],
        "fullObjectHashVerified": False,
    }
    result["sourceUrl"] = raw_url
    return result


def inspect_one_model(file_record: dict[str, Any], opener: Callable[..., Any] | None = None) -> dict[str, Any]:
    path = file_record["path"]
    filename = file_record["filename"]
    fetched = get_model_prefix(path, opener=opener)
    base: dict[str, Any] = {
        "filename": filename,
        "path": path,
        "repositoryBlobId": file_record.get("repositoryBlobId"),
        "pinnedCommit": EXPECTED_SOURCE_COMMIT,
        "payloadDownloadedInFull": False,
        "buildingIdentityVerified": False,
        "assetRightsReviewed": False,
    }
    if fetched.get("status") != "range-read":
        return {
            **base,
            "status": "blocked",
            "reason": fetched.get("reason"),
            "httpStatus": fetched.get("httpStatus"),
            "sourceMethod": fetched.get("sourceMethod"),
            "lfsObject": fetched.get("lfsObject"),
        }

    prefix = fetched["body"]
    parsed = parse_citygml_prefix(prefix, filename)
    return {
        **base,
        "status": parsed.get("status"),
        "reason": parsed.get("reason"),
        "sourceMethod": fetched.get("sourceMethod"),
        "contentRange": fetched.get("contentRange"),
        "reportedTotalFileBytes": fetched.get("reportedTotalFileBytes"),
        "prefixBytes": fetched.get("prefixBytes"),
        "prefixSha256": fetched.get("prefixSha256"),
        "lfsObject": fetched.get("lfsObject"),
        "metadata": parsed,
    }


def load_snapshot(path: Path) -> dict[str, Any]:
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    source = snapshot.get("source", {})
    if source.get("resolvedCommitSha") != EXPECTED_SOURCE_COMMIT:
        raise ValueError("Snapshot source commit does not match BRF-31's pinned source revision.")
    files = snapshot.get("inventory", {}).get("files")
    if not isinstance(files, list) or len(files) != MAX_FILES:
        raise ValueError(f"Expected exactly {MAX_FILES} entries in the pinned GML catalog snapshot.")
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("Snapshot contains an invalid file record.")
        if not item["path"].startswith("citygml/lod3-building-datasets/"):
            raise ValueError("Snapshot contains a path outside the pinned LOD3 catalog.")
        if not item["path"].endswith(".gml"):
            raise ValueError("Snapshot contains a non-GML path in the GML catalog.")
        if not re.fullmatch(r"[0-9a-f]{40}", str(item.get("repositoryBlobId", ""))):
            raise ValueError("Snapshot contains a malformed GitLab blob ID.")
    return snapshot


def inspect_catalog(snapshot_path: Path, inspector: Callable[[dict[str, Any]], dict[str, Any]] = inspect_one_model) -> dict[str, Any]:
    snapshot = load_snapshot(snapshot_path)
    files = snapshot["inventory"]["files"]
    results = []
    # Keep concurrency modest: every request is bounded and pinned to one commit.
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(inspector, item) for item in files]
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except Exception as exc:  # A single failed model must not erase other per-file outcomes.
                results.append({
                    "status": "blocked",
                    "reason": "unhandled-inspection-error",
                    "error": str(exc)[:300],
                    "buildingIdentityVerified": False,
                    "assetRightsReviewed": False,
                    "payloadDownloadedInFull": False,
                })
    results.sort(key=lambda item: str(item.get("path", item.get("filename", ""))).casefold())
    status_counts: dict[str, int] = {}
    overlap_status_counts: dict[str, int] = {}
    for item in results:
        status = str(item.get("status", "unknown"))
        status_counts[status] = status_counts.get(status, 0) + 1
        comparison = (item.get("metadata") or {}).get("horizontalOverlapWithUlsHeaderBounds") or {}
        comp_status = comparison.get("status")
        if comp_status:
            overlap_status_counts[comp_status] = overlap_status_counts.get(comp_status, 0) + 1

    candidate_candidates = [
        item["filename"] for item in results
        if (((item.get("metadata") or {}).get("horizontalOverlapWithUlsHeaderBounds") or {})
            .get("status") in {
                "same-crs-label-overlap-only",
                "different-datum-grid-overlap-needs-transform",
            })
    ]
    return {
        "schemaVersion": "1.0.0",
        "evaluationId": "BRF-31-CITYGML-BOUNDED-METADATA",
        "status": "metadata-probe-completed-pending-human-review",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "project": PROJECT_PATH,
            "projectId": PROJECT_ID,
            "resolvedCommitSha": EXPECTED_SOURCE_COMMIT,
            "catalogPath": snapshot["source"]["catalogPath"],
            "sourceLicenseFileSha256": snapshot["source"]["licenseFileSha256"],
            "sourceLicenseScopeReview": "pending-human-review",
        },
        "probePolicy": {
            "maxPrefixBytesPerModel": MAX_PREFIX_BYTES,
            "maxApiMetadataBytes": MAX_API_RESPONSE_BYTES,
            "maxConcurrentModels": 4,
            "modelCount": len(files),
            "fullCityGmlPayloadDownloaded": False,
            "fullFileHashesVerified": False,
        },
        "ulsHeaderBoundsForDiscoveryOnly": ULS_BOUNDS,
        "inventorySummary": {
            "modelsProbed": len(results),
            "statusCounts": status_counts,
            "xyOverlapCounts": overlap_status_counts,
            "possibleCoarseOverlapCandidates": candidate_candidates,
        },
        "models": results,
        "buildingSelection": {
            "status": "not-selected",
            "buildingId": "",
            "gmlId": "",
            "sameBuildingLinkageVerified": False,
            "note": "XY envelope overlap is a discovery lead only and is not building identity evidence.",
        },
        "releaseFlags": {
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        },
        "limitations": [
            "The prefix SHA-256 covers only the retrieved prefix; no full model digest is calculated.",
            "If the repository stores GML files with Git LFS, the report may note the LFS object's declared SHA-256/size, but the full object digest is not verified.",
            "The XML parser processes complete events in a bounded prefix and does not validate the complete XML document or all polygons/meshes.",
            "An XY envelope comparison is performed without transforming coordinates. EPSG:25832 and EPSG:32632 must not be treated as identical merely because both use UTM zone 32N.",
            "No vertical transform is applied; the model repository guide's EPSG:7837 height setting is only contextual evidence, not a verified per-file vertical reference.",
            "No selected model is accepted; asset licence scope, same-building identity, candidate GLB and independent held-out controls remain pending.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", default=DEFAULT_SNAPSHOT)
    parser.add_argument("--output", default="artifacts/brf31-citygml-metadata/metadata.json")
    args = parser.parse_args()
    result = inspect_catalog(Path(args.snapshot))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": result["status"],
        "pinnedSourceCommit": result["source"]["resolvedCommitSha"],
        "modelsProbed": result["inventorySummary"]["modelsProbed"],
        "statusCounts": result["inventorySummary"]["statusCounts"],
        "xyOverlapCounts": result["inventorySummary"]["xyOverlapCounts"],
        "buildingSelection": result["buildingSelection"]["status"],
        "releaseFlags": result["releaseFlags"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
