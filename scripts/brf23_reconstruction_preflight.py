#!/usr/bin/env python3
"""Assess whether reviewed, hash-pinned multi-view inputs may enter a local-only COLMAP attempt.

This command is a preflight only. It never launches reconstruction or creates a GLB.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import stat
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import brf21_human_review as brf21  # noqa: E402

SCHEMA_VERSION = "1.0.0"
MAX_PROFILE_BYTES = 1024 * 1024
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
OUTPUT_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,160}$")
RELEASE_FLAGS = ("acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json_regular_file(path: Path, max_bytes: int) -> tuple[Any, bytes]:
    require(not path.is_symlink(), "JSON input must not be a symlink: " + path.name)
    require(path.is_file(), "JSON input is missing or is not a regular file: " + str(path))
    require(0 < path.stat().st_size <= max_bytes, "JSON input is empty or exceeds size limit: " + path.name)
    raw = path.read_bytes()
    try:
        return json.loads(raw.decode("utf-8")), raw
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid UTF-8 JSON in " + path.name + ": " + str(error)) from error


def safe_directory(path_arg: Path, label: str) -> Path:
    path = path_arg.expanduser().absolute()
    require(not path.is_symlink(), label + " must not be a symlink.")
    require(path.is_dir(), label + " must be an existing directory.")
    return path.resolve(strict=True)


def validate_profile(profile: Any) -> dict[str, Any]:
    require(isinstance(profile, dict), "Profile must be a JSON object.")
    require(profile.get("schemaVersion") == SCHEMA_VERSION, "Unsupported profile schemaVersion.")
    require(isinstance(profile.get("profileId"), str) and profile["profileId"].strip(),
            "profileId must be a non-empty string.")
    toolchain = profile.get("toolchain")
    require(isinstance(toolchain, dict), "Profile toolchain must be an object.")
    require(toolchain.get("name") == "COLMAP", "Only the explicit COLMAP CLI toolchain is supported.")
    executable = toolchain.get("executable")
    require(isinstance(executable, str) and executable.strip() and
            not any(char.isspace() for char in executable),
            "toolchain.executable must be one executable name/path, with no arguments.")
    expected_version = toolchain.get("expectedVersion")
    require(isinstance(expected_version, str) and VERSION_RE.fullmatch(expected_version) is not None,
            "toolchain.expectedVersion must be an explicit version pin.")
    require(toolchain.get("versionCommand") == ["version"],
            "toolchain.versionCommand must be the safe, non-reconstruction ['version'] command.")
    frame = profile.get("coordinateFrame")
    require(isinstance(frame, dict), "coordinateFrame must be an object.")
    require(frame.get("policy") == "local-only-no-georeference",
            "Only local-only-no-georeference is admissible until a separately verified world transform exists.")
    require(isinstance(frame.get("frameId"), str) and len(frame["frameId"].strip()) >= 5,
            "coordinateFrame.frameId must explicitly name the local frame.")
    require(frame.get("units") == "unscaled-local",
            "coordinateFrame.units must be unscaled-local; the source scale bar is not independent survey truth.")
    require(frame.get("registrationToGps") == "not-established",
            "coordinateFrame.registrationToGps must be not-established.")
    execution = profile.get("execution")
    require(isinstance(execution, dict) and execution.get("preflightOnly") is True and
            execution.get("runReconstruction") is False and execution.get("generateCandidateGlb") is False,
            "Profile must explicitly disable reconstruction and candidate GLB generation.")
    return profile


def verify_source_images(image_root_arg: Path, source_manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    images: list[dict[str, Any]] = []
    blockers: list[str] = []
    try:
        root = safe_directory(image_root_arg, "Image root")
    except (OSError, ValueError) as error:
        return images, ["Source images unavailable: " + str(error)]

    views = source_manifest.get("views")
    if not isinstance(views, list) or not views:
        return images, ["Pinned source manifest contains no source views."]

    max_image_bytes = source_manifest.get("maximumImageBytes")
    max_total_bytes = source_manifest.get("maximumTotalBytes")
    if not isinstance(max_image_bytes, int) or max_image_bytes <= 0 or \
       not isinstance(max_total_bytes, int) or max_total_bytes <= 0:
        return images, ["Pinned source manifest has invalid byte limits."]

    total = 0
    seen_names: set[str] = set()
    for view in views:
        if not isinstance(view, dict):
            blockers.append("Pinned source manifest contains a malformed view record.")
            continue
        filename = view.get("filename")
        expected_size = view.get("expectedByteSize")
        expected_hash = view.get("expectedSha256")
        if not isinstance(filename, str) or brf21.BASENAME_RE.fullmatch(filename) is None or filename in {".", ".."}:
            blockers.append("Source view has an unsafe filename; path traversal is not allowed.")
            continue
        if filename in seen_names:
            blockers.append("Pinned source manifest contains a duplicate filename: " + filename)
            continue
        seen_names.add(filename)
        if not isinstance(expected_size, int) or expected_size <= 0 or expected_size > max_image_bytes:
            blockers.append("Pinned source byte size is invalid for " + filename + ".")
            continue
        if not isinstance(expected_hash, str) or SHA256_RE.fullmatch(expected_hash) is None:
            blockers.append("Pinned source SHA-256 is invalid for " + filename + ".")
            continue
        path = root / filename
        try:
            info = path.lstat()
            require(not path.is_symlink() and path.parent == root and stat.S_ISREG(info.st_mode),
                    "must be a regular non-symlink file directly under the image root")
            require(info.st_size == expected_size, "byte-size mismatch (expected " + str(expected_size) +
                    ", got " + str(info.st_size) + ")")
            require(0 < info.st_size <= max_image_bytes, "file is empty or exceeds the per-image limit")
            actual_hash = sha256_file(path)
            require(actual_hash == expected_hash, "SHA-256 mismatch")
            with path.open("rb") as stream:
                header = stream.read(3)
            require(header == b"\xff\xd8\xff", "file does not have a JPEG signature")
            images.append({"filename": filename, "byteSize": info.st_size, "sha256": actual_hash,
                           "status": "verified"})
            total += info.st_size
        except FileNotFoundError:
            blockers.append("Source image is missing: " + filename)
        except (OSError, ValueError) as error:
            blockers.append("Source image blocked (" + filename + "): " + str(error))

    if len(images) != len(views):
        blockers.append("Not all pinned source images passed byte-level verification.")
    if total > max_total_bytes:
        blockers.append("Verified source images exceed the manifest's maximum total-byte budget.")
    return images, blockers


def inspect_colmap(toolchain: dict[str, Any]) -> dict[str, Any]:
    executable = toolchain["executable"]
    expected_version = toolchain["expectedVersion"]
    found = shutil.which(executable)
    if found is None:
        return {"status": "blocked", "executable": executable, "expectedVersion": expected_version,
                "actualVersion": None, "reason": "Configured COLMAP executable was not found on PATH."}
    if not os.path.isfile(found) or not os.access(found, os.X_OK):
        return {"status": "blocked", "executable": executable, "resolvedPathAvailable": True,
                "expectedVersion": expected_version, "actualVersion": None,
                "reason": "Resolved COLMAP executable is not a runnable regular file."}
    try:
        result = subprocess.run([found, "version"], check=False, capture_output=True, text=True,
                                timeout=10, shell=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"status": "blocked", "executable": executable, "expectedVersion": expected_version,
                "actualVersion": None, "reason": "COLMAP version probe failed: " + str(error)}
    output = (result.stdout + "\n" + result.stderr).strip()[:2000]
    version_match = re.search(r"(?<![A-Za-z0-9.])(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?![A-Za-z0-9.])", output)
    actual_version = version_match.group(1) if version_match else None
    matches = result.returncode == 0 and actual_version == expected_version
    return {"status": "verified" if matches else "blocked", "executable": executable,
            "resolvedExecutable": found, "expectedVersion": expected_version,
            "actualVersion": actual_version, "exitCode": result.returncode,
            "reason": None if matches else "COLMAP version output did not match the exact pinned version.",
            "versionOutputExcerpt": output[:500]}


def assess(artifact_root_arg: Path, image_root_arg: Path, decision_name: str, profile_path_arg: Path,
           output_name: str) -> dict[str, Any]:
    root = brf21.safe_root(artifact_root_arg)
    require(isinstance(decision_name, str) and brf21.BASENAME_RE.fullmatch(decision_name) is not None and
            decision_name not in {".", ".."}, "Decision filename must be a safe basename.")
    require(isinstance(output_name, str) and OUTPUT_NAME_RE.fullmatch(output_name) is not None and
            output_name not in {".", ".."}, "Output filename must be a safe basename.")
    require(output_name not in set(brf21.ARTIFACT_FILENAMES.values()) and
            output_name != decision_name, "Output filename must not overwrite an evidence or decision input.")
    profile_path = profile_path_arg.expanduser().absolute()
    profile, profile_bytes = load_json_regular_file(profile_path, MAX_PROFILE_BYTES)
    profile = validate_profile(profile)

    _, source_manifest, _, _, _, _, evidence_bindings, _, _ = brf21.load_evidence(root)
    decision_path = brf21.safe_file(root, decision_name, max_bytes=brf21.MAX_JSON_BYTES)
    decision, decision_bytes = load_json_regular_file(decision_path, brf21.MAX_JSON_BYTES)
    blockers: list[str] = []
    human_review_result: dict[str, Any] | None = None
    try:
        human_review_result = brf21.validate_decision(root, decision)
        if human_review_result.get("overallDisposition") != "continue-to-reconstruction-preflight":
            blockers.append("Human-review disposition is not continue-to-reconstruction-preflight.")
    except (OSError, ValueError, KeyError, TypeError) as error:
        blockers.append("Human review decision failed validation: " + str(error))

    image_records, image_blockers = verify_source_images(image_root_arg, source_manifest)
    blockers.extend(image_blockers)
    toolchain_result = inspect_colmap(profile["toolchain"])
    if toolchain_result["status"] != "verified":
        blockers.append("COLMAP toolchain is not verified: " + str(toolchain_result.get("reason")))

    frame = profile["coordinateFrame"]
    output_status = "blocked" if blockers else "preflight-ready-for-local-reconstruction-attempt"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "recordType": "brf-23-reconstruction-preflight-report",
        "sampleId": source_manifest.get("sampleId"),
        "profileId": profile["profileId"],
        "status": output_status,
        "assessedInputs": {
            "evidenceBindings": evidence_bindings,
            "humanDecision": {"filename": decision_name, "byteSize": len(decision_bytes),
                              "sha256": hashlib.sha256(decision_bytes).hexdigest(),
                              "validationStatus": "valid" if human_review_result else "invalid-or-pending",
                              "overallDisposition": decision.get("overallDisposition") if isinstance(decision, dict) else None,
                              "reviewer": human_review_result.get("reviewer") if human_review_result else None,
                              "reviewedAtUtc": human_review_result.get("reviewedAtUtc") if human_review_result else None},
            "reviewCounts": human_review_result.get("reviewCounts") if human_review_result else None,
            "humanReview": human_review_result.get("humanReview") if human_review_result else None,
            "imageQualityPreflight": (
                human_review_result.get("imageQualityPreflight") if human_review_result else None
            ),
            "profile": {"filename": profile_path.name, "byteSize": len(profile_bytes),
                        "sha256": hashlib.sha256(profile_bytes).hexdigest()},
            "sourceImages": {"verifiedCount": len(image_records),
                             "expectedCount": len(source_manifest.get("views", [])),
                             "records": image_records},
        },
        "toolchain": toolchain_result,
        "coordinateFrame": {
            "policy": frame["policy"], "frameId": frame["frameId"], "units": frame["units"],
            "registrationToGps": frame["registrationToGps"],
            "reviewedSourceUpAxis": (
                decision.get("sourceUpAxis", {}).get("axis")
                if isinstance(decision, dict) and isinstance(decision.get("sourceUpAxis"), dict) else None
            ),
            "reviewedSourceUpAxisPositiveDirection": (
                decision.get("sourceUpAxis", {}).get("positiveDirection")
                if isinstance(decision, dict) and isinstance(decision.get("sourceUpAxis"), dict) else None
            ),
            "note": "No GPS/CRS transform is inferred, estimated or applied by this preflight.",
        },
        "blockers": blockers,
        "reconstructionExecuted": False,
        "candidateGlbGenerated": False,
        "independentReferenceVerified": False,
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
        "limitations": [
            "The COLMAP version probe is the only external process run; no reconstruction command is executed.",
            "A preflight-ready result permits only a future local-frame reconstruction attempt, not a geometry or accuracy pass.",
            "Reviewer identity and asset-rights statements are not independently authenticated by this CLI.",
            "The source's nominal scale-control metadata is not independent survey truth; output scale remains unverified.",
            "Independent reference geometry and held-out survey checkpoints remain separate BRF-10 acceptance gates.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    assess_parser = sub.add_parser("assess", help="verify inputs and write a fail-closed preflight report")
    assess_parser.add_argument("--artifact-root", required=True, type=Path)
    assess_parser.add_argument("--image-root", required=True, type=Path)
    assess_parser.add_argument("--decision", required=True, help="reviewer decision JSON basename in artifact-root")
    assess_parser.add_argument("--profile", required=True, type=Path)
    assess_parser.add_argument("--output", default="reconstruction-preflight-report.json")
    args = parser.parse_args(argv)
    try:
        report = assess(args.artifact_root, args.image_root, args.decision, args.profile, args.output)
        output = brf21.write_json_safely(args.artifact_root, args.output, report)
        print(json.dumps({"status": report["status"], "sampleId": report["sampleId"],
                          "verifiedImages": report["assessedInputs"]["sourceImages"]["verifiedCount"],
                          "expectedImages": report["assessedInputs"]["sourceImages"]["expectedCount"],
                          "blockerCount": len(report["blockers"]), "output": output.name,
                          "reconstructionExecuted": False, "candidateGlbGenerated": False,
                          "acceptanceEligible": False, "publicationEligible": False,
                          "mapReady": False, "automaticApproval": False}, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("BRF-23 reconstruction preflight could not be assessed: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
