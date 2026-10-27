import importlib.util
import io
import unittest
from pathlib import Path

from PIL import Image
from pyproj import Transformer

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "prepare_brf18_footprint_image_review.py"
SPEC = importlib.util.spec_from_file_location("brf19_review", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def png_bytes(width=800, height=1400):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (80, 100, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


def inputs():
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    lon, lat = -93.3910, 45.0518
    x, y = transformer.transform(lon, lat)
    footprint = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "id": "overture-building-1",
            "properties": {"id": "overture-building-1"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [lon - 0.00008, lat - 0.00006],
                    [lon + 0.00008, lat - 0.00006],
                    [lon + 0.00008, lat + 0.00006],
                    [lon - 0.00008, lat + 0.00006],
                    [lon - 0.00008, lat - 0.00006],
                ]],
            },
        }],
    }
    ept = {
        "status": "sample-neighbourhood-inspected",
        "cameraClusterSpatialProximity": {
            "components": [{
                "componentId": "cluster-1",
                "xyBounds": {
                    "min": {"x": x - 3, "y": y - 3},
                    "max": {"x": x + 3, "y": y + 3},
                },
            }],
        },
    }
    crosscheck = {
        "schemaVersion": "1.0.0",
        "sampleId": "brf-18-central-mississippi-footprint-crosscheck",
        "status": "cross-reference-complete-needs-visual-review",
        "components": [{
            "componentId": "cluster-1",
            "candidates": [{
                "sourceFeatureIndex": 0,
                "featureId": "overture-building-1",
                "distanceToComponentAabbM": 0.0,
                "intersectionAreaM2": 20.0,
                "intersectsComponentAabb": True,
            }],
        }],
        "identityReview": {
            "sameBuildingIdentityVerified": False,
            "candidateGlbGenerated": False,
            "independentReferenceVerified": False,
            "heldOutCheckpointAccuracyVerified": False,
        },
        "acceptanceEligible": False,
        "publicationEligible": False,
        "mapReady": False,
        "automaticApproval": False,
    }
    manifest = {
        "schemaVersion": "1.0.0",
        "sampleId": "brf-18-central-mississippi-footprint-crosscheck",
        "query": {"bboxWgs84": [-93.3918, 45.0508, -93.3902, 45.0528]},
    }
    return manifest, ept, crosscheck, footprint


