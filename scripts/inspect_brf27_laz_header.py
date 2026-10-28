#!/usr/bin/env python3
"""Safely inspect the LAS header and initial VLRs from a bounded HTTP Range.

This script intentionally never downloads an entire LAZ archive. If the origin
does not honor a Range request, it records a blocked result and closes the
response without reading the body.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

SOURCE_URL = (
    "https://zenodo.org/records/15282970/files/"
    "TUM_Downtown_ULS_20241217_manual.laz?download=1"
)
PUBLISHER_MD5 = "37ce114fb348fb28066cc967cde9771d"
MAX_PREFIX_BYTES = 8 * 1024 * 1024
USER_AGENT = "3d-geospatial-platform-BRF28/1.0"


def blocked_report(reason: str, **fields: Any) -> dict[str, Any]:
    report: dict[str, Any] = {
        "schemaVersion": "1.0.0",
        "status": "blocked",
        "reviewStatus": "pending-human-review",
        "reason": reason,
        "sourceUrl": SOURCE_URL,
        "filename": "TUM_Downtown_ULS_20241217_manual.laz",
        "publishedSize": "2.8 GB (displayed on source record)",
        "publisherMd5": PUBLISHER_MD5,
        "maxRangeBytes": MAX_PREFIX_BYTES,
        "fullArchiveDownloaded": False,
        "limitations": [
            "A prefix digest is not a full-file checksum or proof of archive authenticity.",
            "Header/VLR declarations alone do not prove that coordinates are in the required evaluation frame.",
            "Vertical datum/geoid, building identity, asset rights, candidate GLB and held-out accuracy remain unapproved.",
        ],
    }
    report.update(fields)
    return report


def parse_las_prefix(prefix: bytes) -> dict[str, Any]:
    if len(prefix) < 227:
        return {"status": "blocked", "reason": "prefix-too-short-for-las-header", "prefixBytes": len(prefix)}
    if prefix[:4] != b"LASF":
        return {"status": "blocked", "reason": "invalid-las-signature", "prefixBytes": len(prefix)}

    major, minor = prefix[24], prefix[25]
    header_size = struct.unpack_from("<H", prefix, 94)[0]
    point_data_offset = struct.unpack_from("<I", prefix, 96)[0]
    vlr_count = struct.unpack_from("<I", prefix, 100)[0]
    point_format_raw = prefix[104]
    point_format = point_format_raw & 0x3F
    point_record_length = struct.unpack_from("<H", prefix, 105)[0]

    scales = struct.unpack_from("<3d", prefix, 131)
    offsets = struct.unpack_from("<3d", prefix, 155)
    bounds = {
        "maxX": struct.unpack_from("<d", prefix, 179)[0],
        "minX": struct.unpack_from("<d", prefix, 187)[0],
        "maxY": struct.unpack_from("<d", prefix, 195)[0],
        "minY": struct.unpack_from("<d", prefix, 203)[0],
        "maxZ": struct.unpack_from("<d", prefix, 211)[0],
        "minZ": struct.unpack_from("<d", prefix, 219)[0],
    }

    result: dict[str, Any] = {
        "status": "header-parsed",
        "signature": "LASF",
        "lasVersion": f"{major}.{minor}",
        "headerSizeBytes": header_size,
        "pointDataOffsetBytes": point_data_offset,
        "declaredVlrCount": vlr_count,
        "pointFormatRaw": point_format_raw,
        "pointFormat": point_format,
        "compressedFlagFromPointFormatByte": bool(point_format_raw & 0x80),
        "pointRecordLengthBytes": point_record_length,
        "coordinateScale": {"x": scales[0], "y": scales[1], "z": scales[2]},
        "coordinateOffset": {"x": offsets[0], "y": offsets[1], "z": offsets[2]},
        "headerBounds": bounds,
        "vlrs": [],
        "crsEvidence": [],
        "vlrParseStatus": "complete",
        "limitations": [
            "LAS scale/offset values are file-storage metadata; they do not establish a local-to-world transform by themselves.",
            "A CRS missing from the initial VLR area may be stored in EVLRs after point records; this bounded prefix cannot inspect those EVLRs.",
            "A WKT/EPSG declaration needs cross-checking against the source documentation and the exact evaluation-frame policy.",
        ],
    }

    if header_size < 227 or header_size > len(prefix):
        result["vlrParseStatus"] = "blocked-header-size-outside-prefix"
        result["status"] = "header-parsed-vlr-blocked"
        return result
    if point_data_offset > len(prefix):
        # It is valid for points to start after the downloaded prefix; VLRs are
        # still parseable as long as their declared ranges fit in the prefix.
        pass

    cursor = header_size
    for index in range(vlr_count):
        if cursor + 54 > len(prefix):
            result["vlrParseStatus"] = "prefix-ended-before-vlr-header"
            result["status"] = "header-parsed-vlr-partial"
            break
        reserved = struct.unpack_from("<H", prefix, cursor)[0]
        user_id = prefix[cursor + 2:cursor + 18].split(b"\0", 1)[0].decode("ascii", "replace").strip()
        record_id = struct.unpack_from("<H", prefix, cursor + 18)[0]
        payload_len = struct.unpack_from("<H", prefix, cursor + 20)[0]
        description = prefix[cursor + 22:cursor + 54].split(b"\0", 1)[0].decode("ascii", "replace").strip()
        payload_start = cursor + 54
        payload_end = payload_start + payload_len
        entry = {
            "index": index,
            "reserved": reserved,
            "userId": user_id,
            "recordId": record_id,
            "payloadLengthBytes": payload_len,
            "description": description[:200],
            "payloadCaptured": payload_end <= len(prefix),
        }
        result["vlrs"].append(entry)
        if payload_end > len(prefix):
            result["vlrParseStatus"] = "prefix-ended-inside-vlr-payload"
            result["status"] = "header-parsed-vlr-partial"
            break

        payload = prefix[payload_start:payload_end]
        if user_id.casefold() == "lasf_projection":
            if record_id in (2111, 2112):
                wkt = payload.rstrip(b"\0").decode("utf-8", "replace").strip()
                crs_entry = {
                    "userId": user_id,
                    "recordId": record_id,
                    "recordType": "WKT math transform" if record_id == 2111 else "WKT coordinate system",
                    "text": wkt[:5000],
                    "textTruncated": len(wkt) > 5000,
                }
                epsg_codes = sorted(set(re.findall(
                    r"(?:EPSG\s*[:=]\s*|ID\s*\[\s*[\"']EPSG[\"']\s*,\s*|AUTHORITY\s*\[\s*[\"']EPSG[\"']\s*,\s*[\"'])(\d+)",
                    wkt,
                    flags=re.IGNORECASE,
                )))
                crs_entry["epsgCodesFound"] = epsg_codes
                result["crsEvidence"].append(crs_entry)
            elif record_id in (34735, 34736, 34737):
                result["crsEvidence"].append({
                    "userId": user_id,
                    "recordId": record_id,
                    "recordType": {
                        34735: "GeoKeyDirectoryTag",
                        34736: "GeoDoubleParamsTag",
                        34737: "GeoAsciiParamsTag",
                    }[record_id],
                    "payloadLengthBytes": payload_len,
                    "payloadCaptured": True,
                    "payloadPreview": payload[:300].decode("ascii", "replace"),
                })
        cursor = payload_end

    return result


def inspect_urlopen(url: str, opener: Any | None = None) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Range": f"bytes=0-{MAX_PREFIX_BYTES - 1}",
            "Accept-Encoding": "identity",
            "User-Agent": USER_AGENT,
        },
    )
    open_fn = opener or urllib.request.urlopen
    try:
        response = open_fn(request, timeout=45)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return blocked_report("range-request-failed", error=str(exc)[:500])

    with response:
        status_code = getattr(response, "status", None) or response.getcode()
        headers = response.headers
        content_range = headers.get("Content-Range", "")
        content_length = headers.get("Content-Length")
        final_url = response.geturl() if hasattr(response, "geturl") else url

        if status_code != 206:
            # Critical safety rule: never read a 200 full-response body.
            return blocked_report(
                "origin-did-not-honor-range-request",
                httpStatus=status_code,
                contentRange=content_range or None,
                finalUrl=final_url,
            )
        match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", content_range.strip(), re.IGNORECASE)
        if not match:
            return blocked_report(
                "invalid-content-range-header",
                httpStatus=status_code,
                contentRange=content_range or None,
                finalUrl=final_url,
            )
        start, end = int(match.group(1)), int(match.group(2))
        total = int(match.group(3)) if match.group(3) != "*" else None
        if start != 0 or end < start or end >= MAX_PREFIX_BYTES:
            return blocked_report(
                "content-range-outside-bounded-prefix",
                httpStatus=status_code,
                contentRange=content_range,
                finalUrl=final_url,
            )
        if content_length is not None:
            try:
                if int(content_length) > MAX_PREFIX_BYTES:
                    return blocked_report(
                        "range-response-too-large",
                        httpStatus=status_code,
                        contentRange=content_range,
                        contentLength=content_length,
                    )
            except ValueError:
                return blocked_report("invalid-content-length-header", httpStatus=status_code)

        expected_length = end - start + 1
        prefix = response.read(expected_length + 1)
        if len(prefix) != expected_length or len(prefix) > MAX_PREFIX_BYTES:
            return blocked_report(
                "range-body-length-mismatch",
                httpStatus=status_code,
                contentRange=content_range,
                bytesRead=len(prefix),
            )

    parsed = parse_las_prefix(prefix)
    return {
        "schemaVersion": "1.0.0",
        "status": "prefix-inspected" if parsed.get("status", "").startswith("header-parsed") else "blocked",
        "reviewStatus": "pending-human-review",
        "sourceUrl": SOURCE_URL,
        "finalUrl": final_url,
        "filename": "TUM_Downtown_ULS_20241217_manual.laz",
        "publishedSize": "2.8 GB (displayed on source record)",
        "publisherMd5": PUBLISHER_MD5,
        "publisherMd5Verified": False,
        "httpStatus": 206,
        "contentRange": content_range,
        "reportedTotalFileBytes": total,
        "prefixBytes": len(prefix),
        "prefixSha256": hashlib.sha256(prefix).hexdigest(),
        "fullFileSha256": None,
        "fullArchiveDownloaded": False,
        "header": parsed,
        "limitations": [
            "Only an initial HTTP byte range is read. No full archive MD5/SHA-256 is calculated.",
            "No VLR entry or EPSG code is accepted as final until source documentation and LAS/LAZ header semantics are independently reviewed.",
            "This cannot establish a named vertical datum/geoid, candidate-to-reference transform, building identity, asset licence, or held-out accuracy.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=SOURCE_URL, help="URL of a LAS/LAZ file supporting HTTP Range")
    parser.add_argument("--output", default="artifacts/brf28-laz-header/inspection.json")
    args = parser.parse_args()

    result = inspect_urlopen(args.url)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    # A blocked inspection is a legitimate fail-closed outcome. CI tests still
    # enforce that the script doesn't read beyond its configured byte ceiling.
    return 0


if __name__ == "__main__":
    sys.exit(main())
