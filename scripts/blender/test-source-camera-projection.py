import json
import math
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view


def parse_args():
    if "--" not in sys.argv:
        raise RuntimeError("Expected --camera-manifest and --tolerance-px after --")
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) % 2:
        raise RuntimeError("Expected key/value arguments")
    values = dict(zip(args[::2], args[1::2]))
    if "--camera-manifest" not in values:
        raise RuntimeError("Missing --camera-manifest")
    tolerance = float(values.get("--tolerance-px", "3"))
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise RuntimeError("--tolerance-px must be positive")
    return values["--camera-manifest"], tolerance


def main():
    from source_camera_camera import configure_source_camera

    manifest_path, tolerance = parse_args()
    with open(manifest_path, "r", encoding="utf-8") as stream:
        camera_manifest = json.load(stream)
    scene = __import__("bpy").context.scene
    for obj in list(__import__("bpy").data.objects):
        __import__("bpy").data.objects.remove(obj, do_unlink=True)
    camera, width, height = configure_source_camera(scene, camera_manifest, 20.0)
    results = []
    failures = []
    for point in camera_manifest["controlPoints"]:
        projected = world_to_camera_view(scene, camera, Vector(point["worldPoint"]))
        x = projected.x * width
        y = (1.0 - projected.y) * height
        observed = point["imagePoint"]
        error_pixels = math.hypot(x - observed["x"], y - observed["y"])
        result = {"id": point["id"], "projected": {"x": x, "y": y},
                  "observed": observed, "errorPixels": error_pixels}
        results.append(result)
        if error_pixels > tolerance:
            failures.append(result)
    report = {
        "schemaVersion": "1.0.0",
        "status": "passed" if not failures else "failed",
        "projectionTolerancePixels": tolerance,
        "cameraId": camera_manifest["id"],
        "imageSize": {"width": width, "height": height},
        "results": results,
        "failures": failures,
        "publicationEligible": False,
    }
    print(json.dumps(report, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
