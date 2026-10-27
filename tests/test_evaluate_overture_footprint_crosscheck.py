import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "evaluate-overture-footprint-crosscheck.py"
SPEC = importlib.util.spec_from_file_location("evaluate_overture_footprint_crosscheck", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def fixture_inputs(root: Path, footprints=None, component_bounds=None, status="sample-neighbourhood-inspected"):
    manifest = {
        "schemaVersion": "1.0.0",
        "sampleId": "synthetic-brf-18-test",
        "evaluationStage": "independent-footprint-spatial-crosscheck-only",
        "source": {"name": "Overture Maps Buildings", "release": "2026-10-21.0",
                   "schemaVersion": "2.0.0", "featureType": "building",
                   "license": "ODbL-1.0", "attribution": "test attribution"},
        "query": {"bboxWgs84": [-0.01, -0.01, 0.01, 0.01], "maximumFeatures": 5000}
    }
    if component_bounds is None:
        component_bounds = [-10, -10, 10, 10]
    ept_report = {
        "status": status,
        "source": {"horizontalCrs": "EPSG:3857", "metadataSha256": "a" * 64},
        "cameraClusterSpatialProximity": {
            "sourceManifest": {"manifestSha256": "b" * 64},
            "views": [{"viewId": "view-01", "filename": "sample.jpg", "projectedX": 0, "projectedY": 0}],
            "components": [{
                "componentId": "component-01",
                "pointCount": 42,
                "occupiedGridCells": 12,
                "centroidXY": {"x": 0, "y": 0},
                "xyBounds": {"min": {"x": component_bounds[0], "y": component_bounds[1]},
                             "max": {"x": component_bounds[2], "y": component_bounds[3]}}
            }]
        }
    }
    if footprints is None:
        footprints = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": "building-overlap", "properties": {"subtype": "building", "sources": [{"dataset": "test"}]},
             "geometry": {"type": "Polygon", "coordinates": [[
                 [-0.00005, -0.00005], [0.00005, -0.00005], [0.00005, 0.00005],
                 [-0.00005, 0.00005], [-0.00005, -0.00005]
             ]]}},
            {"type": "Feature", "id": "building-nearby", "properties": {"subtype": "building"},
             "geometry": {"type": "Polygon", "coordinates": [[
                 [0.001, 0.001], [0.0011, 0.001], [0.0011, 0.0011],
                 [0.001, 0.0011], [0.001, 0.001]
             ]]}},
        ]}
    paths = {
        "manifest": root / "manifest.json",
        "ept": root / "ept.json",
        "footprints": root / "footprints.geojson",
    }
    paths["manifest"].write_text(json.dumps(manifest), encoding="utf-8")
    paths["ept"].write_text(json.dumps(ept_report), encoding="utf-8")
    paths["footprints"].write_text(json.dumps(footprints), encoding="utf-8")
    return paths


class OvertureFootprintCrosscheckTests(unittest.TestCase):
    def test_ranks_intersecting_footprint_and_keeps_release_gates_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = fixture_inputs(Path(temporary))
            report = MODULE.build_report(paths["manifest"], paths["ept"], paths["footprints"])
        self.assertEqual(report["status"], "complete-needs-visual-identity-review")
        self.assertEqual(report["counts"]["cameraViewsCompared"], 1)
        self.assertEqual(report["counts"]["elevatedComponentsCompared"], 1)
        self.assertEqual(report["counts"]["validPolygonFootprints"], 2)
        self.assertGreater(report["components"][0]["bestCandidateOverlapFraction"], 0)
        self.assertEqual(report["components"][0]["candidatesRankedByAabbOverlapThenCentroidDistance"][0]["featureId"],
                         "building-overlap")
        self.assertTrue(report["components"][0]["candidateFootprintIntersectsComponentAabb"])
        self.assertTrue(report["components"][0]["componentCentroidInsideAnyFootprint"])
        self.assertEqual(report["cameraViews"][0]["nearestFootprints"][0]["featureId"], "building-overlap")
        self.assertFalse(report["sameBuildingIdentityVerified"])
        self.assertFalse(report["candidateGlbGenerated"])
        self.assertFalse(report["independentReferenceVerified"])
        self.assertFalse(report["acceptanceEligible"])
        self.assertFalse(report["publicationEligible"])
        self.assertFalse(report["mapReady"])
        self.assertFalse(report["automaticApproval"])

    def test_report_pins_exact_input_bytes_with_sha256(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = fixture_inputs(Path(temporary))
            report = MODULE.build_report(paths["manifest"], paths["ept"], paths["footprints"])
            expected = hashlib.sha256(paths["footprints"].read_bytes()).hexdigest()
        self.assertEqual(report["sources"]["footprints"]["inputGeoJsonSha256"], expected)
        self.assertEqual(report["sources"]["footprints"]["release"], "2026-10-21.0")
        self.assertEqual(len(report["sources"]["footprints"]["manifestSha256"]), 64)

    def test_no_footprints_is_not_reported_as_a_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            empty = {"type": "FeatureCollection", "features": []}
            paths = fixture_inputs(Path(temporary), footprints=empty)
            report = MODULE.build_report(paths["manifest"], paths["ept"], paths["footprints"])
        self.assertEqual(report["status"], "no-footprints-found")
        self.assertEqual(report["counts"]["validPolygonFootprints"], 0)
        self.assertFalse(report["sameBuildingIdentityVerified"])

    def test_rejects_wrong_footprint_crs(self):
        with tempfile.TemporaryDirectory() as temporary:
            footprints = {"type": "FeatureCollection",
                          "crs": {"type": "name", "properties": {"name": "EPSG:32615"}},
                          "features": []}
            paths = fixture_inputs(Path(temporary), footprints=footprints)
            with self.assertRaisesRegex(ValueError, "non-WGS84"):
                MODULE.build_report(paths["manifest"], paths["ept"], paths["footprints"])

    def test_rejects_failed_ept_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = fixture_inputs(Path(temporary), status="blocked")
            with self.assertRaisesRegex(ValueError, "not a successful"):
                MODULE.build_report(paths["manifest"], paths["ept"], paths["footprints"])

    def test_rejects_zero_area_component_aabb(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = fixture_inputs(Path(temporary), component_bounds=[0, 0, 0, 10])
            with self.assertRaisesRegex(ValueError, "zero-area AABB"):
                MODULE.build_report(paths["manifest"], paths["ept"], paths["footprints"])

    def test_rejects_feature_count_above_bounded_manifest_cap(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = fixture_inputs(Path(temporary))
            manifest = json.loads(paths["manifest"].read_text(encoding="utf-8"))
            manifest["query"]["maximumFeatures"] = 1
            paths["manifest"].write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cap is 1"):
                MODULE.build_report(paths["manifest"], paths["ept"], paths["footprints"])


if __name__ == "__main__":
    unittest.main()
