from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_brf14_multiview_review.py"
SPEC = importlib.util.spec_from_file_location("brf20_review_packet", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class Brf14MultiviewReviewPacketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "images"
        self.assets.mkdir()
        self.output = self.root / "output"
        self.manifest, self.verification = self.make_fixture()

    def tearDown(self):
        self.temp.cleanup()

    def make_fixture(self):
        views = []
        results = []
        total = 0
        for index in range(3):
            view_id = "view-" + str(index + 1)
            filename = "view-" + str(index + 1) + ".jpg"
            image_path = self.assets / filename
            Image.new("RGB", (64, 48), (20 + index * 40, 60, 120)).save(
                image_path, format="JPEG", quality=90
            )
            payload = image_path.read_bytes()
            digest = hashlib.sha256(payload).hexdigest()
            size = len(payload)
            total += size
            pose = {
                "imageId": index + 10,
                "cameraCenterLocalM": [float(index), 2.0, 3.0],
                "centerAzimuthDegrees": float(index * 120),
                "centerElevationDegrees": -10.0 + index,
                "lookAngleToCaptureCenterDegrees": 12.0,
            }
            view = {
                "id": view_id,
                "filename": filename,
                "localPath": filename,
                "sourceUrl": "https://example.test/" + filename,
                "expectedByteSize": size,
                "expectedSha256": digest,
                "mediaType": "image/jpeg",
                "declaredWidth": 64,
                "declaredHeight": 48,
                "capturedAt": "2026-08-22T19:10:00",
                "gps": {"latitude": 45.0, "longitude": -93.0, "altitudeM": 250.0,
                        "verticalDatum": "not declared"},
                "colmapPose": pose,
            }
            views.append(view)
            results.append({
                "id": view_id,
                "filename": filename,
                "status": "passed",
                "expectedByteSize": size,
                "actualByteSize": size,
                "expectedSha256": digest,
                "actualSha256": digest,
            })
        manifest = {
            "schemaVersion": "1.0.0",
            "sampleId": "test-multiview",
            "evaluationStage": "multiview-source-byte-intake-only",
            "dataset": {
                "title": "Synthetic test fixture",
                "datasetUrl": "https://example.test/dataset",
                "sourceRepository": "https://example.test/repository",
                "sourceRepositoryCommit": "f" * 40,
                "license": "CC-BY-4.0",
                "licenseScope": "test fixture only",
                "attribution": "test fixture",
                "rightsStatus": "test-only",
            },
            "building": {"buildingId": "test-building"},
            "coordinateFrameMetadata": {
                "gps": {"frame": "unverified", "verticalDatum": "not declared"},
                "colmap": {"frameId": "test-local-frame", "units": "metres nominal",
                           "epsg": None, "axisConvention": "unverified",
                           "registrationToGps": "not established by this intake"},
            },
            "selectionMethod": {"name": "fixture", "expectedViewCount": 3},
            "maximumImageBytes": 100 * 1024 * 1024,
            "maximumTotalBytes": 500 * 1024 * 1024,
            "expectedTotalBytes": total,
            "views": views,
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        }
        verification = {
            "schemaVersion": "1.0.0",
            "sampleId": "test-multiview",
            "status": "views-byte-verified",
            "checkedAt": "2026-10-27T00:00:00Z",
            "selectedViewCount": 3,
            "actualTotalBytes": total,
            "views": results,
            "blockers": [],
        }
        return manifest, verification

    def run_packet(self):
        return MODULE.prepare_review_packet(
            self.manifest, self.assets, self.verification, self.output,
            generated_at_utc="2026-10-27T00:00:00Z",
        )

    def test_generates_contact_sheet_pose_plot_and_pending_review_report(self):
        report = self.run_packet()
        self.assertEqual(report["status"], "review-packet-generated-pending-human-review")
        self.assertEqual(len(report["sourceViews"]), 3)
        self.assertTrue((self.output / "multiview-contact-sheet.png").is_file())
        self.assertTrue((self.output / "camera-angle-coverage.png").is_file())
        self.assertTrue((self.output / "multiview-review-manifest.json").is_file())
        self.assertFalse(report["rawImageBytesIncluded"])
        self.assertEqual(report["humanReview"]["status"], "pending-human-review")
        self.assertFalse(report["humanReview"]["sameBuildingIdentityVerified"])
        self.assertFalse(report["humanReview"]["overlapReviewed"])
        self.assertFalse(report["humanReview"]["sourceUpAxisReviewed"])
        for flag in ("acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"):
            self.assertFalse(report[flag])
        self.assertEqual(report["sourceViews"][0]["actualSha256"],
                         self.manifest["views"][0]["expectedSha256"])
        reloaded = json.loads((self.output / "multiview-review-manifest.json").read_text())
        self.assertEqual(reloaded["status"], report["status"])

    def test_rejects_changed_bytes_after_verifier_pass(self):
        path = self.assets / self.manifest["views"][0]["filename"]
        path.write_bytes(path.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "Byte size changed|SHA-256 changed"):
            self.run_packet()
        self.assertFalse(self.output.exists())

    def test_rejects_wrong_hash_in_verification_report(self):
        self.verification["views"][0]["actualSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "byte-verification record"):
            self.run_packet()

    def test_rejects_dimension_mismatch(self):
        self.manifest["views"][0]["declaredWidth"] = 65
        with self.assertRaisesRegex(ValueError, "dimensions"):
            self.run_packet()

    def test_rejects_missing_view(self):
        (self.assets / self.manifest["views"][2]["filename"]).unlink()
        with self.assertRaisesRegex(ValueError, "missing or not a regular file"):
            self.run_packet()

    def test_rejects_incomplete_verification_report(self):
        self.verification["views"].pop()
        with self.assertRaisesRegex(ValueError, "exactly one result"):
            self.run_packet()

    def test_rejects_path_traversal_and_false_release_flags(self):
        self.manifest["views"][0]["filename"] = "../outside.jpg"
        with self.assertRaisesRegex(ValueError, "unsafe or duplicate filename"):
            self.run_packet()
        self.manifest, self.verification = self.make_fixture()
        self.manifest["mapReady"] = True
        with self.assertRaisesRegex(ValueError, "all acceptance/publication flags false"):
            self.run_packet()

    def test_rejects_png_payload_under_jpeg_declaration(self):
        path = self.assets / self.manifest["views"][0]["filename"]
        Image.new("RGB", (64, 48), (1, 2, 3)).save(path, format="PNG")
        payload = path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        size = len(payload)
        view = self.manifest["views"][0]
        view["expectedByteSize"] = size
        view["expectedSha256"] = digest
        self.manifest["expectedTotalBytes"] += size - self.verification["views"][0]["expectedByteSize"]
        result = self.verification["views"][0]
        result["expectedByteSize"] = size
        result["actualByteSize"] = size
        result["expectedSha256"] = digest
        result["actualSha256"] = digest
        with self.assertRaisesRegex(ValueError, "JPEG SOI signature"):
            self.run_packet()

    def test_rejects_unverified_source_status(self):
        self.verification["status"] = "blocked"
        with self.assertRaisesRegex(ValueError, "must pass"):
            self.run_packet()


if __name__ == "__main__":
    unittest.main()
