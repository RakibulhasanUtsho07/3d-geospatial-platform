#!/usr/bin/env python3
"""Create a metadata-only inventory of the public TUM2TWIN LOD3 CityGML catalog.

The script pins the GitLab main branch to one commit, traverses the tree via
the GitLab REST API, and fetches only the small LICENSE file. It never downloads
GML/CityGML/model payloads and never selects a building automatically.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

PROJECT_ID = 152545
PROJECT_PATH = "tum-gis/tum2twin-datasets"
BRANCH = "main"
TREE_PATH = "citygml/lod3-building-datasets"
API_BASE = "https://gitlab.lrz.de/api/v4"
PROJECT_WEB_URL = "https://gitlab.lrz.de/tum-gis/tum2twin-datasets"
LICENSE_PATH = "LICENSE"
USER_AGENT = "3d-geospatial-platform-BRF30/1.0"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_TREE_PAGES = 50


def http_get(url: str, timeout: int = 25) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, headers={
        "Accept": "application/json, text/plain;q=0.9, */*;q=0.1",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(response.status)
            headers = {str(k): str(v) for k, v in response.headers.items()}
            declared = headers.get("Content-Length")
            if declared:
                try:
                    if int(declared) > MAX_RESPONSE_BYTES:
                        return 413, headers, b""
                except ValueError:
                    pass
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                return 413, headers, b""
            return status, headers, body
    except urllib.error.HTTPError as exc:
        body = exc.read(min(MAX_RESPONSE_BYTES, 4096))
        return int(exc.code), {str(k): str(v) for k, v in exc.headers.items()}, body
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, {}, str(exc).encode("utf-8", "replace")[:4096]


def build_url(path: str, params: dict[str, Any] | None = None) -> str:
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    return url


def blocked_report(reason: str, **extra: Any) -> dict[str, Any]:
    report = {
        "schemaVersion": "1.0.0",
        "status": "blocked",
        "reviewStatus": "pending-human-review",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "projectId": PROJECT_ID,
        "projectPath": PROJECT_PATH,
        "projectWebUrl": PROJECT_WEB_URL,
        "catalogPath": TREE_PATH,
        "branchRequested": BRANCH,
        "reason": reason,
        "modelPayloadsDownloaded": False,
        "buildingSelection": {"status": "not-selected", "buildingId": "", "gmlId": ""},
        "releaseFlags": {
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        },
        "limitations": [
            "This inventory reads repository metadata only; it does not download or inspect GML/CityGML model payloads.",
            "A path/name is not proof of a building's real-world identity, geometric correctness, or same-building linkage to the ULS and imagery.",
            "The repository LICENSE text is recorded as source evidence but its scope over model data and any external products still requires human interpretation.",
        ],
    }
    report.update(extra)
    return report


def inspect_catalog(
    fetch: Callable[[str], tuple[int, dict[str, str], bytes]] = lambda url: http_get(url),
) -> dict[str, Any]:
    branch_url = build_url(f"/projects/{PROJECT_ID}/repository/branches/{urllib.parse.quote(BRANCH, safe='')}")
    status, _headers, body = fetch(branch_url)
    if status != 200:
        return blocked_report("gitlab-branch-lookup-failed", httpStatus=status, responsePreview=body[:500].decode("utf-8", "replace"))
    try:
        branch_info = json.loads(body)
        commit = branch_info["commit"]
        commit_sha = str(commit["id"])
    except (ValueError, KeyError, TypeError):
        return blocked_report("gitlab-branch-response-invalid", responsePreview=body[:500].decode("utf-8", "replace"))

    if len(commit_sha) < 40 or any(ch not in "0123456789abcdefABCDEF" for ch in commit_sha):
        return blocked_report("gitlab-commit-sha-invalid", commitId=commit_sha)

    files: list[dict[str, Any]] = []
    page_summaries: list[dict[str, Any]] = []
    next_page = "1"
    seen_pages: set[str] = set()
    while next_page:
        if next_page in seen_pages:
            return blocked_report("gitlab-pagination-loop", commitId=commit_sha, pages=page_summaries)
        if len(page_summaries) >= MAX_TREE_PAGES:
            return blocked_report("gitlab-tree-page-limit-exceeded", commitId=commit_sha, pages=page_summaries)
        seen_pages.add(next_page)
        tree_url = build_url(
            f"/projects/{PROJECT_ID}/repository/tree",
            {
                "path": TREE_PATH,
                "ref": commit_sha,
                "recursive": "true",
                "per_page": 100,
                "page": next_page,
            },
        )
        tree_status, tree_headers, tree_body = fetch(tree_url)
        if tree_status != 200:
            return blocked_report(
                "gitlab-tree-query-failed",
                commitId=commit_sha,
                httpStatus=tree_status,
                failedPage=next_page,
                pages=page_summaries,
                responsePreview=tree_body[:500].decode("utf-8", "replace"),
            )
        try:
            entries = json.loads(tree_body)
        except ValueError:
            return blocked_report("gitlab-tree-json-invalid", commitId=commit_sha, failedPage=next_page)
        if not isinstance(entries, list):
            return blocked_report("gitlab-tree-response-not-list", commitId=commit_sha, failedPage=next_page)
        if len(entries) > 100:
            return blocked_report("gitlab-tree-page-exceeds-requested-size", commitId=commit_sha, failedPage=next_page)

        page_summaries.append({"page": next_page, "entryCount": len(entries)})
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            path = entry.get("path")
            if not isinstance(path, str) or not path.startswith(TREE_PATH + "/"):
                continue
            if entry.get("type") != "blob":
                continue
            name = path.rsplit("/", 1)[-1]
            if name.casefold().endswith((".gml", ".xml", ".citygml")):
                files.append({
                    "path": path,
                    "filename": name,
                    "extension": name.rsplit(".", 1)[-1].casefold(),
                    "repositoryBlobId": entry.get("id"),
                    "webUrl": PROJECT_WEB_URL + "/-/blob/" + commit_sha + "/" + urllib.parse.quote(path, safe="/"),
                    "payloadDownloaded": False,
                    "buildingIdentityVerified": False,
                    "assetRightsReviewed": False,
                })
        next_page = tree_headers.get("X-Next-Page", "").strip()

    # Fetch only the small root LICENSE file; no CityGML/model payload is fetched.
    license_url = build_url(
        f"/projects/{PROJECT_ID}/repository/files/{urllib.parse.quote(LICENSE_PATH, safe='')}/raw",
        {"ref": commit_sha},
    )
    lic_status, _lic_headers, lic_body = fetch(license_url)
    license_text = lic_body.decode("utf-8", "replace") if lic_status == 200 else ""
    license_lines = [line.strip() for line in license_text.splitlines() if line.strip()]
    license_digest = hashlib.sha256(lic_body).hexdigest() if lic_status == 200 else None

    files.sort(key=lambda item: item["path"].casefold())
    gml_files = [item for item in files if item["extension"] == "gml"]
    prefixes: dict[str, int] = {}
    for item in gml_files:
        prefix = item["filename"].split("_", 1)[0]
        prefixes[prefix] = prefixes.get(prefix, 0) + 1

    return {
        "schemaVersion": "1.0.0",
        "status": "catalog-inventoried-pending-file-review",
        "reviewStatus": "pending-human-review",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "project": {
            "id": PROJECT_ID,
            "path": PROJECT_PATH,
            "webUrl": PROJECT_WEB_URL,
            "requestedBranch": BRANCH,
            "resolvedCommitSha": commit_sha,
            "commitShortId": commit.get("short_id"),
            "committedDate": commit.get("committed_date"),
            "catalogPath": TREE_PATH,
        },
        "pagination": {
            "maxPages": MAX_TREE_PAGES,
            "pagesRead": len(page_summaries),
            "pageSummaries": page_summaries,
        },
        "inventory": {
            "treeEntriesMatched": len(files),
            "gmlCityGmlFiles": len(gml_files),
            "otherXmlFiles": len(files) - len(gml_files),
            "filenamePrefixCounts": prefixes,
            "files": files,
        },
        "licenseFileEvidence": {
            "path": LICENSE_PATH,
            "httpStatus": lic_status,
            "sha256": license_digest,
            "firstLines": license_lines[:30],
            "retrievedTextLength": len(license_text),
            "interpretation": "source-file-only; scope over model data or external assets requires human review",
        },
        "modelPayloadsDownloaded": False,
        "buildingSelection": {
            "status": "not-selected",
            "buildingId": "",
            "gmlId": "",
            "candidateGmlPaths": [item["path"] for item in gml_files],
            "sameBuildingLinkageVerified": False,
        },
        "releaseFlags": {
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        },
        "limitations": [
            "This inventory is pinned to the resolved GitLab commit and repository tree only.",
            "A filename and repository blob ID do not prove a unique real-world building identity; the actual GML payload and its building identifiers/coordinates have not been downloaded.",
            "The source repository's LICENSE content is retained as evidence but is not automatically interpreted as authorizing all external assets, image archive files, or the separate Zenodo ULS dataset.",
            "The TUM campus building must still be mapped to a selected UAS image subset, corresponding ULS crop, and a specific reference-model identity before benchmark eligibility.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="artifacts/brf30-tum-lod3-catalog/catalog.json")
    args = parser.parse_args()
    report = inspect_catalog()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": report.get("status"),
        "projectCommit": report.get("project", {}).get("resolvedCommitSha"),
        "gmlCityGmlFiles": report.get("inventory", {}).get("gmlCityGmlFiles"),
        "pagesRead": report.get("pagination", {}).get("pagesRead"),
        "licenseHttpStatus": report.get("licenseFileEvidence", {}).get("httpStatus"),
        "buildingSelection": report.get("buildingSelection", {}).get("status"),
        "releaseFlags": report.get("releaseFlags"),
        "reason": report.get("reason"),
    }, indent=2))
    return 0 if report.get("status") == "catalog-inventoried-pending-file-review" else 0


if __name__ == "__main__":
    sys.exit(main())
