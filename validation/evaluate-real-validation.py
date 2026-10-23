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
    parser.add_argument("--calibration-report", type=Path, help="Optional report for calibration applied to the exact same GLB")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--minimum-registered-ratio", type=float, default=0.75)
    parser.add_argument("--minimum-registered-images", type=int, default=6)
    parser.add_argument("--minimum-view-direction-spread-degrees", type=float, default=20.0)
    args = parser.parse_args()

    dim = load(args.dimensions)
    worker = load(args.worker_report)
    calibration_report = load(args.calibration_report) if args.calibration_report else {}
    calibration = calibration_report.get("scaleCalibration", {})
    comparison = dim.get("dimensionComparison", {})
    diagnostics = worker.get("reconstructionDiagnostics", {})
    coverage = worker.get("cameraCoverage", {})
    texture_status = worker.get("textureStatus", "unknown")
    diagnostics_metrics = diagnostics.get("metrics", {})
    # sourceImageCount is the number of selected inputs; metrics.totalImages in
    # some COLMAP builds reports only database/registered images and must not
    # silently lower the denominator.
    source_count = int(diagnostics.get("sourceImageCount", diagnostics_metrics.get("totalImages", 0)) or 0)
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
    model_review = worker.get("modelReview")
    # The worker report describes the uncalibrated reconstruction. If a separate scale
    # calibration was applied to that exact same GLB, do not leave a stale finding saying
    # "no baseline was applied"; replace it with a truthful reminder that only one axis
    # was calibrated and depth/height still failed or remain independent.
    if isinstance(model_review, dict) and calibration.get("sameReconstructionReused") is True:
        review_findings = model_review.get("findings", [])
        revised_findings = []
        for finding in review_findings:
            if finding.get("code") == "metric-scale-unverified":
                length_status = comparison.get("lengthGate", "missing")
                depth_status = comparison.get("depthGate", "missing")
                height_status = comparison.get("heightGate", "missing")
                revised_findings.append({
                    "code": "metric-scale-baseline-calibrated-independent-checks-required",
                    "category": "scale",
                    "severity": "high" if depth_status != "pass" or height_status != "pass" else "medium",
                    "title": "Long-axis calibrated; complete metric accuracy not established",
                    "summary": (
                        f"The same reconstruction was scaled to {calibration.get('referenceLengthM')} m along its longest horizontal axis. "
                        f"Depth gate: {depth_status}; height gate: {height_status}. The calibrated length is not independent evidence."
                    ),
                    "recommendation": "Do not publish as accurate until independently measured depth and height pass and a human verifies the model against source views.",
                    "evidence": {
                        "method": calibration.get("method"),
                        "referenceLengthM": calibration.get("referenceLengthM"),
                        "scaleFactorApplied": calibration.get("scaleFactorApplied"),
                        "lengthGate": length_status,
                        "depthGate": depth_status,
                        "heightGate": height_status,
                        "lengthAgreementIsIndependent": False
                    }
                })
            else:
                revised_findings.append(finding)
        model_review = {
            **model_review,
            "findings": revised_findings,
            "findingCount": len(revised_findings),
            "priority": "high" if not passed else model_review.get("priority", "medium"),
        }

    report = {
        "schemaVersion": "1.0.0",
        "building": worker.get("buildingId", "ahsan-manzil-live-cv"),
        "status": "pass" if passed else "fail-review-required",
        "accuracyValidated": passed,
        "gates": gates,
        "dimensionComparison": comparison,
        "calibration": calibration if calibration else None,
        "modelReview": model_review,
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
