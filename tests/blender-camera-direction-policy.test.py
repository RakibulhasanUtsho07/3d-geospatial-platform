#!/usr/bin/env python3
"""Numeric regression tests for the Blender review camera's glTF Y-up basis.

This loads only the two pure direction-policy functions from the renderer AST,
so CI can validate real vector values without requiring Blender or mathutils.
"""
import ast
import math
from pathlib import Path
import unittest


RENDERER = Path(__file__).resolve().parents[1] / "scripts" / "blender" / "render-building-review.py"


def load_direction_policy():
    source = RENDERER.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(RENDERER))
    selected = []
    wanted_functions = {"camera_direction_from_bearing", "build_review_view_directions"}
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "DEFAULT_FRONT_BEARING_DEGREES"
            for target in node.targets
        ):
            selected.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            selected.append(node)
    found = {node.name for node in selected if isinstance(node, ast.FunctionDef)}
    if found != wanted_functions:
        raise AssertionError("Renderer is missing camera direction policy functions: " + repr(wanted_functions - found))
    module = ast.Module(body=selected, type_ignores=[])
    namespace = {"math": math}
    exec(compile(module, str(RENDERER), "exec"), namespace)
    return namespace


POLICY = load_direction_policy()


class BlenderCameraDirectionPolicyTests(unittest.TestCase):
    def assertVectorClose(self, actual, expected, places=7):
        self.assertEqual(len(actual), 3)
        for actual_value, expected_value in zip(actual, expected):
            self.assertAlmostEqual(actual_value, expected_value, places=places)

    def test_compass_bearings_use_x_east_y_up_z_north(self):
        cases = [
            (0.0, (0.0, 0.0, 1.0)),       # north
            (90.0, (1.0, 0.0, 0.0)),      # east
            (180.0, (0.0, 0.0, -1.0)),    # south
            (270.0, (-1.0, 0.0, 0.0)),    # west
        ]
        for bearing, expected in cases:
            with self.subTest(bearing=bearing):
                self.assertVectorClose(POLICY["camera_direction_from_bearing"](bearing, 0.0), expected)

    def test_elevation_moves_camera_along_positive_y_not_positive_z(self):
        direction = POLICY["camera_direction_from_bearing"](0.0, 30.0)
        self.assertVectorClose(direction, (0.0, 0.5, math.cos(math.radians(30.0))))
        self.assertGreater(direction[1], 0.0)

    def test_default_front_is_south_facing_but_remains_unverified(self):
        views = dict(POLICY["build_review_view_directions"](None))
        self.assertEqual(POLICY["DEFAULT_FRONT_BEARING_DEGREES"], 180.0)
        self.assertVectorClose(
            views["front"],
            (0.0, math.sin(math.radians(5.0)), -math.cos(math.radians(5.0))),
        )
        self.assertVectorClose(views["back"], (0.0, 0.0, 1.0))
        self.assertVectorClose(views["left"], (-1.0, 0.0, 0.0))
        self.assertVectorClose(views["right"], (1.0, 0.0, 0.0))
        self.assertVectorClose(views["top"], (0.0, 1.0, 0.0))

    def test_explicit_front_bearing_rotates_front_back_and_relative_sides(self):
        views = dict(POLICY["build_review_view_directions"](0.0))
        self.assertVectorClose(
            views["front"],
            (0.0, math.sin(math.radians(5.0)), math.cos(math.radians(5.0))),
        )
        self.assertVectorClose(views["back"], (0.0, 0.0, -1.0))
        self.assertVectorClose(views["left"], (1.0, 0.0, 0.0))
        self.assertVectorClose(views["right"], (-1.0, 0.0, 0.0))

    def test_eight_turntable_directions_are_compass_clockwise_and_unit_length(self):
        views = dict(POLICY["build_review_view_directions"](180.0))
        for angle in range(0, 360, 45):
            name = "turntable-" + str(angle).zfill(3)
            self.assertIn(name, views)
            self.assertAlmostEqual(sum(value * value for value in views[name]), 1.0, places=7)
        self.assertVectorClose(
            views["turntable-000"],
            (0.0, math.sin(math.radians(22.0)), math.cos(math.radians(22.0))),
        )
        self.assertVectorClose(
            views["turntable-090"],
            (math.cos(math.radians(22.0)), math.sin(math.radians(22.0)), 0.0),
        )
        self.assertEqual(len(views), 13)


if __name__ == "__main__":
    unittest.main(verbosity=2)
