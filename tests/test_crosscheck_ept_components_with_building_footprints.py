import importlib.util
import json
import math
import unittest
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Polygon
from shapely.ops import transform as transform_geometry

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "crosscheck-ept-components-with-building-footprints.py"
MANIFEST = ROOT / "benchmarks" / "building-reconstruction" / "brf-18-overture-building-footprint-crosscheck.json"
SPEC = importlib.util.spec_from_file_location("crosscheck_ept_footprints", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def manifest_data():
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def projected_xy(lon, lat, crs="EPSG:3857"):
    return Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform(lon, lat)


def ept_report():
    x, y = projected_xy(-93.391, 45.0518)
    return {
        "status": "sample-neighbourhood-inspected",
        "cameraClusterSpatialProximity": {
            "components": [{
                "componentId": "elevated-2m-component-01",
                "pointCount": 688,
                "occupiedGridCells": 465,
                "centroidXY": {"x": x, "y": y},
                "xyBounds": {
                    "min": {"x": x - 25, "y": y - 22},
                    "max": {"x": x + 25, "y": y + 22},
                },
                "cameraViewCountInsideAabb": 3,
                "cameraViewCountWithinThresholdM": 15,
            }]
        },
    }


def footprint_feature(fid, lon, lat, half_size=0.00004):
    return {
        "type": "Feature",
        "id": fid,
        "properties": {"height": 8.5, "num_floors": 2, "subtype": "commercial"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [lon - half_size, lat - half_size],
                [lon + half_size, lat - half_size],
                [lon + half_size, lat + half_size],
                [lon - half_size, lat + half_size],
                [lon - half_size, lat - half_size],
            ]],
        },
    }


def footprints(*features):
    return {"type": "FeatureCollection", "features": list(features)}


class CrosscheckEptFootprintsTests(unittest.TestCase):
    def test_ranks_spatial_candidates_and_keeps_all_release_flags_false(self):
        report = MODULE.build_report(
            manifest_data(),
            ept_report(),
            footprints(
                footprint_feature("near-building", -93.391, 45.0518),
                footprint_feature("far-building", -93.3895, 45.0518),
            ),
            "2026-10-21.0",
            {"eptReportSha256": "a" * 64},
        )
        self.assertEqual(report["status"], "cross-reference-complete-needs-visual-review")
        self.assertEqual(report["source"]["metricCrs"], "EPSG:26915")
        self.assertEqual(report["counts"]["sourceFootprintFeatures"], 2)
        self.assertGreaterEqual(report["components"][0]["candidateCountWithinDistance"], 1)
        self.assertEqual(report["components"][0]["candidates"][0]["featureId"], "near-building")
        self.assertTrue(report["components"][0]["candidates"][0]["intersectsComponentAabb"])
        self.assertFalse(report["identityReview"]["sameBuildingIdentityVerified"])
        self.assertFalse(report["identityReview"]["candidateGlbGenerated"])
        self.assertFalse(report["identityReview"]["independentReferenceVerified"])
        self.assertFalse(report["identityReview"]["heldOutCheckpointAccuracyVerified"])
        self.assertFalse(report["acceptanceEligible"])
        self.assertFalse(report["publicationEligible"])
        self.assertFalse(report["mapReady"])
        self.assertFalse(report["automaticApproval"])

    def test_empty_footprint_result_is_a_fail_closed_status(self):
        report = MODULE.build_report(manifest_data(), ept_report(), footprints(), "2026-10-21.0")
        self.assertEqual(report["status"], "no-footprints-returned")
        self.assertFalse(report["sameBuildingIdentityVerified"] if "sameBuildingIdentityVerified" in report else report["identityReview"]["sameBuildingIdentityVerified"])
        self.assertFalse(report["acceptanceEligible"])

    def test_invalid_and_unsupported_footprints_are_counted_not_repaired(self):
        invalid = {
            "type": "Feature",
            "id": "self-crossing",
            "properties": {},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [-93.391, 45.0518],
                    [-93.3909, 45.0519],
                    [-93.391, 45.0519],
                    [-93.3909, 45.0518],
                    [-93.391, 45.0518],
                ]],
            },
        }
        point = {
            "type": "Feature",
            "id": "not-building",
            "properties": {},
            "geometry": {"type": "Point", "coordinates": [-93.391, 45.0518]},
        }
        report = MODULE.build_report(manifest_data(), ept_report(), footprints(invalid, point), "2026-10-21.0")
        self.assertEqual(report["counts"]["skippedInvalidFootprints"], 1)
        self.assertEqual(report["counts"]["skippedUnsupportedGeometryFeatures"], 1)
        self.assertEqual(report["status"], "no-valid-footprints")

    def test_rejects_unpinned_release(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            MODULE.build_report(manifest_data(), ept_report(), footprints(), "2026-09-23.1")

    def test_rejects_invalid_manifest_crs_or_radius(self):
        manifest = manifest_data()
        manifest["query"]["metricCrs"] = "EPSG:3857"
        with self.assertRaisesRegex(ValueError, "EPSG:26915"):
            MODULE.validate_manifest(manifest)
        manifest = manifest_data()
        manifest["query"]["maxCandidateDistanceM"] = 1000
        with self.assertRaisesRegex(ValueError, "pinned at 50"):
            MODULE.validate_manifest(manifest)

    def test_rejects_nonfinite_component_coordinates(self):
        report = ept_report()
        report["cameraClusterSpatialProximity"]["components"][0]["xyBounds"]["min"]["x"] = math.inf
        with self.assertRaisesRegex(ValueError, "finite"):
            MODULE.build_report(manifest_data(), report, footprints(), "2026-10-21.0")

    def test_rejects_non_geojson_and_missing_ept_component_payload(self):
        with self.assertRaisesRegex(ValueError, "FeatureCollection"):
            MODULE.build_report(manifest_data(), ept_report(), {"type": "Feature"}, "2026-10-21.0")
        report = ept_report()
        del report["cameraClusterSpatialProximity"]
        with self.assertRaisesRegex(ValueError, "missing cameraClusterSpatialProximity"):
            MODULE.build_report(manifest_data(), report, footprints(), "2026-10-21.0")


if __name__ == "__main__":
    unittest.main()
