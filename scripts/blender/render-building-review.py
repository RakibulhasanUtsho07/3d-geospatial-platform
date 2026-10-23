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
    values.setdefault("--render-profile", "building-review-cycles-cpu-v1")
    allowed_profiles = ("building-review-cycles-cpu-v1", "ahsan-manzil-y-up-cycles-cpu-v1")
    if values["--render-profile"] not in allowed_profiles:
        raise RuntimeError("Unsupported render profile: " + values["--render-profile"])
    return values

def ensure_world(scene):
    if scene.world is None:
        scene.world = bpy.data.worlds.new("RenderReviewWorld")
    world = scene.world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (0.38, 0.40, 0.43, 1.0)
        background.inputs["Strength"].default_value = 0.7

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

def rounded_vector(vector):
    return [round(float(vector[axis]), 8) for axis in range(3)]

def light_manifest(light):
    return {
        "name": light.name,
        "type": light.data.type,
        "positionWorld": rounded_vector(light.location),
        "energy": round(float(light.data.energy), 6),
        "size": round(float(light.data.size), 6),
    }

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
    render_profile = opts["--render-profile"]
    if not os.path.isfile(model_path):
        raise RuntimeError("Input model does not exist: " + model_path)
    if not os.path.isdir(output_dir):
        raise RuntimeError("Output directory must already exist: " + output_dir)
    if resolution < 256 or resolution > 2048 or (resolution & (resolution - 1)) != 0:
        raise RuntimeError("Resolution must be a power-of-two value between 256 and 2048")

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=model_path)
    all_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    excluded_render_object_names = []
    if render_profile == "ahsan-manzil-y-up-cycles-cpu-v1":
        # Site/context meshes (notably trees that otherwise cover the stair and
        # facade) are hidden from the architectural comparison render. The model
        # remains unmodified; only this review scene's visibility changes.
        # Keep Site_Ground for a stable ground/shadow reference.
        context_nodes_to_hide = {
            "Site_Approach", "Site_Context_Blocks", "Site_Family_Mosque",
            "Site_Pond", "Site_River", "Site_Stable", "Site_Trees",
        }
        existing_bases = {obj.name.split(".")[0] for obj in all_meshes}
        missing_context_nodes = context_nodes_to_hide - existing_bases
        if missing_context_nodes:
            raise RuntimeError("Ahsan Manzil GLB is missing expected context nodes: " + ", ".join(sorted(missing_context_nodes)))
        for obj in all_meshes:
            base_name = obj.name.split(".")[0]
            if base_name in context_nodes_to_hide:
                obj.hide_render = True
                excluded_render_object_names.append(base_name)
        excluded_render_object_names.sort()

        # Camera bounds must use palace/plan nodes only; the 440 m site context
        # previously reduced the palace to a tiny strip in the render.
        heritage_node_names = {
            "Plinth", "Rangmahal_GF", "Rangmahal_FF", "Portico_S", "Portico_N",
            "Stair_S", "Veranda_S", "Veranda_N", "Parapet", "Dome_Drum",
            "Dome", "Finial", "Andarmahal",
        }
        meshes = [obj for obj in all_meshes if obj.name.split(".")[0] in heritage_node_names]
        missing_nodes = heritage_node_names - {obj.name.split(".")[0] for obj in meshes}
        if missing_nodes:
            raise RuntimeError("Ahsan Manzil GLB is missing camera-framing nodes: " + ", ".join(sorted(missing_nodes)))
        if len(meshes) != len(heritage_node_names):
            raise RuntimeError("Ahsan Manzil camera-framing nodes are duplicated or ambiguous")

        # The pinned front and southeast-oblique references depict the
        # dome-bearing Rangmahal, not a full 125.4 m footprint panorama.
        # Match those two views to Rangmahal semantic bounds; keep whole-palace
        # framing for the remaining inspection views.
        reference_view_node_names = {
            "Rangmahal_GF", "Rangmahal_FF", "Portico_S", "Portico_N",
            "Stair_S", "Veranda_S", "Dome_Drum", "Dome", "Finial",
        }
        reference_meshes = [
            obj for obj in meshes if obj.name.split(".")[0] in reference_view_node_names
        ]
        missing_reference_nodes = reference_view_node_names - {
            obj.name.split(".")[0] for obj in reference_meshes
        }
        if missing_reference_nodes:
            raise RuntimeError(
                "Ahsan Manzil GLB is missing reference-view nodes: " +
                ", ".join(sorted(missing_reference_nodes))
            )
        if len(reference_meshes) != len(reference_view_node_names):
            raise RuntimeError("Ahsan Manzil reference-view nodes are duplicated or ambiguous")
    else:
        meshes = all_meshes
        reference_meshes = meshes
    minimum, maximum, dimensions, center = scene_bounds(meshes)
    max_dimension = max(dimensions)
    ortho_scale = max_dimension * 1.45
    reference_minimum, reference_maximum, reference_dimensions, reference_center = scene_bounds(reference_meshes)
    reference_max_dimension = max(reference_dimensions)
    scene = bpy.context.scene
    # Headless CI must not depend on a transient EGL/OpenGL context. CPU Cycles
    # gives every fixed camera a real pixel buffer with fixed sampling settings.
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 4
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 2
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
    except Exception:
        pass
    ensure_world(scene)

    light_power = max(500.0, min(50000.0, max_dimension * max_dimension * 180.0))
    # More compact area lights create readable highlights on the roof finish
    # and mouldings instead of washing fine facade detail with broad soft light.
    light_size = max_dimension * 0.75
    # Blender's glTF importer converts the source Y-up model into Blender's
    # Z-up world before this point, so lights must use Blender-world Z as up.
    key_offset = Vector((1.0, -1.3, 1.7))
    fill_offset = Vector((-1.2, -0.25, 1.25))
    rim_offset = Vector((0.25, 1.1, 1.5))
    key_light = add_area_light("ReviewKeyLight", center + key_offset * max_dimension, center, light_power, light_size)
    fill_light = add_area_light("ReviewFillLight", center + fill_offset * max_dimension, center, light_power * 0.45, light_size * 1.2)
    rim_light = add_area_light("ReviewRimLight", center + rim_offset * max_dimension, center, light_power * 0.65, light_size)
    lights = [light_manifest(light) for light in (key_light, fill_light, rim_light)]
    render_settings = {
        "renderEngine": scene.render.engine,
        "cyclesDevice": scene.cycles.device,
        "cyclesSamples": scene.cycles.samples,
        "cyclesUseDenoising": scene.cycles.use_denoising,
        "cyclesMaxBounces": scene.cycles.max_bounces,
        "threadsMode": scene.render.threads_mode,
        "threads": scene.render.threads,
        "resolutionX": resolution,
        "resolutionY": resolution,
        "resolutionPercentage": scene.render.resolution_percentage,
        "imageFormat": scene.render.image_settings.file_format,
        "imageColorMode": scene.render.image_settings.color_mode,
        "imageColorDepth": scene.render.image_settings.color_depth,
        "imageCompression": scene.render.image_settings.compression,
        "filmTransparent": scene.render.film_transparent,
        "viewTransform": scene.view_settings.view_transform,
        "worldBackgroundRgba": [0.38, 0.40, 0.43, 1.0],
        "worldBackgroundStrength": 0.7,
        "cameraProjection": "ORTHO",
        "cameraCoordinateConvention": (
            "blender-z-up;source-glTF-y-up-imported;source+Z-south=>world-Y-negative;front-camera-from-world-Y-negative"
            if render_profile == "ahsan-manzil-y-up-cycles-cpu-v1"
            else "z-up;front-view-direction=+Y"
        ),
        "excludedRenderObjects": excluded_render_object_names,
        "cameraDistanceMultiplier": 3.0,
        "cameraOrthoScaleMultiplier": 1.45,
        "frontViewFraming": (
            "rangmahal-semantic-bounds-for-front-and-turntable-315;whole-palace-for-other-views"
            if render_profile == "ahsan-manzil-y-up-cycles-cpu-v1"
            else "whole-model-bounds"
        ),
        "frontCameraOrthoScaleMultiplier": (
            1.12 if render_profile == "ahsan-manzil-y-up-cycles-cpu-v1" else 1.45
        ),
        "referenceObliqueOrthoScaleMultiplier": 1.45,
        "turntableElevationDegrees": 22.0,
        "lights": lights,
    }

    elevation = math.radians(22.0)
    if render_profile == "ahsan-manzil-y-up-cycles-cpu-v1":
        # Source GLTF uses Y-up, +X east, +Z south. Blender's glTF importer
        # converts it into Blender world: source +Y -> world +Z (up), and
        # source +Z (south) -> world -Y. Therefore the river-front camera is
        # at Blender -Y looking +Y; the top camera is at +Z looking -Z.
        views = [
            ("front", Vector((0.0, -1.0, 0.0)), "ORTHO"),
            ("back", Vector((0.0, 1.0, 0.0)), "ORTHO"),
            ("left", Vector((-1.0, 0.0, 0.0)), "ORTHO"),
            ("right", Vector((1.0, 0.0, 0.0)), "ORTHO"),
            ("top", Vector((0.0, 0.0, 1.0)), "ORTHO"),
        ]
        for angle in range(0, 360, 45):
            azimuth = math.radians(angle)
            direction = Vector((math.cos(azimuth) * math.cos(elevation),
                                math.sin(azimuth) * math.cos(elevation),
                                math.sin(elevation)))
            views.append(("turntable-" + str(angle).zfill(3), direction, "ORTHO"))
    else:
        views = [
            ("front", Vector((0.0, -1.0, 0.0)), "ORTHO"),
            ("back", Vector((0.0, 1.0, 0.0)), "ORTHO"),
            ("left", Vector((-1.0, 0.0, 0.0)), "ORTHO"),
            ("right", Vector((1.0, 0.0, 0.0)), "ORTHO"),
            ("top", Vector((0.0, 0.0, 1.0)), "ORTHO"),
        ]
        for angle in range(0, 360, 45):
            azimuth = math.radians(angle)
            direction = Vector((math.cos(azimuth) * math.cos(elevation),
                                math.sin(azimuth) * math.cos(elevation),
                                math.sin(elevation)))
            views.append(("turntable-" + str(angle).zfill(3), direction, "ORTHO"))

    raw_views = []
    for view_id, direction, camera_type in views:
        direction.normalize()
        view_center = center
        view_max_dimension = max_dimension
        view_ortho_scale = ortho_scale
        if render_profile == "ahsan-manzil-y-up-cycles-cpu-v1" and view_id in ("front", "turntable-315"):
            view_center = reference_center
            view_max_dimension = reference_max_dimension
            if view_id == "front":
                view_ortho_scale = view_max_dimension * 1.12
            else:
                # Add margin for diagonal projection of facade depth.
                view_ortho_scale = view_max_dimension * 1.45
        view_camera_distance = view_max_dimension * 3.0
        camera_data = bpy.data.cameras.new("ReviewCamera_" + view_id)
        camera = bpy.data.objects.new("ReviewCamera_" + view_id, camera_data)
        scene.collection.objects.link(camera)
        camera_data.type = camera_type
        camera_data.ortho_scale = view_ortho_scale
        camera.location = view_center + direction * view_camera_distance
        camera.rotation_euler = (view_center - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = camera
        filename = view_id + ".png"
        scene.render.filepath = os.path.join(output_dir, filename)
        bpy.ops.render.render(write_still=True)
        # Blender's special "Render Result" datablock can be cleared after a
        # write_still render in background mode. Re-open the exact PNG written
        # to disk so statistics are collected from the durable output artifact.
        rendered_path = scene.render.filepath
        result = bpy.data.images.load(rendered_path, check_existing=False)
        try:
            stats = sample_pixel_statistics(result, resolution)
        finally:
            bpy.data.images.remove(result)
        view_direction = (view_center - camera.location).normalized()
        raw_views.append({
            "id": view_id,
            "filename": filename,
            "width": resolution,
            "height": resolution,
            "renderComplete": True,
            "cameraPose": {
                "projection": camera_data.type,
                "positionWorld": rounded_vector(camera.location),
                "targetWorld": rounded_vector(view_center),
                "viewDirectionWorld": rounded_vector(view_direction),
                "rotationEulerRadians": [round(float(value), 8) for value in camera.rotation_euler],
                "orthographicScale": round(float(camera_data.ortho_scale), 8),
            },
            "pixelStatistics": stats,
        })
        bpy.data.objects.remove(camera, do_unlink=True)
        bpy.data.cameras.remove(camera_data)
        print("Rendered " + view_id + " -> " + filename)

    raw_manifest = {
        "schemaVersion": "1.0.0",
        "renderer": "Blender",
        "rendererVersion": bpy.app.version_string,
        "renderProfile": render_profile,
        "renderSettings": render_settings,
        "width": resolution,
        "height": resolution,
        "sceneBounds": {
            "min": [round(float(value), 8) for value in minimum],
            "max": [round(float(value), 8) for value in maximum],
            "dimensions": [round(float(value), 8) for value in dimensions],
            "coordinateUnits": "imported-model-units-unverified",
        },
        "views": raw_views,
    }
    raw_path = os.path.join(output_dir, ".blender-render-manifest.raw.json")
    with open(raw_path, "x", encoding="utf-8") as stream:
        json.dump(raw_manifest, stream, indent=2)
        stream.write("\n")
    print("Wrote raw render manifest: " + raw_path)

if __name__ == "__main__":
    main()
