import bpy
import hashlib
import json
import math
import os
import re
import sys
from array import array
from mathutils import Vector

def parse_args():
    if "--" not in sys.argv:
        raise RuntimeError("Missing Blender script arguments after --")
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) % 2:
        raise RuntimeError("Expected key/value argument pairs")
    values = dict(zip(args[::2], args[1::2]))
    required = ["--model", "--output-dir", "--resolution"]
    if any(key not in values for key in required):
        raise RuntimeError("Missing --model, --output-dir or --resolution")
    return values

def ensure_world(scene):
    if scene.world is None:
        scene.world = bpy.data.worlds.new("RenderReviewWorld")
    world = scene.world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (0.13, 0.15, 0.18, 1.0)
        background.inputs["Strength"].default_value = 0.45

def add_area_light(name, position, center, power, size):
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = power
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (center - obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj

def read_front_facing_azimuth(model_path):
    """Read optional model-local facade bearing from the GLB JSON extras."""
    with open(model_path, "rb") as stream:
        data = stream.read()
    if len(data) < 20 or data[0:4] != b"glTF" or int.from_bytes(data[4:8], "little") != 2:
        raise RuntimeError("Input is not a valid GLB 2.0 container")
    declared_length = int.from_bytes(data[8:12], "little")
    json_length = int.from_bytes(data[12:16], "little")
    if declared_length != len(data) or data[16:20] != b"JSON" or 20 + json_length > len(data):
        raise RuntimeError("GLB JSON header or declared length is invalid")
    try:
        document = json.loads(data[20:20 + json_length].decode("utf-8").strip())
    except Exception as error:
        raise RuntimeError("GLB JSON chunk could not be read: " + str(error))
    building = (document.get("extras") or {}).get("building") or {}
    angle = building.get("frontFacingAzimuthDegrees")
    if angle is None:
        return None
    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not math.isfinite(angle) or angle < 0 or angle > 360:
        raise RuntimeError("GLB frontFacingAzimuthDegrees must be a finite bearing from 0 to 360")
    return float(angle)


DEFAULT_REVIEW_PROFILE = {
    "schemaVersion": "1.0.0",
    "profileId": "generic-whole-model-v1",
    "excludeNodeNamePrefixes": [],
    "frontView": {
        "includeNodeNames": [],
        "excludeNodeNames": [],
        "elevationDegrees": 5,
        "framingLabel": "whole-model-generic-front",
    },
}


def normalize_node_name(name):
    """Remove only Blender's numeric duplicate suffix, preserving other punctuation."""
    return re.sub(r"\.\d{3}$", "", name)


def validate_profile_name_list(value, label):
    if not isinstance(value, list):
        raise RuntimeError(label + " must be a list of exact node-name strings")
    result = []
    for index, name in enumerate(value):
        if not isinstance(name, str) or not name.strip() or len(name) > 200 or "*" in name:
            raise RuntimeError(label + "[" + str(index) + "] must be a non-empty exact node name without wildcards")
        result.append(name.strip())
    if len(set(result)) != len(result):
        raise RuntimeError(label + " must not contain duplicates")
    return result


def read_review_profile(opts):
    """Load explicit, review-only selectors or the generic whole-model default."""
    if "--review-profile-json" in opts:
        profile_path = os.path.abspath(opts["--review-profile-json"])
        with open(profile_path, "rb") as stream:
            profile_bytes = stream.read()
        try:
            profile = json.loads(profile_bytes.decode("utf-8"))
        except Exception as error:
            raise RuntimeError("Review profile JSON is invalid: " + str(error))
        source = "explicit-file"
        profile_hash = hashlib.sha256(profile_bytes).hexdigest()
        expected_hash = opts.get("--review-profile-sha256")
        if expected_hash is not None and expected_hash != profile_hash:
            raise RuntimeError("Review profile changed after preflight; SHA-256 does not match")
    else:
        profile = json.loads(json.dumps(DEFAULT_REVIEW_PROFILE))
        profile_bytes = json.dumps(profile, sort_keys=True, separators=(",", ":")).encode("utf-8")
        profile_hash = hashlib.sha256(profile_bytes).hexdigest()
        source = "built-in-default"

    if not isinstance(profile, dict):
        raise RuntimeError("Review profile must be a JSON object")
    allowed_keys = {"schemaVersion", "profileId", "excludeNodeNamePrefixes", "frontView"}
    unknown_keys = set(profile) - allowed_keys
    if unknown_keys:
        raise RuntimeError("Unsupported review profile field: " + ", ".join(sorted(unknown_keys)))
    if profile.get("schemaVersion") != "1.0.0":
        raise RuntimeError("Review profile schemaVersion must be 1.0.0")
    profile_id = profile.get("profileId")
    if not isinstance(profile_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", profile_id):
        raise RuntimeError("Review profile profileId must be a short stable identifier")
    exclude_prefixes = validate_profile_name_list(profile.get("excludeNodeNamePrefixes", []), "excludeNodeNamePrefixes")
    front = profile.get("frontView", {})
    if not isinstance(front, dict):
        raise RuntimeError("Review profile frontView must be an object")
    allowed_front_keys = {"includeNodeNames", "excludeNodeNames", "elevationDegrees", "framingLabel"}
    unknown_front_keys = set(front) - allowed_front_keys
    if unknown_front_keys:
        raise RuntimeError("Unsupported frontView field: " + ", ".join(sorted(unknown_front_keys)))
    include_names = validate_profile_name_list(front.get("includeNodeNames", []), "frontView.includeNodeNames")
    exclude_names = validate_profile_name_list(front.get("excludeNodeNames", []), "frontView.excludeNodeNames")
    overlap = set(include_names).intersection(exclude_names)
    if overlap:
        raise RuntimeError("Front-view node names cannot be both included and excluded: " + ", ".join(sorted(overlap)))
    elevation = front.get("elevationDegrees", 5)
    if isinstance(elevation, bool) or not isinstance(elevation, (int, float)) or not math.isfinite(elevation) or elevation < 0 or elevation > 60:
        raise RuntimeError("frontView.elevationDegrees must be between 0 and 60")
    framing = front.get("framingLabel", "whole-model-generic-front")
    if not isinstance(framing, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,79}", framing):
        raise RuntimeError("frontView.framingLabel must be a short human-readable label")
    return {
        "schemaVersion": "1.0.0",
        "profileId": profile_id,
        "excludeNodeNamePrefixes": exclude_prefixes,
        "frontView": {
            "includeNodeNames": include_names,
            "excludeNodeNames": exclude_names,
            "elevationDegrees": float(elevation),
            "framingLabel": framing,
        },
    }, {"profileId": profile_id, "source": source, "sha256": profile_hash}


def scene_bounds(mesh_objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in mesh_objects:
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            points.append(evaluated.matrix_world @ Vector(corner))
    if not points:
        raise RuntimeError("The imported GLB has no mesh bounds")
    minimum = [min(point[axis] for point in points) for axis in range(3)]
    maximum = [max(point[axis] for point in points) for axis in range(3)]
    dimensions = [maximum[axis] - minimum[axis] for axis in range(3)]
    if max(dimensions) <= 1e-9:
        raise RuntimeError("The imported GLB bounds have zero extent")
    center = Vector([(minimum[axis] + maximum[axis]) / 2.0 for axis in range(3)])
    return minimum, maximum, dimensions, center

def projected_ortho_scale(mesh_objects, view_center, direction, padding=1.15):
    """Fit an orthographic camera to the visible geometry projected into this view."""
    camera_location = view_center + direction.normalized()
    rotation = (view_center - camera_location).to_track_quat("-Z", "Y")
    camera_right = rotation @ Vector((1.0, 0.0, 0.0))
    camera_up = rotation @ Vector((0.0, 1.0, 0.0))
    depsgraph = bpy.context.evaluated_depsgraph_get()
    projected_right = []
    projected_up = []
    for obj in mesh_objects:
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            point = evaluated.matrix_world @ Vector(corner)
            delta = point - view_center
            projected_right.append(delta.dot(camera_right))
            projected_up.append(delta.dot(camera_up))
    if not projected_right or not projected_up:
        raise RuntimeError("Cannot fit orthographic view without projected mesh bounds")
    width = max(projected_right) - min(projected_right)
    height = max(projected_up) - min(projected_up)
    span = max(width, height)
    if span <= 1e-9:
        raise RuntimeError("Projected mesh bounds have zero extent")
    return span * padding


def render_source_camera(opts, meshes, scene, output_dir, dimensions, center):
    """Render the candidate using an explicit, reviewed source-photo camera."""
    camera_path = os.path.abspath(opts["--source-camera-json"])
    module_dir = os.path.abspath(opts["--source-camera-module-dir"])
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    from source_camera_camera import configure_source_camera

    with open(camera_path, "r", encoding="utf-8") as stream:
        camera_evidence = json.load(stream)
    image = camera_evidence.get("sourceImage", {})
    intrinsics = camera_evidence.get("intrinsics", {})
    pose = camera_evidence.get("pose", {})
    camera, width, height = configure_source_camera(
        scene, camera_evidence, max(math.sqrt(sum(value * value for value in dimensions)), 1.0)
    )
    filename = "source-camera.png"
    scene.render.filepath = os.path.join(output_dir, filename)
    bpy.ops.render.render(write_still=True)
    rendered_path = os.path.join(output_dir, filename)
    if not os.path.isfile(rendered_path):
        raise RuntimeError("Blender reported success but the source-camera render is missing")
    rendered = bpy.data.images.load(rendered_path, check_existing=False)
    try:
        stats = sample_pixel_statistics(rendered, width)
    finally:
        bpy.data.images.remove(rendered)
    # A PNG file and valid dimensions are not proof that the GLB was visible.
    # Reject a near-uniform frame so an empty/background-only render can never
    # receive a same-camera-comparable status.
    if stats["sampledPixels"] < 1 or stats["luminanceStandardDeviation"] < 0.01:
        raise RuntimeError("source-camera-render-has-no-visible-geometry-content")
    view = {
        "id": camera_evidence.get("id"),
        "filename": filename,
        "width": width,
        "height": height,
        "renderComplete": True,
        "pixelStatistics": stats,
        "sourceImage": image,
        "intrinsics": intrinsics,
        "pose": pose,
        "coordinateFrame": camera_evidence.get("coordinateFrame"),
        "calibrationEvidence": camera_evidence.get("calibrationEvidence"),
        "frameAlignmentEvidence": camera_evidence.get("frameAlignmentEvidence"),
        "crop": image.get("crop"),
    }
    # Keep the camera datablock reference before removing its object: Blender
    # invalidates the object's RNA wrapper after unlink/removal.
    camera_data = camera.data
    scene.camera = None
    bpy.data.objects.remove(camera, do_unlink=True)
    bpy.data.cameras.remove(camera_data)
    print("Rendered calibrated source camera -> " + filename)
    return view


def sample_pixel_statistics(image, resolution):
    total = int(image.size[0] * image.size[1])
    if total < 1:
        raise RuntimeError("Render result has no pixels")
    pixels = array("f", [0.0]) * (total * 4)
    image.pixels.foreach_get(pixels)
    stride = max(1, int(math.ceil(total / 60000.0)))
    count = 0
    mean = 0.0
    m2 = 0.0
    transparent = 0
    sampled = 0
    for pixel_index in range(0, total, stride):
        base = pixel_index * 4
        r = pixels[base]
        g = pixels[base + 1]
        b = pixels[base + 2]
        alpha = pixels[base + 3]
        sampled += 1
        if alpha < 0.05:
            transparent += 1
            continue
        luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        count += 1
        delta = luminance - mean
        mean += delta / count
        m2 += delta * (luminance - mean)
    variance = m2 / count if count else 0.0
    return {
        "sampledPixels": sampled,
        "luminanceMean": round(mean, 6),
        "luminanceStandardDeviation": round(math.sqrt(max(variance, 0.0)), 6),
        "transparentRatio": round(transparent / sampled if sampled else 1.0, 6),
    }

def main():
    opts = parse_args()
    model_path = os.path.abspath(opts["--model"])
    output_dir = os.path.abspath(opts["--output-dir"])
    resolution = int(opts["--resolution"])
    if not os.path.isfile(model_path):
        raise RuntimeError("Input model does not exist: " + model_path)
    if not os.path.isdir(output_dir):
        raise RuntimeError("Output directory must already exist: " + output_dir)
    if resolution < 256 or resolution > 2048 or (resolution & (resolution - 1)) != 0:
        raise RuntimeError("Resolution must be a power-of-two value between 256 and 2048")

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=model_path)
    imported_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    review_profile, review_profile_evidence = read_review_profile(opts)
    excluded_prefixes = review_profile["excludeNodeNamePrefixes"]
    excluded_meshes = [
        obj for obj in imported_meshes
        if any(normalize_node_name(obj.name).startswith(prefix) for prefix in excluded_prefixes)
    ]
    for obj in excluded_meshes:
        obj.hide_render = True
    meshes = [obj for obj in imported_meshes if obj not in excluded_meshes]
    if not meshes:
        raise RuntimeError("The imported GLB has no renderable meshes after applying the review profile")

    minimum, maximum, dimensions, center = scene_bounds(meshes)
    max_dimension = max(dimensions)
    camera_distance = max_dimension * 3.0

    front_profile = review_profile["frontView"]
    include_names = set(front_profile["includeNodeNames"])
    exclude_names = set(front_profile["excludeNodeNames"])
    available_names = {normalize_node_name(obj.name) for obj in meshes}
    missing_front_names = sorted(include_names - available_names)
    if missing_front_names:
        raise RuntimeError("Review profile references missing front-view nodes: " + ", ".join(missing_front_names))
    front_review_meshes = [
        obj for obj in meshes
        if (not include_names or normalize_node_name(obj.name) in include_names)
        and normalize_node_name(obj.name) not in exclude_names
    ]
    if not front_review_meshes:
        raise RuntimeError("Review profile selects no visible meshes for the front view")
    _, _, front_review_dimensions, front_review_center = scene_bounds(front_review_meshes)
    front_camera_distance = max(front_review_dimensions) * 3.0
    front_view_framing = front_profile["framingLabel"]
    front_elevation = math.radians(front_profile["elevationDegrees"])
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 12
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.resolution_percentage = 100
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    ensure_world(scene)

    # Tune the inspection rig to retain the salmon facade, darker recesses and step shadows.
    # Power remains dimension-scaled and clamped so render reviews stay deterministic.
    light_power = max(1000.0, min(450000.0, max_dimension * max_dimension * 29.0))
    light_size = max_dimension * 0.68
    light_offset = max_dimension * 0.65
    add_area_light("ReviewKeyLight", center + Vector((1.4, -1.8, 2.2)) * light_offset, center, light_power, light_size)
    add_area_light("ReviewFillLight", center + Vector((-1.8, -0.3, 1.0)) * light_offset, center, light_power * 0.33, light_size * 1.05)
    add_area_light("ReviewRimLight", center + Vector((0.3, 1.7, 1.5)) * light_offset, center, light_power * 0.38, light_size)

    # Use the declared facade bearing when present, and keep a deterministic
    # legacy direction when a GLB does not record its intended front facade.
    # The review profile controls front-view elevation and visible mesh selection.
    front_azimuth = read_front_facing_azimuth(model_path)
    if front_azimuth is None:
        views = [
            ("front", Vector((0.0, -math.cos(front_elevation), math.sin(front_elevation))), "ORTHO"),
            ("back", Vector((0.0, 1.0, 0.0)), "ORTHO"),
            ("left", Vector((-1.0, 0.0, 0.0)), "ORTHO"),
            ("right", Vector((1.0, 0.0, 0.0)), "ORTHO"),
            ("top", Vector((0.0, 0.0, 1.0)), "ORTHO"),
        ]
        front_axis_source = "renderer-default"
    else:
        bearing = math.radians(front_azimuth)
        sin_bearing, cos_bearing = math.sin(bearing), math.cos(bearing)
        views = [
            ("front", Vector((sin_bearing * math.cos(front_elevation),
                              -cos_bearing * math.cos(front_elevation),
                              math.sin(front_elevation)), "ORTHO"),
            ("back", Vector((-sin_bearing, cos_bearing, 0.0), "ORTHO"),
            ("left", Vector((cos_bearing, -sin_bearing, 0.0), "ORTHO"),
            ("right", Vector((-cos_bearing, sin_bearing, 0.0), "ORTHO"),
            ("top", Vector((0.0, 0.0, 1.0), "ORTHO"),
        ]
        front_axis_source = "glb-extras.frontFacingAzimuthDegrees"
    elevation = math.radians(22.0)
    for angle in range(0, 360, 45):
        azimuth = math.radians(angle)
        direction = Vector((math.cos(azimuth) * math.cos(elevation),
                            math.sin(azimuth) * math.cos(elevation),
                            math.sin(elevation)))
        views.append(("turntable-" + str(angle).zfill(3), direction, "ORTHO"))

    original_render_visibility = [(obj, obj.hide_render) for obj in meshes]
    raw_views = []
    for view_id, direction, camera_type in views:
        direction.normalize()
        # Restore normal visibility before each view; only a profile can focus
        # or exclude mesh nodes for the dedicated front-detail view.
        for obj, was_hidden in original_render_visibility:
            obj.hide_render = was_hidden
        if view_id == "front":
            for obj in meshes:
                if obj not in front_review_meshes:
                    obj.hide_render = True
            visible_meshes = front_review_meshes
            view_center = front_review_center
            view_distance = front_camera_distance
            view_framing = front_view_framing
        else:
            visible_meshes = meshes
            view_center = center
            view_distance = camera_distance
            view_framing = "whole-model"
        view_scale = projected_ortho_scale(visible_meshes, view_center, direction)
        camera_data = bpy.data.cameras.new("ReviewCamera_" + view_id)
        camera = bpy.data.objects.new("ReviewCamera_" + view_id, camera_data)
        scene.collection.objects.link(camera)
        camera_data.type = camera_type
        camera_data.ortho_scale = view_scale
        camera.location = view_center + direction * view_distance
        camera.rotation_euler = (view_center - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = camera
        filename = view_id + ".png"
        scene.render.filepath = os.path.join(output_dir, filename)
        bpy.ops.render.render(write_still=True)
        # Blender 4.x can release the headless Render Result pixel buffer
        # after saving the PNG. Reload the saved file so statistics are based
        # on the exact artifact whose SHA-256 is recorded by the Node runner.
        rendered_path = os.path.join(output_dir, filename)
        if not os.path.isfile(rendered_path):
            raise RuntimeError("Blender reported success but the render file is missing: " + rendered_path)
        result = bpy.data.images.load(rendered_path, check_existing=False)
        try:
            stats = sample_pixel_statistics(result, resolution)
        finally:
            bpy.data.images.remove(result)
        raw_views.append({
            "id": view_id,
            "filename": filename,
            "width": resolution,
            "height": resolution,
            "renderComplete": True,
            "framing": view_framing,
            "pixelStatistics": stats,
        })
        bpy.data.objects.remove(camera, do_unlink=True)
        bpy.data.cameras.remove(camera_data)
        print("Rendered " + view_id + " -> " + filename)

    source_camera_view = None
    source_camera_render_error = None
    if "--source-camera-json" in opts:
        try:
            source_camera_view = render_source_camera(opts, meshes, scene, output_dir, dimensions, center)
        except Exception as error:
            # Preserve the already completed canonical review renders. The Node
            # wrapper emits a not-comparable sidecar and non-zero exit for this
            # failed optional view; never treat it as a successful camera pair.
            source_camera_render_error = "blender-source-camera-render-failed"
            partial_source_path = os.path.join(output_dir, "source-camera.png")
            if os.path.isfile(partial_source_path):
                os.remove(partial_source_path)
            print("Source-camera render failed: " + str(error), file=sys.stderr)
            source_camera_view = {
                "id": None,
                "filename": "source-camera.png",
                "renderComplete": False,
                "errorCode": source_camera_render_error,
                "errorMessage": str(error)[:1000],
            }

    raw_manifest = {
        "schemaVersion": "1.0.0",
        "renderer": "Blender",
        "rendererVersion": bpy.app.version_string,
        "width": resolution,
        "height": resolution,
        "frontFacingAzimuthDegrees": front_azimuth,
        "frontAxisSource": front_axis_source,
        "reviewProfile": {
            **review_profile_evidence,
            "globalExcludedMeshCount": len(excluded_meshes),
            "frontVisibleMeshCount": len(front_review_meshes),
            "frontFramingLabel": front_view_framing,
        },
        "sceneBounds": {
            "min": [round(float(value), 8) for value in minimum],
            "max": [round(float(value), 8) for value in maximum],
            "dimensions": [round(float(value), 8) for value in dimensions],
            "coordinateUnits": "imported-model-units-unverified",
        },
        "views": raw_views,
        "sourceCameraView": source_camera_view,
    }
    raw_path = os.path.join(output_dir, ".blender-render-manifest.raw.json")
    with open(raw_path, "x", encoding="utf-8") as stream:
        json.dump(raw_manifest, stream, indent=2)
        stream.write("\n")
    print("Wrote raw render manifest: " + raw_path)

if __name__ == "__main__":
    main()
