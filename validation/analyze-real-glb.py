#!/usr/bin/env python3
"""Measure and create orthographic review previews from a GLB 2.0 file.

The calibrated long axis is an operator-supplied scale baseline, so it is not
counted as independent accuracy evidence. Depth and vertical extent are the
independent dimensional comparisons in this experiment.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
COMPONENT_FORMATS = {
    5121: ("B", 1),
    5123: ("H", 2),
    5125: ("I", 4),
    5126: ("f", 4),
}


def read_glb(path: Path):
    raw = path.read_bytes()
    if len(raw) < 20:
        raise ValueError("GLB is too short")
    magic, version, declared = struct.unpack_from("<III", raw, 0)
    if magic != GLB_MAGIC or version != 2 or declared != len(raw):
        raise ValueError("invalid GLB 2.0 header or total length")
    offset, gltf, binary = 12, None, None
    while offset < len(raw):
        if offset + 8 > len(raw):
            raise ValueError("truncated GLB chunk header")
        length, chunk_type = struct.unpack_from("<II", raw, offset)
        offset += 8
        if offset + length > len(raw):
            raise ValueError("truncated GLB chunk")
        chunk = raw[offset:offset + length]
        offset += length
        if chunk_type == JSON_CHUNK:
            gltf = json.loads(chunk.rstrip(b" \0\t\r\n"))
        elif chunk_type == BIN_CHUNK:
            binary = chunk
    if gltf is None or gltf.get("asset", {}).get("version") != "2.0":
        raise ValueError("missing glTF 2.0 JSON chunk")
    return raw, gltf, binary


def read_accessor(gltf, binary, accessor_index):
    acc = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][acc["bufferView"]]
    fmt, size = COMPONENT_FORMATS[acc["componentType"]]
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    stride = view.get("byteStride", size * components)
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"]
    values = np.empty((count, components), dtype=np.float32 if acc["componentType"] == 5126 else np.uint32)
    for i in range(count):
        values[i] = struct.unpack_from("<" + fmt * components, binary, start + i * stride)
    return values


def extract_geometry(gltf, binary):
    positions, uv_values, triangles, texture_id, material_color = [], [], [], None, (190, 190, 190)
    vertex_offset = 0
    primitive_count = 0
    for mesh in gltf.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            attrs = primitive["attributes"]
            pos = read_accessor(gltf, binary, attrs["POSITION"])
            uv = read_accessor(gltf, binary, attrs["TEXCOORD_0"]) if "TEXCOORD_0" in attrs else None
            if "COLOR_0" in attrs:
                colors = read_accessor(gltf, binary, attrs["COLOR_0"])
            else:
                colors = None
            if uv is not None:
                uv_values.append(uv)
            else:
                uv_values.append(np.zeros((len(pos), 2), dtype=np.float32))
            positions.append(pos)
            if colors is not None:
                # Use per-face averaged vertex colors for non-textured procedural assets.
                pass
            if primitive.get("indices") is not None:
                ind = read_accessor(gltf, binary, primitive["indices"]).reshape(-1).astype(np.int64)
                if len(ind) % 3:
                    raise ValueError("triangle index count is not divisible by three")
                triangles.append(ind.reshape(-1, 3) + vertex_offset)
            else:
                triangles.append(np.arange(len(pos), dtype=np.int64).reshape(-1, 3) + vertex_offset)
            vertex_offset += len(pos)
            primitive_count += 1
            material_index = primitive.get("material")
            if material_index is not None:
                material = gltf.get("materials", [])[material_index]
                pbr = material.get("pbrMetallicRoughness", {})
                factor = pbr.get("baseColorFactor")
                if factor and len(factor) >= 3:
                    material_color = tuple(int(max(0, min(1, channel)) * 255) for channel in factor[:3])
                texture = pbr.get("baseColorTexture", {})
                if "index" in texture:
                    textures = gltf.get("textures", [])
                    texture_index = texture["index"]
                    if texture_index < len(textures):
                        texture_id = textures[texture_index].get("source")
    if not positions:
        raise ValueError("GLB contains no POSITION accessors")
    return (
        np.concatenate(positions),
        np.concatenate(uv_values),
        np.concatenate(triangles),
        texture_id,
        material_color,
        primitive_count,
    )


def embedded_texture(gltf, binary, texture_id):
    if texture_id is None:
        return None
    images = gltf.get("images", [])
    if texture_id >= len(images):
        return None
    image_def = images[texture_id]
    if "bufferView" not in image_def:
        return None
    view = gltf["bufferViews"][image_def["bufferView"]]
    start = view.get("byteOffset", 0)
    payload = binary[start:start + view["byteLength"]]
    try:
        from io import BytesIO
        return Image.open(BytesIO(payload)).convert("RGB")
    except Exception:
        return None


def calculate_metrics(points):
    mins = points.min(axis=0)
    maxs = points.max(axis=0)
    spans = maxs - mins
    horizontal = points[:, [0, 2]]
    centered = horizontal - horizontal.mean(axis=0)
    covariance = np.cov(centered, rowvar=False)
    eigvals, eigvecs = np.linalg.eigh(covariance)
    axes = eigvecs[:, np.argsort(eigvals)[::-1]]
    projected = centered @ axes
    horizontal_spans = np.ptp(projected, axis=0)
    return {
        "axisAlignedBoundsMOrUnits": {
            "min": [float(v) for v in mins],
            "max": [float(v) for v in maxs],
            "extentXYZ": [float(v) for v in spans],
        },
        "horizontalPrincipalExtentsMOrUnits": [float(v) for v in horizontal_spans],
        "longAxisModelUnits": float(horizontal_spans[0]),
        "shortAxisModelUnits": float(horizontal_spans[1]),
        "verticalAxisModelUnits": float(spans[1]),
        "vertexCount": int(len(points)),
    }


def texture_fill(texture, uv_triangle, fallback):
    if texture is None:
        return fallback
    uv = np.mean(uv_triangle, axis=0)
    x = max(0, min(texture.width - 1, int(float(uv[0]) * (texture.width - 1))))
    y = max(0, min(texture.height - 1, int((1.0 - float(uv[1])) * (texture.height - 1))))
    return tuple(int(c) for c in texture.getpixel((x, y)))


def render_orthographic(points, uvs, triangles, texture, fallback_color, output_path, view, width=960, height=720):
    if view == "front":
        axes, depth_index, reverse = (0, 1), 2, False  # look from +Z
    elif view == "side":
        axes, depth_index, reverse = (2, 1), 0, False  # look from +X
    else:
        axes, depth_index, reverse = (0, 2), 1, False  # look from +Y

    limit = 120_000
    step = max(1, math.ceil(len(triangles) / limit))
    sample_triangles = triangles[::step]
    projected_points = points[:, list(axes)]
    mins = projected_points.min(axis=0)
    maxs = projected_points.max(axis=0)
    ranges = np.maximum(maxs - mins, 1e-6)
    margin = 28
    scale = min((width - 2 * margin) / ranges[0], (height - 2 * margin) / ranges[1])
    center = (mins + maxs) / 2

    def to_pixel(pt):
        x = (float(pt[0]) - center[0]) * scale + width / 2
        y = height / 2 - (float(pt[1]) - center[1]) * scale
        return (int(round(x)), int(round(y)))

    image = Image.new("RGB", (width, height), (246, 247, 248))
    draw = ImageDraw.Draw(image)
    depth_means = [(float(np.mean(points[t, depth_index])), t) for t in sample_triangles]
    depth_means.sort(key=lambda item: item[0], reverse=reverse)
    for _, tri in depth_means:
        projected = [to_pixel(points[int(index), list(axes)]) for index in tri]
        uv_tri = uvs[tri]
        fill = texture_fill(texture, uv_tri, fallback_color)
        draw.polygon(projected, fill=fill, outline=(65, 65, 65))
    image.save(output_path)
    return {"view": view, "file": str(output_path), "trianglesDrawn": len(sample_triangles), "trianglesTotal": len(triangles)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", choices=["measure", "compare"], default="measure")
    parser.add_argument("--reference-length-m", type=float, default=125.4)
    parser.add_argument("--reference-depth-m", type=float, default=28.75)
    parser.add_argument("--reference-height-m", type=float, default=27.13)
    parser.add_argument("--depth-tolerance-percent", type=float, default=20.0)
    parser.add_argument("--height-tolerance-percent", type=float, default=20.0)
    parser.add_argument("--render-dir")
    args = parser.parse_args()

    glb_path = Path(args.glb)
    raw, gltf, binary = read_glb(glb_path)
    positions, uvs, triangles, texture_id, base_color, primitive_count = extract_geometry(gltf, binary)
    metrics = calculate_metrics(positions)
    report = {
        "schemaVersion": "1.0.0",
        "file": glb_path.name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "glbVersion": gltf.get("asset", {}).get("version"),
        "generator": gltf.get("asset", {}).get("generator"),
        "meshCount": len(gltf.get("meshes", [])),
        "primitiveCount": primitive_count,
        "triangleCount": int(len(triangles)),
        "embeddedTextureCount": len(gltf.get("images", [])),
        "scaleCalibrated": gltf.get("asset", {}).get("extras", {}).get("scaleCalibrated"),
        "metresPerModelUnit": gltf.get("asset", {}).get("extras", {}).get("metresPerModelUnit"),
        "sourceUpAxis": gltf.get("asset", {}).get("extras", {}).get("sourceUpAxis"),
        **metrics,
        "caveat": "Dimensions are model measurements. They are not proof of survey accuracy, georeferencing or architectural fidelity.",
    }

    if args.mode == "compare":
        long_axis = metrics["horizontalPrincipalExtentsMOrUnits"][0]
        short_axis = metrics["horizontalPrincipalExtentsMOrUnits"][1]
        vertical = metrics["verticalAxisModelUnits"]
        refs = {
            "lengthM": args.reference_length_m,
            "depthM": args.reference_depth_m,
            "heightM": args.reference_height_m,
        }
        def err(actual, expected):
            return abs(actual - expected) / expected * 100 if expected else None
        errors = {
            "lengthPercent": err(long_axis, refs["lengthM"]),
            "depthPercent": err(short_axis, refs["depthM"]),
            "heightPercent": err(vertical, refs["heightM"]),
        }
        length_gate = errors["lengthPercent"] <= 3.0
        depth_gate = errors["depthPercent"] <= args.depth_tolerance_percent
        height_gate = errors["heightPercent"] <= args.height_tolerance_percent
        report["dimensionComparison"] = {
            "reference": refs,
            "actual": {"lengthM": long_axis, "depthM": short_axis, "heightM": vertical},
            "absolutePercentError": errors,
            "tolerancesPercent": {"length": 3.0, "depth": args.depth_tolerance_percent, "height": args.height_tolerance_percent},
            "scaleBaseline": "The model was scaled using the published overall length of 125.4 m. Length agreement is therefore not independent evidence; depth and height are the independent checks.",
            "lengthGate": "pass" if length_gate else "fail",
            "depthGate": "pass" if depth_gate else "fail",
            "heightGate": "pass" if height_gate else "fail",
            "dimensionGate": "pass" if length_gate and depth_gate and height_gate else "fail-review-required",
            "limitations": [
                "The reference footprint uses a rectangular WGS84 bounding approximation around a provisional anchor, not a surveyed polygon.",
                "The reconstructed model does not become georeferenced from scale calibration alone.",
                "Human visual review against the input photographs is still required."
            ]
        }
    if args.render_dir:
        output_dir = Path(args.render_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        tex = embedded_texture(gltf, binary, texture_id)
        previews = []
        for view in ("front", "side", "top"):
            previews.append(render_orthographic(
                positions, uvs, triangles, tex, base_color,
                output_dir / f"{view}-orthographic.png", view,
            ))
        report["orthographicPreviews"] = previews

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if args.mode == "measure":
        if metrics["longAxisModelUnits"] <= 0:
            raise SystemExit("could not derive a positive model length for scale calibration")


if __name__ == "__main__":
    main()
