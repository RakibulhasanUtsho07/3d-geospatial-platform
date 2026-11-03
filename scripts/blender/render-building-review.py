import bpy
import json
import math
import os
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

DEFAULT_FRONT_BEARING_DEGREES = 180.0


def camera_direction_from_bearing(bearing_degrees, elevation_degrees=0.0):
    """Return a Blender-world camera direction after glTF import: X east, Y north, Z up."""
    bearing = math.radians(float(bearing_degrees) % 360.0)
    elevation = math.radians(float(elevation_degrees))
    horizontal = math.cos(elevation)
    return (
        math.sin(bearing) * horizontal,
        math.cos(bearing) * horizontal,
        math.sin(elevation),
    )


def camera_track_up_axis(direction):
    """Use Blender Z-up for horizon views and north (+Y) as roll reference for top view."""
    return "Y" if abs(float(direction[2])) > 0.999 else "Z"


def build_review_view_directions(front_bearing_degrees=None, front_elevation_degrees=5.0, turntable_elevation_degrees=22.0):
    """Build front-relative orthographic views and a compass-clockwise eight-view turntable."""
    bearing = DEFAULT_FRONT_BEARING_DEGREES if front_bearing_degrees is None else float(front_bearing_degrees)
    return [
        ("front", camera_direction_from_bearing(bearing, front_elevation_degrees)),
        ("back", camera_direction_from_bearing(bearing + 180.0, 0.0)),
        # The camera is outside the facade looking toward the building. From that
        # viewing position, left is front-bearing +90 degrees and right is -90.
        ("left", camera_direction_from_bearing(bearing + 90.0, 0.0)),
        ("right", camera_direction_from_bearing(bearing - 90.0, 0.0)),
        ("top", (0.0, 0.0, 1.0)),
    ] + [
        (
            "turntable-" + str(angle).zfill(3),
            camera_direction_from_bearing(angle, turntable_elevation_degrees),
        )
        for angle in range(0, 360, 45)
    ]


