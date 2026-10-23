#!/usr/bin/env python3
"""Combine measured dimensions and COLMAP camera coverage into a fail-closed report."""
from __future__ import annotations
import argparse
import json
from pathlib import Path


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dimensions", required=True, type=Path)
    parser.add_argument("--worker-report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--minimum-registered-ratio", type=float, default=0.75)
    parser.add_argument("--minimum-registered-images", type=int, default=6)
    parser.add_argument("--minimum-view-direction-spread-degrees", type=float, default=20.0)
    args = parser.parse_args()

    dim = load(args.dimensions)
    worker = load(args.worker_report)
    comparison = dim.get("dimensionComparison", {})
    diagnostics = worker.get("reconstructionDiagnostics", {})
    coverage = worker.get("cameraCoverage", {})
    texture_status = worker.get("textureStatus", "unknown")
    diagnostics_metrics = diagnostics.get("metrics", {})
    source_count = int(diagnostics_metrics.get("totalImages", diagnostics.get("sourceImageCount", 0)) or 0)
    registered = int(diagnostics_metrics.get("registeredImages", coverage.get("registeredCameraPoseCount", 0)) or 0)
    ratio = diagnostics.get("registeredImageRatio")
    if ratio is None:
        ratio = registered / source_count if source_count else 0.0
    ratio = float(ratio)
    spread = float(coverage.get("maximumViewingDirectionAngleDegrees", 0.0) or 0.0)

    gates = {
        "dimensions": {
            "passed": comparison.get("dimensionGate") == "pass",
            "actual": comparison.get("dimensionGate", "missing"),
            "reason": "Length is calibrated by construction; depth and height remain independent checks."
        },
        "registeredImageCoverage": {
            "passed": ratio >= args.minimum_registered_ratio and registered >= args.minimum_registered_images,
            "registeredImages": registered,
            "sourceImages": source_count,
            "registeredRatio": ratio,
            "minimumRegisteredRatio": args.minimum_registered_ratio,
            "minimumRegisteredImages": args.minimum_registered_images
        },
        "viewpointSpread": {
            "passed": spread >= args.minimum_view_direction_spread_degrees,
            "maximumViewingDirectionAngleDegrees": spread,
            "minimumDegrees": args.minimum_view_direction_spread_degrees,
            "reason": "A small viewing-direction spread weakens depth/side reconstruction, even when the facade looks plausible."
        },
        "texture": {
            "passed": texture_status == "textured",
            "status": texture_status,
            "reason": "A neutral-material GLB permits geometry/silhouette review only; facade texture match was not tested."
        }
    }
    passed = all(item["passed"] for item in gates.values())
    warnings = list(worker.get("warnings", []))
    if ratio < args.minimum_registered_ratio or registered < args.minimum_registered_images:
        warnings.append("Photograph registration coverage is below the live-validation threshold.")
    if spread < args.minimum_view_direction_spread_degrees:
        warnings.append("Camera viewing directions are too concentrated for a confident full-building reconstruction.")
    if texture_status != "textured":
        warnings.append("Image texture comparison was not possible; GLB is geometry-only.")
    report = {
        "schemaVersion": "1.0.0",
        "building": worker.get("buildingId", "ahsan-manzil-live-cv"),
        "status": "pass" if passed else "fail-review-required",
        "accuracyValidated": passed,
        "gates": gates,
        "dimensionComparison": comparison,
        "modelReview": worker.get("modelReview"),
        "geometryStrategy": worker.get("geometryStrategy", "unknown"),
        "warnings": list(dict.fromkeys(warnings)),
        "limitations": [
            "The published dimensions are references, not a new independent survey.",
            "Long-axis length is calibrated to the reference value and is not independent evidence.",
            "A pass would still require human photo-overlay review and independent WGS84/GCP registration before map publication.",
            "This run does not claim cadastral/geodetic accuracy."
        ]
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
