#!/usr/bin/env python3
"""Create synthetic-only source-camera inputs for the M13 renderer integration test."""
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: prepare-source-camera-fixture.py <new-output-directory>")
    root = Path(sys.argv[1]).resolve()
    root.mkdir(parents=True, exist_ok=False)

    # A reproducible placeholder raster, not a real building photograph.
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
            "position": [0, 0, 10],
            "quaternionWxyz": [1, 0, 0, 0],
        },
        "intrinsics": {
            "fx": 400,
            "fy": 500,
            "cx": 300,
            "cy": 220,
            "distortionModel": "none",
        },
        "controlPoints": [
            {"id": "p1", "worldPoint": [0, 0, 0], "imagePoint": {"x": 300, "y": 220}},
            {"id": "p2", "worldPoint": [1, 0, 0], "imagePoint": {"x": 340, "y": 220}},
            {"id": "p3", "worldPoint": [0, 1, 0], "imagePoint": {"x": 300, "y": 170}},
            {"id": "p4", "worldPoint": [-1, -1, 0], "imagePoint": {"x": 260, "y": 270}},
        ],
    }
    write_json(camera_path, camera)

    print(json.dumps({
        "fixtureKind": "synthetic-only",
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