class FootprintImageReviewTests(unittest.TestCase):
    def test_projected_bbox_and_image_url_are_bounded_and_metric(self):
        bbox = (-93.3918, 45.0508, -93.3902, 45.0528)
        extent = MODULE.projected_extent(bbox)
        self.assertLess(extent[0], extent[2])
        self.assertLess(extent[1], extent[3])
        url = MODULE.image_request_url(extent, 800, 1400)
        self.assertTrue(url.startswith(MODULE.IMAGE_SERVICE + "?"))
        self.assertIn("bboxSR=3857", url)
        self.assertIn("imageSR=3857", url)
        with self.assertRaises(ValueError):
            MODULE.image_request_url(extent, 5000, 5000)

    def test_pixel_mapping_uses_north_up_extent_and_header_offset(self):
        extent = (0.0, 0.0, 10.0, 10.0)
        self.assertEqual(MODULE.map_point_to_pixel(0.0, 10.0, extent, 100, 200), (0, MODULE.HEADER_PX))
        self.assertEqual(MODULE.map_point_to_pixel(10.0, 0.0, extent, 100, 200), (99, MODULE.HEADER_PX + 199))

    def test_creates_overlay_and_keeps_identity_and_release_flags_false(self):
        manifest, ept, crosscheck, footprints = inputs()
        overlay, report = MODULE.build_review_artifacts(
            manifest, ept, crosscheck, footprints, png_bytes(),
            imagery_url="https://imagery.nationalmap.gov/example",
            input_hashes={"manifestSha256": "a" * 64},
            retrieved_at_utc="2026-10-27T14:00:00Z",
        )
        with Image.open(io.BytesIO(overlay)) as image:
            self.assertEqual(image.size, (800, 1400 + MODULE.HEADER_PX + MODULE.FOOTER_PX))
            self.assertEqual(image.format, "PNG")
        self.assertEqual(report["status"], "visual-overlay-generated-needs-human-review")
        self.assertEqual(report["humanReview"]["status"], "pending-human-review")
        self.assertEqual(report["overlay"]["candidatePolygonCount"], 1)
        self.assertEqual(report["candidateReview"][0]["featureId"], "overture-building-1")
        self.assertFalse(report["identityReview"]["sameBuildingIdentityVerified"])
        self.assertFalse(report["identityReview"]["candidateGlbGenerated"])
        self.assertFalse(report["identityReview"]["independentReferenceVerified"])
        self.assertFalse(report["identityReview"]["heldOutCheckpointAccuracyVerified"])
        self.assertFalse(report["acceptanceEligible"])
        self.assertFalse(report["publicationEligible"])
        self.assertFalse(report["mapReady"])
        self.assertFalse(report["automaticApproval"])
        self.assertEqual(report["integrity"]["renderedOverlaySha256"], MODULE.sha256_bytes(overlay))

    def test_rejects_crosscheck_that_claims_identity_or_release_eligibility(self):
        manifest, ept, crosscheck, footprints = inputs()
        crosscheck["identityReview"]["sameBuildingIdentityVerified"] = True
        with self.assertRaisesRegex(ValueError, "identity"):
            MODULE.build_review_artifacts(
                manifest, ept, crosscheck, footprints, png_bytes(),
                imagery_url="https://imagery.nationalmap.gov/example",
                input_hashes={},
            )
        _, _, crosscheck, _ = inputs()
        crosscheck["mapReady"] = True
        with self.assertRaisesRegex(ValueError, "mapReady"):
            MODULE.build_review_artifacts(
                manifest, ept, crosscheck, footprints, png_bytes(),
                imagery_url="https://imagery.nationalmap.gov/example",
                input_hashes={},
            )

    def test_rejects_candidate_source_index_or_id_mismatch(self):
        manifest, ept, crosscheck, footprints = inputs()
        crosscheck["components"][0]["candidates"][0]["sourceFeatureIndex"] = 10
        with self.assertRaisesRegex(ValueError, "sourceFeatureIndex"):
            MODULE.build_review_artifacts(
                manifest, ept, crosscheck, footprints, png_bytes(),
                imagery_url="https://imagery.nationalmap.gov/example",
                input_hashes={},
            )
        _, _, crosscheck, footprints = inputs()
        crosscheck["components"][0]["candidates"][0]["featureId"] = "a-different-building"
        with self.assertRaisesRegex(ValueError, "does not match"):
            MODULE.build_review_artifacts(
                manifest, ept, crosscheck, footprints, png_bytes(),
                imagery_url="https://imagery.nationalmap.gov/example",
                input_hashes={},
            )

    def test_rejects_invalid_extent_and_non_png_imagery(self):
        with self.assertRaises(ValueError):
            MODULE.validate_bbox_wgs84([-93.0, 91.0, -92.0, 92.0])
        manifest, ept, crosscheck, footprints = inputs()
        with self.assertRaisesRegex(ValueError, "valid safe PNG"):
            MODULE.build_review_artifacts(
                manifest, ept, crosscheck, footprints, b"not an image",
                imagery_url="https://imagery.nationalmap.gov/example",
                input_hashes={},
            )

    def test_rejects_report_component_not_present_in_ept_input(self):
        manifest, ept, crosscheck, footprints = inputs()
        crosscheck["components"][0]["componentId"] = "unknown-cluster"
        with self.assertRaisesRegex(ValueError, "does not match"):
            MODULE.build_review_artifacts(
                manifest, ept, crosscheck, footprints, png_bytes(),
                imagery_url="https://imagery.nationalmap.gov/example",
                input_hashes={},
            )


if __name__ == "__main__":
    unittest.main()
