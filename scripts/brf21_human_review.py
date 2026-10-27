#!/usr/bin/env python3
"""Prepare or validate a hash-bound human-review record for BRF-14/20/21 evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SCHEMA_VERSION = "1.0.0"
RECORD_TYPE = "brf-21-human-review-decision"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
BASENAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,160}$")
UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
MAX_JSON_BYTES = 20 * 1024 * 1024
MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
RELEASE_FLAGS = ("acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval")
ARTIFACT_FILENAMES = {
    "reviewManifest": "multiview-review-manifest.json",
    "overlapReport": "pairwise-overlap-report.json",
    "contactSheet": "multiview-contact-sheet.png",
    "cameraCoveragePlot": "camera-angle-coverage.png",
    "overlapGraph": "pairwise-overlap-graph.png",
}
SURFACE_VALUES = {"roof", "facade", "site", "other", "unknown"}
VIEW_DECISIONS = {"include", "exclude", "uncertain"}
PAIR_DECISIONS = {"useful-overlap", "no-useful-overlap", "uncertain"}
OVERALL_DISPOSITIONS = {"continue-to-reconstruction-preflight", "hold", "reject", "uncertain"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def safe_basename(value: Any, label: str) -> str:
    require(isinstance(value, str) and BASENAME_RE.fullmatch(value) is not None,
            label + " must be a simple filename without path components.")
    require(value not in {".", ".."}, label + " must not be a relative-path token.")
    return value


def safe_root(root: Path) -> Path:
    root = root.expanduser().absolute()
    require(not root.is_symlink(), "Artifact root must not be a symlink.")
    require(root.is_dir(), "Artifact root must be an existing directory.")
    return root.resolve(strict=True)


def safe_file(root: Path, filename: str, max_bytes: int = MAX_ARTIFACT_BYTES) -> Path:
    root = safe_root(root)
    filename = safe_basename(filename, "Artifact filename")
    path = root / filename
    require(path.parent == root, "Artifact path escapes the explicit artifact root.")
    require(not path.is_symlink(), "Artifact must not be a symlink: " + filename)
    require(path.is_file(), "Required artifact is missing or not a regular file: " + filename)
    require(0 < path.stat().st_size <= max_bytes,
            "Artifact size is empty or exceeds the configured limit: " + filename)
    return path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json_file(path: Path) -> Any:
    require(path.stat().st_size <= MAX_JSON_BYTES, "JSON input exceeds the maximum supported size.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid UTF-8 JSON in " + path.name + ": " + str(error)) from error


def _artifact_binding(root: Path, role: str) -> dict[str, Any]:
    filename = ARTIFACT_FILENAMES[role]
    max_bytes = MAX_JSON_BYTES if filename.endswith(".json") else MAX_ARTIFACT_BYTES
    path = safe_file(root, filename, max_bytes=max_bytes)
    return {"filename": filename, "byteSize": path.stat().st_size, "sha256": sha256_file(path)}


def load_evidence(root_arg: Path) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, Any], list[str], list[dict[str, Any]]]:
    root = safe_root(root_arg)
    bindings = {role: _artifact_binding(root, role) for role in ARTIFACT_FILENAMES}
    review_packet = load_json_file(root / ARTIFACT_FILENAMES["reviewManifest"])
    overlap_report = load_json_file(root / ARTIFACT_FILENAMES["overlapReport"])

    require(isinstance(review_packet, dict), "BRF-20 review manifest must be a JSON object.")
    require(review_packet.get("schemaVersion") == SCHEMA_VERSION,
            "Unsupported BRF-20 review-manifest schema.")
    require(review_packet.get("evaluationStage") == "multiview-human-review-packet-only",
            "Review manifest is not a BRF-20 human-review packet.")
    require(review_packet.get("status") == "review-packet-generated-pending-human-review",
            "BRF-20 packet must still be pending its human-review decision record.")
    require(isinstance(overlap_report, dict), "BRF-21 overlap report must be a JSON object.")
    require(overlap_report.get("schemaVersion") == SCHEMA_VERSION,
            "Unsupported BRF-21 overlap-report schema.")
    require(overlap_report.get("evaluationStage") == "pairwise-image-feature-overlap-triage-only",
            "Overlap report is not a BRF-21 pairwise feature-triage report.")
    require(overlap_report.get("status") == "pairwise-analysis-complete-needs-human-review",
            "BRF-21 overlap report has an unsupported status.")
    require(review_packet.get("sampleId") and
            review_packet.get("sampleId") == overlap_report.get("sampleId"),
            "BRF-20 packet and BRF-21 report sampleId values must match.")

    for source_name, source in (("BRF-20 review manifest", review_packet),
                                ("BRF-21 overlap report", overlap_report)):
        for flag in RELEASE_FLAGS:
            require(source.get(flag) is False,
                    source_name + " must explicitly keep " + flag + " false.")
    require(review_packet.get("rawImageBytesIncluded") is False,
            "BRF-20 review packet must not contain raw image bytes.")
    require(overlap_report.get("rawImageBytesIncluded") is False,
            "BRF-21 report must not contain raw image bytes.")

    packet_artifacts = review_packet.get("outputArtifacts")
    require(isinstance(packet_artifacts, dict), "BRF-20 packet has no output-artifact manifest.")
    for packet_key, role in (("contactSheet", "contactSheet"), ("cameraCoveragePlot", "cameraCoveragePlot")):
        entry = packet_artifacts.get(packet_key)
        require(isinstance(entry, dict), "BRF-20 packet is missing " + packet_key + " metadata.")
        binding = bindings[role]
        require(entry.get("filename") == binding["filename"] and
                entry.get("sha256") == binding["sha256"] and
                entry.get("byteSize") == binding["byteSize"],
                packet_key + " bytes do not match the hash/size recorded in the BRF-20 manifest.")
    graph_entry = overlap_report.get("graphArtifact")
    require(isinstance(graph_entry, dict), "BRF-21 report has no graph-artifact metadata.")
    graph_binding = bindings["overlapGraph"]
    require(graph_entry.get("filename") == graph_binding["filename"] and
            graph_entry.get("sha256") == graph_binding["sha256"] and
            graph_entry.get("byteSize") == graph_binding["byteSize"],
            "Overlap graph bytes do not match the hash/size recorded in the BRF-21 report.")

    source_views = review_packet.get("sourceViews")
    require(isinstance(source_views, list) and 3 <= len(source_views) <= 32,
            "BRF-20 packet must contain between 3 and 32 source views.")
    view_ids: list[str] = []
    for index, view in enumerate(source_views):
        require(isinstance(view, dict), "Each source view must be a JSON object.")
        view_id = view.get("id")
        require(isinstance(view_id, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", view_id) is not None,
                "Source view " + str(index) + " has an unsafe or missing ID.")
        require(view_id not in view_ids, "Duplicate source view ID: " + view_id)
        require(isinstance(view.get("actualSha256"), str) and
                SHA256_RE.fullmatch(view["actualSha256"]) is not None and
                view.get("actualSha256") == view.get("expectedSha256"),
                "Source view has a missing or inconsistent pinned image SHA-256: " + view_id)
        view_ids.append(view_id)

    pairs = overlap_report.get("pairs")
    require(isinstance(pairs, list), "BRF-21 report has no pair table.")
    expected_pair_count = len(view_ids) * (len(view_ids) - 1) // 2
    require(len(pairs) == expected_pair_count,
            "BRF-21 pair table must contain exactly one record for every unordered view pair.")
    expected_pairs = {tuple(sorted((a, b))) for i, a in enumerate(view_ids) for b in view_ids[i + 1:]}
    actual_pairs: set[tuple[str, str]] = set()
    normalized_pairs: list[dict[str, Any]] = []
    for index, pair in enumerate(pairs):
        require(isinstance(pair, dict), "BRF-21 pair[" + str(index) + "] must be a JSON object.")
        a, b = pair.get("viewA"), pair.get("viewB")
        require(isinstance(a, str) and isinstance(b, str) and a in view_ids and b in view_ids and a != b,
                "BRF-21 pair[" + str(index) + "] references an unknown or invalid view ID.")
        key = tuple(sorted((a, b)))
        require(key not in actual_pairs, "BRF-21 pair table contains a duplicate unordered pair.")
        actual_pairs.add(key)
        require(isinstance(pair.get("candidateOverlapEdge"), bool),
                "BRF-21 pair record must explicitly state candidateOverlapEdge.")
        normalized_pairs.append({"viewA": a, "viewB": b, "candidateOverlapEdge": pair["candidateOverlapEdge"]})
    require(actual_pairs == expected_pairs,
            "BRF-21 pair table omits or adds source-view combinations.")
    counts = overlap_report.get("counts")
    if isinstance(counts, dict) and "evaluatedPairs" in counts:
        require(counts["evaluatedPairs"] == len(pairs),
                "BRF-21 counts.evaluatedPairs disagrees with its pair table.")
    return root, review_packet, overlap_report, bindings, view_ids, normalized_pairs


def prepare_template(root_arg: Path) -> dict[str, Any]:
    _, packet, report, bindings, view_ids, pairs = load_evidence(root_arg)
    source_by_id = {view["id"]: view for view in packet["sourceViews"]}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "recordType": RECORD_TYPE,
        "sampleId": packet["sampleId"],
        "status": "pending-human-review",
        "evidenceBindings": bindings,
        "reviewer": {"name": "", "identifier": ""},
        "reviewedAtUtc": None,
        "overallDisposition": "pending",
        "overallRationale": "",
        "sameBuildingIdentity": {"decision": "pending", "rationale": ""},
        "coverageAssessment": {"decision": "pending", "rationale": ""},
        "sourceViews": [
            {
                "id": view_id,
                "sourceImageSha256": source_by_id[view_id]["actualSha256"],
                "visibleSurfaces": [],
                "occlusion": "pending",
                "imageQuality": "pending",
                "decision": "pending",
                "rationale": "",
            }
            for view_id in view_ids
        ],
        "pairReviews": [
            {**pair, "decision": "pending", "rationale": ""} for pair in pairs
        ],
        "sourceUpAxis": {
            "decision": "pending", "axis": "unknown", "positiveDirection": "unknown",
            "interpretation": "", "rationale": "",
        },
        "assetRights": {"decision": "pending", "termsSourceUrl": "", "rationale": ""},
        "reviewNotes": "",
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
        "limitations": [
            "This form records human review only; it does not establish independent survey accuracy.",
            "A continue-to-reconstruction-preflight disposition does not execute COLMAP or approve publication.",
            "The reviewer must independently inspect the exact hash-bound evidence files and relevant asset terms.",
        ],
    }


def _nonempty_text(value: Any, label: str, minimum: int = 10) -> str:
    require(isinstance(value, str) and len(value.strip()) >= minimum,
            label + " must contain at least " + str(minimum) + " non-whitespace characters.")
    return value.strip()


def _decision_object(value: Any, label: str, allowed: set[str]) -> dict[str, Any]:
    require(isinstance(value, dict), label + " must be an object.")
    choice = value.get("decision")
    require(isinstance(choice, str) and choice in allowed,
            label + ".decision must be one of: " + ", ".join(sorted(allowed)) + ".")
    _nonempty_text(value.get("rationale"), label + ".rationale", minimum=10)
    return value


def _validate_reviewer_time(decision: dict[str, Any]) -> tuple[dict[str, str], str]:
    reviewer = decision.get("reviewer")
    require(isinstance(reviewer, dict), "reviewer must be an object with name and identifier.")
    name = _nonempty_text(reviewer.get("name"), "reviewer.name", minimum=2)
    identifier = _nonempty_text(reviewer.get("identifier"), "reviewer.identifier", minimum=3)
    timestamp = decision.get("reviewedAtUtc")
    require(isinstance(timestamp, str) and UTC_RE.fullmatch(timestamp) is not None,
            "reviewedAtUtc must be an explicit UTC ISO-8601 timestamp ending in Z, including seconds.")
    try:
        parsed = datetime.fromisoformat(timestamp[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError("reviewedAtUtc is not a valid calendar timestamp.") from error
    require(parsed.utcoffset() is not None and parsed.utcoffset().total_seconds() == 0,
            "reviewedAtUtc must use the UTC time zone.")
    return {"name": name, "identifier": identifier}, timestamp


def _is_connected(included_ids: set[str], reviews: list[dict[str, Any]]) -> bool:
    if len(included_ids) < 3:
        return False
    adjacency = {view_id: set() for view_id in included_ids}
    for pair in reviews:
        a, b = pair["viewA"], pair["viewB"]
        if (a in included_ids and b in included_ids and
                pair.get("decision") == "useful-overlap"):
            adjacency[a].add(b)
            adjacency[b].add(a)
    seen: set[str] = set()
    stack = [next(iter(included_ids))]
    while stack:
        view_id = stack.pop()
        if view_id in seen:
            continue
        seen.add(view_id)
        stack.extend(adjacency[view_id] - seen)
    return seen == included_ids


def validate_decision(root_arg: Path, decision: Any) -> dict[str, Any]:
    root, packet, overlap_report, bindings, view_ids, expected_pairs = load_evidence(root_arg)
    require(isinstance(decision, dict), "Decision record must be a JSON object.")
    require(decision.get("schemaVersion") == SCHEMA_VERSION and decision.get("recordType") == RECORD_TYPE,
            "Unsupported human-review decision schema or recordType.")
    require(decision.get("sampleId") == packet["sampleId"],
            "Decision sampleId does not match the hash-bound evidence sample.")
    require(decision.get("evidenceBindings") == bindings,
            "Evidence binding mismatch: one or more JSON/PNG inputs are stale or changed; regenerate the template.")
    for flag in RELEASE_FLAGS:
        require(decision.get(flag) is False,
                "Human-review decision must explicitly keep " + flag + " false.")

    reviewer, reviewed_at = _validate_reviewer_time(decision)
    overall = decision.get("overallDisposition")
    require(isinstance(overall, str) and overall in OVERALL_DISPOSITIONS,
            "overallDisposition must be one of: " + ", ".join(sorted(OVERALL_DISPOSITIONS)) + ".")
    _nonempty_text(decision.get("overallRationale"), "overallRationale", minimum=20)
    identity = _decision_object(decision.get("sameBuildingIdentity"), "sameBuildingIdentity",
                                {"confirmed", "not-same-building", "uncertain"})
    coverage = _decision_object(decision.get("coverageAssessment"), "coverageAssessment",
                                {"adequate", "inadequate", "uncertain"})

    source_reviews = decision.get("sourceViews")
    require(isinstance(source_reviews, list) and len(source_reviews) == len(view_ids),
            "sourceViews must contain exactly one review for each source view.")
    source_by_id: dict[str, dict[str, Any]] = {}
    packet_views = {item["id"]: item for item in packet["sourceViews"]}
    for item in source_reviews:
        require(isinstance(item, dict), "Each source-view decision must be an object.")
        view_id = item.get("id")
        require(isinstance(view_id, str) and view_id in packet_views,
                "sourceViews references an unknown view ID.")
        require(view_id not in source_by_id, "sourceViews contains a duplicate view ID: " + str(view_id))
        require(item.get("sourceImageSha256") == packet_views[view_id].get("actualSha256"),
                "Source image hash does not match BRF-20 manifest for view " + view_id + ".")
        surfaces = item.get("visibleSurfaces")
        require(isinstance(surfaces, list) and surfaces and
                all(isinstance(value, str) and value in SURFACE_VALUES for value in surfaces) and
                len(surfaces) == len(set(surfaces)),
                "View " + view_id + " must list unique visibleSurfaces from the allowed vocabulary.")
        require(item.get("occlusion") in {"none", "minor", "material", "unknown"},
                "View " + view_id + " has an unsupported occlusion decision.")
        require(item.get("imageQuality") in {"usable", "limited", "unusable", "uncertain"},
                "View " + view_id + " has an unsupported imageQuality decision.")
        require(item.get("decision") in VIEW_DECISIONS,
                "View " + view_id + " decision must be include, exclude or uncertain.")
        _nonempty_text(item.get("rationale"), "View " + view_id + " rationale", minimum=10)
        source_by_id[view_id] = item
    require(set(source_by_id) == set(view_ids), "sourceViews contains unknown or missing view IDs.")

    pair_reviews = decision.get("pairReviews")
    require(isinstance(pair_reviews, list) and len(pair_reviews) == len(expected_pairs),
            "pairReviews must contain exactly one review for every unordered source-view pair.")
    expected_pair_keys = {tuple(sorted((item["viewA"], item["viewB"]))) for item in expected_pairs}
    actual_pair_keys: set[tuple[str, str]] = set()
    normalized_pair_reviews: list[dict[str, Any]] = []
    for item in pair_reviews:
        require(isinstance(item, dict), "Each pair review must be an object.")
        a, b = item.get("viewA"), item.get("viewB")
        require(isinstance(a, str) and isinstance(b, str) and a in view_ids and b in view_ids and a != b,
                "pairReviews references an unknown or invalid view pair.")
        key = tuple(sorted((a, b)))
        require(key in expected_pair_keys, "pairReviews references a pair not present in the hash-bound BRF-21 report.")
        require(key not in actual_pair_keys, "pairReviews contains a duplicate unordered pair.")
        actual_pair_keys.add(key)
        require(item.get("decision") in PAIR_DECISIONS,
                "Pair " + a + " / " + b + " must be useful-overlap, no-useful-overlap or uncertain.")
        _nonempty_text(item.get("rationale"), "Pair " + a + " / " + b + " rationale", minimum=10)
        expected = next(p for p in expected_pairs if tuple(sorted((p["viewA"], p["viewB"]))) == key)
        require(item.get("candidateOverlapEdge") is expected["candidateOverlapEdge"],
                "Pair candidateOverlapEdge was changed from the BRF-21 evidence for " + a + " / " + b + ".")
        normalized_pair_reviews.append(item)
    require(actual_pair_keys == expected_pair_keys, "pairReviews contains unknown or missing unordered pairs.")

    axis = decision.get("sourceUpAxis")
    require(isinstance(axis, dict), "sourceUpAxis must be an object.")
    require(axis.get("decision") in {"confirmed", "ambiguous", "unsupported"},
            "sourceUpAxis.decision must be confirmed, ambiguous or unsupported.")
    require(axis.get("axis") in {"X", "Y", "Z", "unknown"},
            "sourceUpAxis.axis must be X, Y, Z or unknown.")
    require(axis.get("positiveDirection") in {"positive", "negative", "unknown"},
            "sourceUpAxis.positiveDirection has an unsupported value.")
    _nonempty_text(axis.get("interpretation"), "sourceUpAxis.interpretation", minimum=10)
    _nonempty_text(axis.get("rationale"), "sourceUpAxis.rationale", minimum=10)
    if axis["decision"] == "confirmed":
        require(axis["axis"] in {"X", "Y", "Z"} and axis["positiveDirection"] in {"positive", "negative"},
                "A confirmed source up-axis requires an explicit X/Y/Z axis and positive/negative direction.")

    rights = _decision_object(decision.get("assetRights"), "assetRights",
                              {"approved-for-this-use", "not-approved", "uncertain"})
    terms_url = rights.get("termsSourceUrl")
    if rights["decision"] == "approved-for-this-use":
        require(isinstance(terms_url, str), "Approved asset-rights review requires termsSourceUrl.")
        parsed_url = urlparse(terms_url)
        require(parsed_url.scheme == "https" and bool(parsed_url.netloc),
                "Approved asset-rights review requires an HTTPS termsSourceUrl.")

    if overall == "continue-to-reconstruction-preflight":
        require(identity["decision"] == "confirmed", "Cannot continue: same-building identity is not confirmed.")
        require(coverage["decision"] == "adequate", "Cannot continue: source view coverage is not adequate.")
        require(axis["decision"] == "confirmed", "Cannot continue: source up-axis is not confirmed.")
        require(rights["decision"] == "approved-for-this-use",
                "Cannot continue: asset rights are not approved for the intended use.")
        included = {view_id for view_id, item in source_by_id.items() if item["decision"] == "include"}
        require(_is_connected(included, normalized_pair_reviews),
                "Cannot continue: at least three included views must form a connected graph of human-confirmed useful-overlap pairs.")

    if "reviewNotes" in decision and decision["reviewNotes"] is not None:
        require(isinstance(decision["reviewNotes"], str), "reviewNotes must be a string when supplied.")

    return {
        "schemaVersion": SCHEMA_VERSION,
        "recordType": "brf-21-human-review-validation-report",
        "sampleId": packet["sampleId"],
        "status": "human-review-record-complete",
        "overallDisposition": overall,
        "reviewer": reviewer,
        "reviewedAtUtc": reviewed_at,
        "evidenceBindings": bindings,
        "reviewCounts": {
            "views": len(source_by_id),
            "pairs": len(normalized_pair_reviews),
            "includedViews": sum(1 for item in source_by_id.values() if item["decision"] == "include"),
            "excludedViews": sum(1 for item in source_by_id.values() if item["decision"] == "exclude"),
            "uncertainViews": sum(1 for item in source_by_id.values() if item["decision"] == "uncertain"),
            "humanConfirmedUsefulOverlapPairs": sum(1 for item in normalized_pair_reviews if item["decision"] == "useful-overlap"),
        },
        "humanReview": {
            "sameBuildingIdentity": identity["decision"],
            "coverageAssessment": coverage["decision"],
            "sourceUpAxis": axis["decision"],
            "assetRights": rights["decision"],
        },
        "nextStep": "A human must separately decide whether to run reconstruction preflight; this CLI does not execute COLMAP, generate a GLB or publish a model.",
        "limitations": [
            "This report validates a human-authored review record and byte-level evidence binding; it does not authenticate reviewer identity or licence claims.",
            "It provides no independent survey truth, checkpoint accuracy, coordinate registration or geometry-accuracy result.",
            "All release and automatic-approval flags remain false regardless of the review disposition.",
        ],
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
    }


def write_json_safely(root_arg: Path, filename: str, value: Any) -> Path:
    root = safe_root(root_arg)
    filename = safe_basename(filename, "Output filename")
    require(filename not in set(ARTIFACT_FILENAMES.values()), "Output must not overwrite an evidence input artifact.")
    path = root / filename
    require(path.parent == root, "Output path escapes the explicit artifact root.")
    require(not path.is_symlink(), "Output path must not be a symlink.")
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    template_parser = subparsers.add_parser("template", help="create a blank decision form bound to the exact evidence hashes")
    template_parser.add_argument("--artifact-root", required=True, type=Path)
    template_parser.add_argument("--output", default="multiview-human-review-decision-template.json")
    validate_parser = subparsers.add_parser("validate", help="validate a completed reviewer-authored decision record")
    validate_parser.add_argument("--artifact-root", required=True, type=Path)
    validate_parser.add_argument("--decision", required=True, help="decision JSON basename under artifact-root")
    validate_parser.add_argument("--output", default="multiview-human-review-validation-report.json")
    args = parser.parse_args(argv)
    try:
        if args.command == "template":
            result = prepare_template(args.artifact_root)
            output = write_json_safely(args.artifact_root, args.output, result)
            print(json.dumps({"status": result["status"], "sampleId": result["sampleId"],
                              "output": output.name, "boundArtifacts": len(result["evidenceBindings"]),
                              "acceptanceEligible": False, "publicationEligible": False,
                              "mapReady": False, "automaticApproval": False}, indent=2))
        else:
            root = safe_root(args.artifact_root)
            decision_name = safe_basename(args.decision, "Decision filename")
            decision_path = safe_file(root, decision_name, max_bytes=MAX_JSON_BYTES)
            decision = load_json_file(decision_path)
            result = validate_decision(root, decision)
            output = write_json_safely(root, args.output, result)
            print(json.dumps({"status": result["status"], "sampleId": result["sampleId"],
                              "overallDisposition": result["overallDisposition"], "output": output.name,
                              "acceptanceEligible": False, "publicationEligible": False,
                              "mapReady": False, "automaticApproval": False}, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("BRF-21 human-review validation blocked: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
