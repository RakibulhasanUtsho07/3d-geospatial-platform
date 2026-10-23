#!/usr/bin/env python3
"""Regression checks for the independent GLB dimension analyzer."""
from __future__ import annotations

import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "validation" / "analyze-real-glb.py"
SPEC = importlib.util.spec_from_file_location("analyze_real_glb", MODULE_PATH)
assert SPEC and SPEC.loader
ANALYZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ANALYZER)


def build_box_glb(length: float = 10.0, depth: float = 2.0, height: float = 4.0) -> bytes:
    """Build a tiny, valid glTF 2.0 box with X=length, Z=depth, Y=height."""
    vertices = [
        (0, 0, 0), (length, 0, 0), (length, height, 0), (0, height, 0),
        (0, 0, depth), (length, 0, depth), (length, height, depth), (0, height, depth),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4), (3, 7, 6), (3, 6, 2),
        (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5),
    ]
    indices = [index for face in faces for index in face]
    position_bytes = b"".join(struct.pack("<3f", *vertex) for vertex in vertices)
    index_bytes = struct.pack("<" + "H" * len(indices), *indices)
    binary = position_bytes + index_bytes
    gltf = {
        "asset": {"version": "2.0", "generator": "real-glb-analyzer-test",
                  "extras": {"scaleCalibrated": False, "metresPerModelUnit": 1,
                             "sourceUpAxis": "Y"}},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1,
                                     "mode": 4, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.7, 0.6, 0.5, 1]}}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(position_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": len(position_bytes), "byteLength": len(index_bytes), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(vertices), "type": "VEC3",
             "min": [0, 0, 0], "max": [length, height, depth]},
            {"bufferView": 1, "componentType": 5123, "count": len(indices), "type": "SCALAR",
             "min": [0], "max": [max(indices)]},
        ],
    }
    json_chunk = json.dumps(gltf, separators=(",", ":")).encode()
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    chunks = struct.pack("<II", len(json_chunk), ANALYZER.JSON_CHUNK) + json_chunk
    chunks += struct.pack("<II", len(binary), ANALYZER.BIN_CHUNK) + binary
    total = 12 + len(chunks)
    return struct.pack("<III", ANALYZER.GLB_MAGIC, 2, total) + chunks


class ScaleCalibrationTests(unittest.TestCase):
    def test_calibration_scales_vertices_and_sets_output_units_to_metres(self):
        raw = build_box_glb()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.glb"
            source.write_bytes(raw)
            _, gltf, binary = ANALYZER.read_glb(source)
            points, *_ = ANALYZER.extract_geometry(gltf, binary)
            before = ANALYZER.calculate_metrics(points)
            self.assertAlmostEqual(before["longAxisModelUnits"], 10.0, places=5)

            calibrated, factor = ANALYZER.calibrate_glb_to_length(
                raw, gltf, binary, 100.0, before["longAxisModelUnits"]
            )
            self.assertAlmostEqual(factor, 10.0, places=6)
            output = Path(directory) / "calibrated.glb"
            output.write_bytes(calibrated)
            _, calibrated_gltf, calibrated_bin = ANALYZER.read_glb(output)
            calibrated_points, *_ = ANALYZER.extract_geometry(calibrated_gltf, calibrated_bin)
            measured = ANALYZER.calculate_metrics(calibrated_points)
            extras = calibrated_gltf["asset"]["extras"]

            self.assertTrue(extras["scaleCalibrated"])
            self.assertEqual(extras["metresPerModelUnit"], 1.0)
            self.assertAlmostEqual(measured["longAxisModelUnits"], 100.0, places=3)
            self.assertAlmostEqual(measured["shortAxisModelUnits"], 20.0, places=3)
            self.assertAlmostEqual(measured["verticalAxisModelUnits"], 40.0, places=3)
            self.assertFalse(extras["scaleCalibration"]["lengthAgreementIsIndependent"])
            self.assertEqual(extras["scaleCalibration"]["coordinatesAfterCalibration"], "metres")



if __name__ == "__main__":
    unittest.main(verbosity=2)
