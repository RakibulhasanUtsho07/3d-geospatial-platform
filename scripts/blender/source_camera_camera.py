import math
import re
import bpy
from mathutils import Quaternion, Vector


SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$", re.IGNORECASE)


def configure_source_camera(scene, camera_evidence, max_dimension):
    """Create a Blender perspective camera from reviewed pixel intrinsics and pose."""
    if not isinstance(camera_evidence, dict) or camera_evidence.get("schemaVersion") != "1.0.0":
        raise RuntimeError("Unsupported source-camera manifest schema")
    if camera_evidence.get("calibrationStatus") != "verified":
        raise RuntimeError("Source-camera calibration is not independently verified")
    for key in ("calibrationEvidence", "frameAlignmentEvidence"):
        evidence = camera_evidence.get(key, {})
        if not evidence.get("id") or not SHA256_PATTERN.fullmatch(str(evidence.get("sha256", ""))):
            raise RuntimeError("Source-camera calibration and model-frame alignment evidence hashes are required")
    if not isinstance(camera_evidence.get("coordinateFrame"), str) or not camera_evidence["coordinateFrame"].strip():
        raise RuntimeError("Source-camera coordinate frame is required")

    image = camera_evidence.get("sourceImage", {})
    intrinsics = camera_evidence.get("intrinsics", {})
    pose = camera_evidence.get("pose", {})
    width, height = image.get("width"), image.get("height")
    fx, fy, cx, cy = (intrinsics.get(key) for key in ("fx", "fy", "cx", "cy"))
    position = pose.get("position")
    quaternion = pose.get("quaternionWxyz")
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1:
        raise RuntimeError("Source-camera image dimensions are invalid")
    if not SHA256_PATTERN.fullmatch(str(image.get("sha256", ""))):
        raise RuntimeError("Source-image SHA-256 is missing or invalid")
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (fx, fy, cx, cy)):
        raise RuntimeError("Source-camera intrinsics are invalid")
    if fx <= 0 or fy <= 0 or not (0 <= cx < width and 0 <= cy < height):
        raise RuntimeError("Source-camera focal lengths or principal point are out of bounds")
    if intrinsics.get("distortionModel") not in ("none", "rectified"):
        raise RuntimeError("Source image must be undistorted or rectified before same-camera rendering")
    if not isinstance(position, list) or len(position) != 3 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in position):
        raise RuntimeError("Source-camera position is invalid")
    if not isinstance(quaternion, list) or len(quaternion) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in quaternion):
        raise RuntimeError("Source-camera quaternion is invalid")
    quaternion_norm = math.sqrt(sum(value * value for value in quaternion))
    if abs(quaternion_norm - 1.0) > 1e-3:
        raise RuntimeError("Source-camera quaternion must be unit length")
    control_points = camera_evidence.get("controlPoints")
    if not isinstance(control_points, list) or len(control_points) < 4:
        raise RuntimeError("At least four checked source-camera control points are required")
    if not isinstance(max_dimension, (int, float)) or not math.isfinite(max_dimension) or max_dimension <= 0:
        raise RuntimeError("Model dimension must be positive to configure source camera clipping")

    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = 1.0
    scene.render.pixel_aspect_y = fx / fy
    camera_id = camera_evidence.get("id", "unknown")
    camera_data = bpy.data.cameras.new("SourcePhotoCamera_" + camera_id)
    camera = bpy.data.objects.new("SourcePhotoCamera_" + camera_id, camera_data)
    scene.collection.objects.link(camera)
    camera_data.type = "PERSP"
    camera_data.sensor_fit = "HORIZONTAL"
    camera_data.sensor_width = 36.0
    camera_data.lens = fx * camera_data.sensor_width / width
    # Blender shift is relative to image width. Keep the supplied, potentially
    # off-centre principal point; never auto-fit or recenter the camera.
    camera_data.shift_x = (width / 2.0 - cx) / width
    camera_data.shift_y = (cy - height / 2.0) / width
    camera_data.clip_start = 0.001
    camera_data.clip_end = max(float(max_dimension) * 1000.0, 1000.0)
    camera.location = Vector(position)
    camera.rotation_mode = "QUATERNION"
    camera.rotation_quaternion = Quaternion((quaternion[0], quaternion[1], quaternion[2], quaternion[3]))
    scene.camera = camera
    return camera, width, height
