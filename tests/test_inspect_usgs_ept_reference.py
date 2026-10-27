import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "inspect-usgs-ept-reference.py"
MANIFEST = ROOT / "benchmarks" / "building-reconstruction" / "brf-16-central-mississippi-ept-reference.json"
SPEC = importlib.util.spec_from_file_location("inspect_usgs_ept_reference", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def ept_metadata():
    return {
        "bounds": [-1000, -1000, 0, 1000, 1000, 100],
        "boundsConforming": [-1000, -1000, 0, 1000, 1000, 100],
        "points": 1000,
        "span": 128,
        "dataType": "laszip",
        "srs": {"authority": "EPSG", "horizontal": "3857", "vertical": "5703"},
        "schema": [
            {"name": "X", "type": "signed", "size": 4},
            {"name": "Y", "type": "signed", "size": 4},
            {"name": "Z", "type": "signed", "size": 4},
            {"name": "Classification", "type": "unsigned", "size": 1},
        ],
    }


class InspectUsgsEptReferenceTests(unittest.TestCase):
    def test_manifest_pins_public_work_unit_ept_and_keeps_release_flags_false(self):
        with MANIFEST.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        validated = MODULE.read_manifest(MANIFEST)
        self.assertEqual(
            validated["dataset"]["url"],
            "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/MN_CentralMissRiver_4_B22/ept.json",
        )
        self.assertEqual(manifest["expectedMetadataSha256"], "ac14abdc2600e8af08f59569eb1b873ebda03e46fe59b8ee188a197ce1cd4d3f")
        self.assertFalse(manifest["acceptanceEligible"])
        self.assertFalse(manifest["publicationEligible"])
        self.assertFalse(manifest["mapReady"])
        self.assertFalse(manifest["automaticApproval"])

    def test_rejects_redirect_or_path_outside_pinned_public_s3_prefix(self):
        with self.assertRaisesRegex(ValueError, "allowlisted public USGS EPT"):
            MODULE.validate_public_ept_url("https://example.com/MN_CentralMissRiver_4_B22/ept.json")
        with self.assertRaisesRegex(ValueError, "allowlisted public USGS EPT"):
            MODULE.validate_public_ept_url(
                "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/MN_CentralMissRiver_1_B22/ept.json"
            )
        with self.assertRaisesRegex(ValueError, "allowlisted public USGS EPT"):
            MODULE.validate_public_ept_url(
                "https://usgs-lidar-public.s3.us-west-2.amazonaws.com/MN_CentralMissRiver_1_B22/ept.json"
            )

    def test_allows_same_project_virtual_host_redirect(self):
        url = "https://usgs-lidar-public.s3.us-west-2.amazonaws.com/MN_CentralMissRiver_4_B22/ept.json"
        self.assertEqual(MODULE.validate_public_ept_url(url), url)

    def test_parses_ept_metadata_and_requires_epsg_3857(self):
        parsed = MODULE.parse_ept_metadata(json.dumps(ept_metadata()).encode("utf-8"))
        self.assertEqual(parsed["points"], 1000)
        self.assertEqual(parsed["span"], 128)
        self.assertEqual(parsed["dataType"], "laszip")
        self.assertEqual(parsed["horizontalCrs"], "EPSG:3857")
        self.assertIn("classification", parsed["dimensions"])

        bad = ept_metadata()
        bad["srs"]["horizontal"] = "4326"
        with self.assertRaisesRegex(ValueError, "does not match the expected EPSG:3857"):
            MODULE.parse_ept_metadata(json.dumps(bad).encode("utf-8"))

    def test_rejects_malformed_ept_metadata(self):
        invalid = ept_metadata()
        invalid["bounds"] = [0, 0, 0, 10, 10]
        invalid["boundsConforming"] = [0, 0, 0, 10, 10]
        with self.assertRaisesRegex(ValueError, "six-dimensional tree bounds"):
            MODULE.parse_ept_metadata(json.dumps(invalid).encode("utf-8"))

        invalid = ept_metadata()
        invalid["schema"] = [{"name": "Classification", "type": "unsigned", "size": 1}]
        with self.assertRaisesRegex(ValueError, "missing coordinate dimensions"):
            MODULE.parse_ept_metadata(json.dumps(invalid).encode("utf-8"))

    def test_tree_bounds_are_kept_distinct_from_tighter_conforming_bounds(self):
        meta = ept_metadata()
        meta["bounds"] = [-1024, -512, 0, 1024, 512, 128]
        meta["boundsConforming"] = [-900, -400, 5, 900, 400, 100]
        parsed = MODULE.parse_ept_metadata(json.dumps(meta).encode("utf-8"))
        self.assertEqual(parsed["bounds"], [-1024.0, -512.0, 0.0, 1024.0, 512.0, 128.0])
        self.assertEqual(parsed["boundsConforming"], [-900.0, -400.0, 5.0, 900.0, 400.0, 100.0])
        node = MODULE.node_bounds("1-1-0-1", parsed["bounds"])
        self.assertEqual(node, [0.0, -512.0, 64.0, 1024.0, 0.0, 128.0])

    def test_node_bounds_and_xy_intersection_are_deterministic(self):
        root = [0.0, 0.0, 0.0, 1024.0, 512.0, 128.0]
        bounds = MODULE.node_bounds("1-1-0-1", root)
        self.assertEqual(bounds, [512.0, 0.0, 64.0, 1024.0, 256.0, 128.0])
        self.assertTrue(MODULE.overlaps_xy(bounds, [600.0, 100.0, 700.0, 200.0]))
        self.assertFalse(MODULE.overlaps_xy(bounds, [0.0, 300.0, 100.0, 400.0]))
        with self.assertRaisesRegex(ValueError, "Invalid EPT node key"):
            MODULE.node_bounds("../../secret", root)
        with self.assertRaisesRegex(ValueError, "outside its tree depth"):
            MODULE.node_bounds("1-2-0-0", root)

    def test_building_coverage_requires_class6_returns(self):
        blockers, warnings = MODULE.assess_sample_building_coverage(
            points_within_radius=3371,
            classification_counts={1: 1283, 2: 2084, 7: 2, 18: 2},
            inspected_node_count=3,
            selected_node_count=3,
        )
        self.assertIn("no-class6-building-points-within-sample-radius", blockers)
        self.assertTrue(any("No class-6 building points" in warning for warning in warnings))

    def test_building_coverage_passes_only_when_class6_returns_are_present(self):
        blockers, warnings = MODULE.assess_sample_building_coverage(
            points_within_radius=10,
            classification_counts={2: 7, 6: 3},
            inspected_node_count=3,
            selected_node_count=3,
        )
        self.assertEqual(blockers, [])
        self.assertEqual(warnings, [])

    def test_building_coverage_blocks_empty_or_partial_node_samples(self):
        blockers, _ = MODULE.assess_sample_building_coverage(
            points_within_radius=0,
            classification_counts={},
            inspected_node_count=2,
            selected_node_count=3,
        )
        self.assertIn("no-point-returns-fall-within-the-sample-radius", blockers)
        self.assertIn("no-class6-building-points-within-sample-radius", blockers)
        self.assertIn("one-or-more-selected-ept-nodes-were-not-completely-inspected", blockers)

    def test_manifest_rejects_accidentally_enabled_publication_flags(self):
        with MANIFEST.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        data["automaticApproval"] = True
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "manifest.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "automaticApproval must remain false"):
                MODULE.read_manifest(path)


if __name__ == "__main__":
    unittest.main()
