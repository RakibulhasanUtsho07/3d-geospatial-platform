#!/usr/bin/env python3
"""Create synthetic-only source-camera inputs aligned to a candidate GLB for renderer QA."""
import hashlib
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


def camera_local_to_world(position, theta, x, y, depth):
    """Transform a local point (x, y, -depth) by a camera rotated about world X."""
    cosine = math.cos(theta)
    sine = math.sin(theta)
    return [
        position[0] + x,
        position[1] + cosine * y + sine * depth,
        position[2] + sine * y - cosine * depth,
    ]


def main():
    if len(sys.argv) != 3:
        raise SystemExit(
            "Usage: prepare-source-camera-fixture.py <new-output-directory> <candidate-report.json>"
        )
    root = Path(sys.argv[1]).resolve()
    report_path = Path(sys.argv[2]).resolve()
    root.mkdir(parents=True, exist_ok=False)

    report = json.loads(report_path.read_text(encoding="utf-8"))
    bounds = report.get("geometryQA", {}).get("bounds", {})
    gltf_min = bounds.get("min")
    gltf_max = bounds.get("max")
    if not (
        isinstance(gltf_min, list) and len(gltf_min) == 3
        and isinstance(gltf_max, list) and len(gltf_max) == 3
        and all(isinstance(v, (int, float)) and math.isfinite(v) for v in gltf_min + gltf_max)
    ):
        raise SystemExit("Candidate report is missing finite geometryQA.bounds min/max")

    # The generated GLB is glTF Y-up; Blender imports it into Z-up:
    # Blender X = glTF X, Blender Y = -glTF Z, Blender Z = glTF Y.
    center = [
        (gltf_min[0] + gltf_max[0]) / 2.0,
        -(gltf_min[2] + gltf_max[2]) / 2.0,
        (gltf_min[1] + gltf_max[1]) / 2.0,
    ]
    dimensions = [
        gltf_max[0] - gltf_min[0],
        gltf_max[2] - gltf_min[2],
        gltf_max[1] - gltf_min[1],
    ]
    largest_dimension = max(dimensions)
    if largest_dimension <= 0:
        raise SystemExit("Candidate report has a zero-sized geometry bound")

    # Point a synthetic camera from the model's south towards the measured bbox
    # center. This is test-fixture setup only; it must not be used to calibrate
    # or auto-fit a real source-photo camera.
    camera_distance = largest_dimension * 1.6
    camera_pitch = largest_dimension * 0.15
    center_distance = math.hypot(camera_distance, camera_pitch)
    theta = math.atan2(camera_distance, camera_pitch)
    camera_position = [
        center[0],
        center[1] - camera_distance,
        center[2] + camera_pitch,
    ]
    quaternion_wxyz = [math.cos(theta / 2.0), math.sin(theta / 2.0), 0.0, 0.0]

    # A reproducible synthetic placeholder raster, not a real building photograph.
    image_path = root / "synthetic-source.png"
    image = Image.new("RGB", (640, 480), (225, 230, 236))
    draw = ImageDraw.Draw(image)
    draw.rectangle((24, 24, 615, 455), outline=(100, 110, 125), width=2)
    for x in range(60, 600, 40):
        draw.line((x, 28, x, 452), fill=(205, 210, 218), width=1)
    for y in range(60, 450, 40):
        draw.line((28, y, 612, y), fill=(205, 210, 218), width=1)
    image.save(image_path, format="PNG", optimize=False)

    calibration_path = root / "synthetic-calibration-evidence.json"
    write_json(calibration_path, {
        "schemaVersion": "1.0.0",
        "fixture": "M13 source-camera integration test only",
        "meaning": "Synthetic calibration control; not evidence for a real camera or building.",
    })
    alignment_path = root / "synthetic-frame-alignment-evidence.json"
    write_json(alignment_path, {
        "schemaVersion": "1.0.0",
        "fixture": "M13 source-camera integration test only",
        "meaning": "Synthetic frame-alignment control; not evidence for a real GLB.",
    })

    camera_path = root / "synthetic-source-camera.json"
    fx, fy, cx, cy = 400.0, 500.0, 300.0, 220.0
    control_dx = center_distance * (40.0 / fx)
    control_dy = center_distance * (50.0 / fy)
    camera = {
        "schemaVersion": "1.0.0",
        "id": "m13-synthetic-source-camera",
        "calibrationStatus": "verified",
        "calibrationEvidence": {
            "id": "m13-synthetic-calibration",
            "sha256": sha256(calibration_path),
        },
        "frameAlignmentEvidence": {
            "id": "m13-synthetic-frame-alignment",
            "sha256": sha256(alignment_path),
        },
        "coordinateFrame": "synthetic-model-local-blender-v1",
        "sourceImage": {
            "sha256": sha256(image_path),
            "width": 640,
            "height": 480,
            "crop": {"x": 0, "y": 0, "width": 640, "height": 480},
        },
        "pose": {
            "position": camera_position,
            "quaternionWxyz": quaternion_wxyz,
        },
        "intrinsics": {
            "fx": fx,
            "fy": fy,
            "cx": cx,
            "cy": cy,
            "distortionModel": "none",
        },
        "controlPoints": [
            {
                "id": "p1",
                "worldPoint": camera_local_to_world(camera_position, theta, 0.0, 0.0, center_distance),
                "imagePoint": {"x": cx, "y": cy},
            },
            {
                "id": "p2",
                "worldPoint": camera_local_to_world(camera_position, theta, control_dx, 0.0, center_distance),
                "imagePoint": {"x": cx + 40.0, "y": cy},
            },
            {
                "id": "p3",
                "worldPoint": camera_local_to_world(camera_position, theta, 0.0, control_dy, center_distance),
                "imagePoint": {"x": cx, "y": cy - 50.0},
            },
            {
                "id": "p4",
                "worldPoint": camera_local_to_world(camera_position, theta, -control_dx, -control_dy, center_distance),
                "imagePoint": {"x": cx - 40.0, "y": cy + 50.0},
            },
        ],
    }
    write_json(camera_path, camera)

    print(json.dumps({
        "fixtureKind": "synthetic-only",
        "candidateReport": str(report_path),
        "candidateBoundsCenterBlender": center,
        "cameraTargetDistance": center_distance,
        "sourceImage": str(image_path),
        "sourceImageSha256": sha256(image_path),
        "sourceImageSize": [640, 480],
        "cameraManifest": str(camera_path),
        "cameraManifestSha256": sha256(camera_path),
        "calibrationEvidenceSha256": sha256(calibration_path),
        "frameAlignmentEvidenceSha256": sha256(alignment_path),
        "realBuildingAccuracyClaim": False,
    }, indent=2))


if __name__ == "__main__":
    main()
