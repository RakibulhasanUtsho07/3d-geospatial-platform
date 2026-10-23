#!/usr/bin/env python3
"""Build an explicitly experimental surface preview from COLMAP sparse points.

This is a fallback for COLMAP builds without CUDA/MVS support. It is NOT a
substitute for dense multi-view stereo: sparse points may be incomplete or
outlier-contaminated, so the resulting mesh must remain review-only.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import open3d as o3d


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="COLMAP sparse point-cloud PLY")
    parser.add_argument("--output", required=True, help="Output Poisson preview mesh PLY")
    parser.add_argument("--summary", required=True, help="Write fallback metrics JSON")
    parser.add_argument("--depth", type=int, default=8)
    args = parser.parse_args()

    source = Path(args.input)
    destination = Path(args.output)
    summary_path = Path(args.summary)
    cloud = o3d.io.read_point_cloud(str(source))
    if not cloud.has_points():
        raise SystemExit("COLMAP sparse point-cloud PLY contains no points")
    original_count = len(cloud.points)
    if original_count < 32:
        raise SystemExit(f"Only {original_count} sparse points; refusing to synthesize a surface")

    points = np.asarray(cloud.points)
    finite_mask = np.isfinite(points).all(axis=1)
    cloud = cloud.select_by_index(np.flatnonzero(finite_mask).tolist())
    if len(cloud.points) < 32:
        raise SystemExit("Fewer than 32 finite sparse points remain")

    # Remove very isolated points only if enough points remain; keep original colour data.
    neighbor_count = min(20, len(cloud.points) - 1)
    filtered, inlier_indices = cloud.remove_statistical_outlier(
        nb_neighbors=neighbor_count, std_ratio=2.0
    )
    if len(filtered.points) >= 32:
        cloud = filtered
    kept_count = len(cloud.points)
    if kept_count < 32:
        raise SystemExit(f"Outlier filtering left only {kept_count} points")

    points = np.asarray(cloud.points)
    minimum = points.min(axis=0)
    maximum = points.max(axis=0)
    diagonal = float(np.linalg.norm(maximum - minimum))
    if not np.isfinite(diagonal) or diagonal <= 1e-5:
        raise SystemExit("Sparse point cloud has invalid/degenerate spatial bounds")

    # Estimate point normals from the sparse samples before Poisson reconstruction.
    radius = max(diagonal * 0.04, 1e-3)
    cloud.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=radius, max_nn=30)
    )
    cloud.orient_normals_consistent_tangent_plane(min(20, kept_count - 1))

    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        cloud, depth=max(6, min(10, args.depth)), scale=1.08, linear_fit=False
    )
    if len(mesh.vertices) < 10 or len(mesh.triangles) < 10:
        raise SystemExit("Poisson fallback did not produce a usable triangle surface")

    # Remove low-density vertices and crop the Poisson envelope to the measured points.
    density_values = np.asarray(densities)
    density_floor = float(np.quantile(density_values, 0.03))
    mesh.remove_vertices_by_mask((density_values < density_floor).tolist())
    margin = max(diagonal * 0.04, 0.1)
    bbox = o3d.geometry.AxisAlignedBoundingBox(minimum - margin, maximum + margin)
    mesh = mesh.crop(bbox)
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_non_manifold_edges()
    if len(mesh.vertices) < 10 or len(mesh.triangles) < 10:
        raise SystemExit("Cleaning/cropping left too little Poisson surface geometry")
    mesh.compute_vertex_normals()

    destination.parent.mkdir(parents=True, exist_ok=True)
    if not o3d.io.write_triangle_mesh(str(destination), mesh, write_ascii=True):
        raise SystemExit("Open3D could not write the fallback mesh PLY")

    vertices = np.asarray(mesh.vertices)
    extents = vertices.max(axis=0) - vertices.min(axis=0)
    summary = {
        "schemaVersion": "1.0.0",
        "strategy": "experimental-poisson-from-colmap-sparse-points",
        "status": "review-only",
        "inputPointCount": original_count,
        "retainedPointCount": kept_count,
        "meshVertexCount": int(len(mesh.vertices)),
        "meshTriangleCount": int(len(mesh.triangles)),
        "pointCloudBounds": {
            "min": minimum.tolist(),
            "max": maximum.tolist(),
            "diagonal": diagonal,
        },
        "meshBounds": {
            "min": vertices.min(axis=0).tolist(),
            "max": vertices.max(axis=0).tolist(),
            "extentXYZ": extents.tolist(),
        },
        "normalEstimationRadius": radius,
        "poissonDepth": args.depth,
        "limitations": [
            "This is an experimental fallback because the installed COLMAP package has no CUDA/HIP MVS backend.",
            "Sparse SfM points are not a dense surface; Poisson filling can invent surfaces across holes and occluded geometry.",
            "Do not interpret a plausible-looking mesh or calibrated long axis as proof of architectural accuracy.",
            "Independent dimensions, source-image comparisons and human review are mandatory.",
        ],
    }
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
