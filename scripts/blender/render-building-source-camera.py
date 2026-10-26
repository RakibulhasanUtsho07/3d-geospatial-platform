import bpy
import json
import math
import os
import sys
from mathutils import Matrix, Vector

def parse_args():
    if "--" not in sys.argv:
        raise RuntimeError("Missing source-camera arguments after --")
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) % 2:
        raise RuntimeError("Expected key/value argument pairs")
    values = dict(zip(args[::2], args[1::2]))
    for required in ("--model", "--plan", "--output-dir"):
        if required not in values:
            raise RuntimeError("Missing " + required)
    return values

def sha256_file(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

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

def model_bounds(meshes):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            points.append(evaluated.matrix_world @ Vector(corner))
    if not points:
        raise RuntimeError("The imported GLB has no renderable building geometry")
    minimum = Vector([min(point[i] for point in points) for i in range(3)])
    maximum = Vector([max(point[i] for point in points) for i in range(3)])
    dimensions = maximum - minimum
    if max(dimensions) <= 1e-9:
        raise RuntimeError("Imported model has zero geometric extent")
    return minimum, maximum, dimensions, (minimum + maximum) * 0.5

def configure_world(scene):
    if scene.world is None:
        scene.world = bpy.data.worlds.new("SourceCameraReviewWorld")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    if background:
        background.inputs["Color"].default_value = (0.13, 0.15, 0.18, 1.0)
        background.inputs["Strength"].default_value = 0.65

def main():
    args = parse_args()
    model_path = os.path.abspath(args["--model"])
    plan_path = os.path.abspath(args["--plan"])
    output_dir = os.path.abspath(args["--output-dir"])
    for path in (model_path, plan_path):
        if not os.path.isfile(path):
            raise RuntimeError("Required input does not exist: " + path)
    if not os.path.isdir(output_dir):
        raise RuntimeError("Output directory must exist and be newly created by the wrapper")
    with open(plan_path, "r", encoding="utf-8") as stream:
        plan = json.load(stream)
    if plan.get("mode") != "calibrated-source-camera" or plan.get("publicationEligible") is not False:
        raise RuntimeError("Invalid or publication-enabled source-camera render plan")
    if sha256_file(model_path) != plan.get("modelSha256"):
        raise RuntimeError("Model hash changed after camera plan validation")
    source_path = os.path.abspath(plan.get("sourceImagePath", ""))
    if not os.path.isfile(source_path) or sha256_file(source_path) != plan.get("sourceImageSha256"):
        raise RuntimeError("Source image is missing or its hash changed after camera plan validation")

    width = int(plan["sourceImageSize"]["width"])
    height = int(plan["sourceImageSize"]["height"])
    camera_plan = plan["blenderCamera"]
    if camera_plan["imageWidth"] != width or camera_plan["imageHeight"] != height:
        raise RuntimeError("Camera plan dimensions are inconsistent")
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=model_path)
    all_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    context_meshes = [obj for obj in all_meshes if obj.name.split(".")[0].startswith("Site_")]
    for obj in context_meshes:
        obj.hide_render = True
    meshes = [obj for obj in all_meshes if obj not in context_meshes]
    if not meshes:
        raise RuntimeError("No building meshes remain after excluding Site_ context nodes")
    minimum, maximum, dimensions, center = model_bounds(meshes)
    extent = max(dimensions)
    if extent <= 1e-9:
        raise RuntimeError("Model bounds have zero extent")

    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = camera_plan["pixelAspectX"]
    scene.render.pixel_aspect_y = camera_plan["pixelAspectY"]
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 12
    scene.render.use_file_extension = True
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    configure_world(scene)

    camera_data = bpy.data.cameras.new("CalibratedSourceCamera")
    camera_data.type = "PERSP"
    camera_data.lens = float(camera_plan["lensMm"])
    camera_data.sensor_width = float(camera_plan["sensorWidthMm"])
    camera_data.sensor_fit = camera_plan["sensorFit"]
    camera_data.shift_x = float(camera_plan["shiftX"])
    camera_data.shift_y = float(camera_plan["shiftY"])
    camera_data.clip_start = max(extent * 1e-6, 1e-4)
    camera_location = Vector(camera_plan["location"])
    bounds_corners = [
        Vector((x, y, z))
        for x in (minimum.x, maximum.x)
        for y in (minimum.y, maximum.y)
        for z in (minimum.z, maximum.z)
    ]
    farthest_model_corner = max((corner - camera_location).length for corner in bounds_corners)
    camera_data.clip_end = max(extent * 100.0, farthest_model_corner * 1.1 + extent, 100.0)
    camera_obj = bpy.data.objects.new("CalibratedSourceCamera", camera_data)
    scene.collection.objects.link(camera_obj)
    camera_obj.location = Vector(camera_plan["location"])
    camera_obj.rotation_mode = "QUATERNION"
    camera_obj.rotation_quaternion = Matrix(camera_plan["rotationMatrix"]).to_quaternion()
    scene.camera = camera_obj

    scale = max(1.0, min(extent, 100000.0))
    light_power = max(1000.0, min(200000.0, scale * scale * 20.0))
    offset = scale * 1.5
    light_size = max(scale * 0.5, 0.1)
    add_area_light("SourceCameraKeyLight", center + Vector((1.2, -1.6, 2.2)) * offset, center, light_power, light_size)
    add_area_light("SourceCameraFillLight", center + Vector((-1.8, -0.3, 0.9)) * offset, center, light_power * 0.35, light_size)
    add_area_light("SourceCameraRimLight", center + Vector((0.3, 1.8, 1.4)) * offset, center, light_power * 0.3, light_size)

    candidate_path = os.path.join(output_dir, "candidate.png")
    scene.render.film_transparent = True
    scene.use_nodes = False
    scene.render.use_compositing = False
    scene.render.filepath = candidate_path
    bpy.ops.render.render(write_still=True)
    if not os.path.isfile(candidate_path) or os.path.getsize(candidate_path) <= 0:
        raise RuntimeError("Candidate render was not written")

    reference = bpy.data.images.load(source_path, check_existing=False)
    if int(reference.size[0]) != width or int(reference.size[1]) != height:
        raise RuntimeError("Reference image dimensions changed; refusing to create a misleading overlay")
    scene.use_nodes = True
    scene.render.use_compositing = True
    scene.render.film_transparent = True
    nodes = scene.node_tree.nodes
    nodes.clear()
    render_node = nodes.new("CompositorNodeRLayers")
    image_node = nodes.new("CompositorNodeImage")
    image_node.image = reference
    alpha_over = nodes.new("CompositorNodeAlphaOver")
    alpha_over.inputs[0].default_value = 0.5
    # Reference photo is the background; calibrated candidate geometry is the translucent foreground.
    scene.node_tree.links.new(image_node.outputs["Image"], alpha_over.inputs[1])
    scene.node_tree.links.new(render_node.outputs["Image"], alpha_over.inputs[2])
    output_node = nodes.new("CompositorNodeComposite")
    scene.node_tree.links.new(alpha_over.outputs["Image"], output_node.inputs["Image"])
    overlay_path = os.path.join(output_dir, "overlay.png")
    scene.render.image_settings.color_mode = "RGB"
    scene.render.filepath = overlay_path
    bpy.ops.render.render(write_still=True)
    if not os.path.isfile(overlay_path) or os.path.getsize(overlay_path) <= 0:
        raise RuntimeError("Reference overlay was not written")
    print(json.dumps({
        "candidate": candidate_path,
        "overlay": overlay_path,
        "width": width,
        "height": height,
        "cameraId": plan["cameraId"],
        "cameraEvidenceId": plan["cameraEvidenceId"],
        "publicationEligible": False,
    }, sort_keys=True))

if __name__ == "__main__":
    main()
