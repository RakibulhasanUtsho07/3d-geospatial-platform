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
    if not os.path.isfile(model_path):
        raise RuntimeError("Input model does not exist: " + model_path)
    if not os.path.isdir(output_dir):
        raise RuntimeError("Output directory must already exist: " + output_dir)
    if resolution < 256 or resolution > 2048 or (resolution & (resolution - 1)) != 0:
        raise RuntimeError("Resolution must be a power-of-two value between 256 and 2048")

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=model_path)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    minimum, maximum, dimensions, center = scene_bounds(meshes)
    max_dimension = max(dimensions)
    camera_distance = max_dimension * 3.0
    ortho_scale = max_dimension * 1.45
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
    except Exception:
        pass
    ensure_world(scene)

    light_power = max(500.0, min(50000.0, max_dimension * max_dimension * 180.0))
    light_size = max_dimension * 1.2
    key_light = add_area_light("ReviewKeyLight", center + Vector((1.4, -1.8, 2.2)) * max_dimension, center, light_power, light_size)
    fill_light = add_area_light("ReviewFillLight", center + Vector((-1.8, -0.3, 1.0)) * max_dimension, center, light_power * 0.45, light_size * 1.2)
    rim_light = add_area_light("ReviewRimLight", center + Vector((0.3, 1.7, 1.5)) * max_dimension, center, light_power * 0.65, light_size)
    lights = [light_manifest(light) for light in (key_light, fill_light, rim_light)]
    render_settings = {
        "renderEngine": scene.render.engine,
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
        "cameraDistanceMultiplier": 3.0,
        "cameraOrthoScaleMultiplier": 1.45,
        "turntableElevationDegrees": 22.0,
        "lights": lights,
    }

    views = [
        ("front", Vector((0.0, -1.0, 0.0)), "ORTHO"),
        ("back", Vector((0.0, 1.0, 0.0)), "ORTHO"),
        ("left", Vector((-1.0, 0.0, 0.0)), "ORTHO"),
        ("right", Vector((1.0, 0.0, 0.0)), "ORTHO"),
        ("top", Vector((0.0, 0.0, 1.0)), "ORTHO"),
    ]
    elevation = math.radians(22.0)
    for angle in range(0, 360, 45):
        azimuth = math.radians(angle)
        direction = Vector((math.cos(azimuth) * math.cos(elevation),
                            math.sin(azimuth) * math.cos(elevation),
                            math.sin(elevation)))
        views.append(("turntable-" + str(angle).zfill(3), direction, "ORTHO"))

    raw_views = []
    for view_id, direction, camera_type in views:
        direction.normalize()
        camera_data = bpy.data.cameras.new("ReviewCamera_" + view_id)
        camera = bpy.data.objects.new("ReviewCamera_" + view_id, camera_data)
        scene.collection.objects.link(camera)
        camera_data.type = camera_type
        camera_data.ortho_scale = ortho_scale
        camera.location = center + direction * camera_distance
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = camera
        filename = view_id + ".png"
        scene.render.filepath = os.path.join(output_dir, filename)
        bpy.ops.render.render(write_still=True)
        result = bpy.data.images.get("Render Result")
        if result is None:
            raise RuntimeError("Blender did not provide a render result for " + view_id)
        stats = sample_pixel_statistics(result, resolution)
        view_direction = (center - camera.location).normalized()
        raw_views.append({
            "id": view_id,
            "filename": filename,
            "width": resolution,
            "height": resolution,
            "renderComplete": True,
            "cameraPose": {
                "projection": camera_data.type,
                "positionWorld": rounded_vector(camera.location),
                "targetWorld": rounded_vector(center),
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
        "renderProfile": "building-review-fixed-cameras-v1",
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