def read_front_facing_azimuth(model_path):
    """Read an optional front-bearing from GLB JSON extras without loading the binary chunk."""
    with open(model_path, "rb") as stream:
        header = stream.read(12)
        if len(header) != 12 or header[0:4] != b"glTF" or int.from_bytes(header[4:8], "little") != 2:
            raise RuntimeError("Input is not a valid GLB 2.0 container")
        declared_length = int.from_bytes(header[8:12], "little")
        if declared_length != os.path.getsize(model_path):
            raise RuntimeError("GLB declared length does not match the file size")
        chunk_header = stream.read(8)
        if len(chunk_header) != 8 or chunk_header[4:8] != b"JSON":
            raise RuntimeError("GLB JSON chunk header is invalid")
        json_length = int.from_bytes(chunk_header[0:4], "little")
        json_bytes = stream.read(json_length)
        if len(json_bytes) != json_length or stream.tell() > declared_length:
            raise RuntimeError("GLB JSON chunk is truncated or exceeds the declared length")
    try:
        document = json.loads(json_bytes.decode("utf-8").strip())
    except Exception as error:
        raise RuntimeError("GLB JSON chunk could not be read: " + str(error))
    building = (document.get("extras") or {}).get("building") or {}
    angle = building.get("frontFacingAzimuthDegrees")
    coordinate_frame = building.get("coordinateFrame")
    if angle is None:
        source = building.get("frontAxisSource", "renderer-default")
        if source != "renderer-default":
            raise RuntimeError("GLB frontAxisSource requires a frontFacingAzimuthDegrees value")
        return None, "unknown", coordinate_frame, source
    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not math.isfinite(angle) or angle < 0 or angle > 360:
        raise RuntimeError("GLB frontFacingAzimuthDegrees must be a finite bearing from 0 to 360")
    expected_frame = "gltf-right-handed-x-east-y-up-z-south"
    if coordinate_frame != expected_frame:
        raise RuntimeError("GLB with a geographic front bearing must declare coordinateFrame " + expected_frame)
    confidence = building.get("frontAxisConfidence", "unknown")
    if confidence not in ["verified", "derived", "estimated", "ai-proposed", "unknown", "operator-specified"]:
        raise RuntimeError("GLB frontAxisConfidence is unsupported")
    source = building.get("frontAxisSource")
    valid_sources = {
        "buildingSpec.architecture.frontFacingAzimuthDegrees",
        "buildingSpec.architecture.frontFacadeEdgeIndex",
        "longest-edge-inferred",
    }
    if not isinstance(source, str) or source not in valid_sources:
        raise RuntimeError("GLB frontAxisSource is missing or unsupported")
    return float(angle), confidence, coordinate_frame, source



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
    rotation = (view_center - camera_location).to_track_quat("-Z", camera_track_up_axis(direction))
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
    # Keep site context in the source GLB, but hide it for model-detail review.
    # Large Site_Ground / Site_River planes otherwise make the palace tiny.
    site_context_meshes = [
        obj for obj in imported_meshes
        if obj.name.split(".")[0].startswith("Site_")
    ]
    for obj in site_context_meshes:
        obj.hide_render = True
    meshes = [obj for obj in imported_meshes if obj not in site_context_meshes]
    if not meshes:
        raise RuntimeError("The imported GLB has no building meshes after excluding Site_ context nodes")
    minimum, maximum, dimensions, center = scene_bounds(meshes)
    max_dimension = max(dimensions)
    camera_distance = max_dimension * 3.0

    # Keep the heritage-specific facade framing where its named meshes exist, but
    # never make those names a prerequisite for reviewing an ordinary building GLB.
    # Other buildings use the complete non-site mesh set for the canonical front view.
    # Whole-model views restore it and retain the complete generated roof geometry.
    rangmahal_review_names = {
        "Rangmahal_GF", "Rangmahal_FF", "Portico_S", "Portico_N",
        "Stair_S", "Veranda_S", "Dome_Drum", "Dome", "Finial",
    }
    rangmahal_review_meshes = [
        obj for obj in meshes if obj.name.split(".")[0] in rangmahal_review_names
    ]
    focus_rangmahal = bool(rangmahal_review_meshes)
    if focus_rangmahal:
        _, _, rangmahal_dimensions, rangmahal_center = scene_bounds(rangmahal_review_meshes)
        front_review_meshes = rangmahal_review_meshes
        front_review_center = rangmahal_center
        front_camera_distance = max(rangmahal_dimensions) * 3.0
        front_view_framing = "rangmahal-south-facade-focused"
    else:
        front_review_meshes = meshes
        front_review_center = center
        front_camera_distance = camera_distance
        front_view_framing = "whole-model-generic-front"
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
    # Blender's glTF importer converts (x, y, z) to (x, -z, y): Z-up.
    add_area_light("ReviewKeyLight", center + Vector((1.4, -1.8, 2.2)) * light_offset, center, light_power, light_size)
    add_area_light("ReviewFillLight", center + Vector((-1.8, -0.3, 1.0)) * light_offset, center, light_power * 0.33, light_size * 1.05)
    add_area_light("ReviewRimLight", center + Vector((0.3, 1.7, 1.5)) * light_offset, center, light_power * 0.38, light_size)

    # The GLB stores a right-handed map frame: X east, Y up, Z south.
    # Blender's glTF importer maps it to X east, Y north, Z up.
    # A missing bearing uses a deterministic south-facing default, not real-world evidence.
    front_azimuth, front_axis_confidence, model_coordinate_frame, front_axis_source = read_front_facing_azimuth(model_path)
    if front_azimuth is None:
        front_axis_source = "renderer-default"
        front_axis_confidence = "unknown"
    front_elevation_degrees = 5.0
    effective_front_bearing = DEFAULT_FRONT_BEARING_DEGREES if front_azimuth is None else front_azimuth
    views = [
        (view_id, Vector(direction), "ORTHO")
        for view_id, direction in build_review_view_directions(
            front_azimuth,
            front_elevation_degrees=front_elevation_degrees,
        )
    ]

    original_render_visibility = [(obj, obj.hide_render) for obj in meshes]
    raw_views = []
    for view_id, direction, camera_type in views:
        direction.normalize()
        # Restore the normal whole-model visibility before every camera. The
        # focused front image intentionally isolates the river-facing Rangmahal
        # so the rear Andarmahal/whole-footprint roof rails cannot clip the facade.
        for obj, was_hidden in original_render_visibility:
            obj.hide_render = was_hidden
        if view_id == "front":
            if focus_rangmahal:
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
        camera.rotation_euler = (view_center - camera.location).to_track_quat(
            "-Z", camera_track_up_axis(direction)
        ).to_euler()
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
        "modelCoordinateFrame": model_coordinate_frame,
        "frontCameraEffectiveBearingDegrees": effective_front_bearing,
        "frontAxisConfidence": front_axis_confidence,
        "frontAxisSource": front_axis_source,
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
