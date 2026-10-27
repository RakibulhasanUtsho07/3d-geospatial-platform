from __future__ import annotations

import hashlib
import importlib.util
import json
import random
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "analyze_brf14_multiview_overlap.py"
SPEC = importlib.util.spec_from_file_location("brf21_overlap_graph", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class Brf14PairwiseOverlapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "images"
        self.assets.mkdir()
        self.output = self.root / "out"
        self.manifest, self.verification = self.fixture()

    def tearDown(self):
        self.temp.cleanup()

    def make_texture(self, seed=10):
        image = Image.new("RGB", (420, 320), (235, 235, 230))
        draw = ImageDraw.Draw(image)
        rng = random.Random(seed)
        for index in range(110):
            x, y = rng.randrange(0, 390), rng.randrange(0, 290)
            w, h = rng.randrange(5, 27), rng.randrange(5, 24)
            color = tuple(rng.randrange(15, 235) for _ in range(3))
            if index % 3 == 0:
                draw.rectangle((x, y, x + w, y + h), outline=color, width=2)
            elif index % 3 == 1:
                draw.ellipse((x, y, x + w, y + h), outline=color, width=2)
            else:
                draw.line((x, y, x + w, y + h), fill=color, width=3)
        for x in range(15, 410, 41):
            draw.line((x, 0, x, 319), fill=(90, 90, 90), width=1)
        return image

    def fixture(self):
        base = self.make_texture()
        transform = np.array([[1.0, 0.025, 7.0], [-0.018, 1.0, 5.0], [0.00008, -0.00009, 1.0]])
        warped = cv2.warpPerspective(np.asarray(base), transform, (420, 320), flags=cv2.INTER_LINEAR)
        images = [
            ("view-a", "view-a.jpg", base),
            ("view-b", "view-b.jpg", Image.fromarray(warped)),
            ("view-blank", "view-blank.jpg", Image.new("RGB", (420, 320), (127, 127, 127))),
        ]
        views, results = [], []
        total = 0
        for index, (view_id, filename, image) in enumerate(images):
            path = self.assets / filename
            image.save(path, format="JPEG", quality=94)
            payload = path.read_bytes()
            digest, size = hashlib.sha256(payload).hexdigest(), len(payload)
            total += size
            views.append({
                "id": view_id,
                "filename": filename,
                "localPath": filename,
                "sourceUrl": "https://example.test/" + filename,
                "expectedByteSize": size,
                "expectedSha256": digest,
                "mediaType": "image/jpeg",
                "declaredWidth": 420,
                "declaredHeight": 320,
                "capturedAt": "2026-08-22T19:10:00",
                "gps": {"latitude": 45.0, "longitude": -93.0, "altitudeM": 250.0,
                        "verticalDatum": "not declared"},
                "colmapPose": {
                    "imageId": index + 1,
                    "cameraCenterLocalM": [float(index), 2.0, 3.0],
                    "centerAzimuthDegrees": float(index * 120),
                    "centerElevationDegrees": -10.0,
                    "lookAngleToCaptureCenterDegrees": 12.0,
                },
            })
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
            "dataset": {"title": "Synthetic fixture", "sourceRepositoryCommit": "f" * 40},
            "building": {"buildingId": "test-building"},
            "coordinateFrameMetadata": {"gps": {}, "colmap": {"epsg": None}},
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

    def run_analysis(self, output=None):
        return MODULE.analyze_overlap(
            self.manifest,
            self.assets,
            self.verification,
            output or self.output,
            analyzed_at_utc="2026-10-27T00:00:00Z",
        )

    def test_generates_all_unique_pairs_and_review_only_report(self):
        report = self.run_analysis()
        self.assertEqual(report["status"], "pairwise-analysis-complete-needs-human-review")
        self.assertEqual(report["counts"]["views"], 3)
        self.assertEqual(report["counts"]["possiblePairs"], 3)
        self.assertEqual(report["counts"]["evaluatedPairs"], 3)
        self.assertEqual(len({(p["viewA"], p["viewB"]) for p in report["pairs"]}), 3)
        self.assertEqual({p["viewA"] for p in report["pairs"]}, {"view-a", "view-b", "view-blank"})
        self.assertTrue((self.output / "pairwise-overlap-graph.png").is_file())
        self.assertTrue((self.output / "pairwise-overlap-report.json").is_file())
        self.assertFalse(report["rawImageBytesIncluded"])
        self.assertEqual(report["humanReview"]["status"], "pending-human-review")
        for flag in ("acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"):
            self.assertFalse(report[flag])
        for pair in report["pairs"]:
            self.assertEqual(len(pair["sha256A"]), 64)
            self.assertEqual(len(pair["sha256B"]), 64)

    def test_transformed_textured_images_produce_a_candidate_edge(self):
        report = self.run_analysis()
        pair = next(p for p in report["pairs"] if {p["viewA"], p["viewB"]} == {"view-a", "view-b"})
        self.assertGreaterEqual(pair["ratioFilteredMatchCount"], 12)
        self.assertGreaterEqual(pair["geometricInlierCount"], 10)
        self.assertTrue(pair["candidateOverlapEdge"])
        self.assertEqual(pair["status"], "candidate-match-requires-visual-review")

    def test_blank_view_is_not_automatically_a_candidate(self):
        report = self.run_analysis()
        pairs = [p for p in report["pairs"] if "view-blank" in {p["viewA"], p["viewB"]}]
        self.assertEqual(len(pairs), 2)
        self.assertFalse(any(p["candidateOverlapEdge"] for p in pairs))

    def test_report_is_deterministic_for_same_bytes(self):
        first = self.run_analysis()
        first_pairs = first["pairs"]
        first_graph_hash = first["graphArtifact"]["sha256"]
        second = self.run_analysis(self.root / "out-second")
        self.assertEqual(second["pairs"], first_pairs)
        self.assertEqual(second["graphArtifact"]["sha256"], first_graph_hash)

    def test_rejects_changed_image_bytes_after_verification(self):
        path = self.assets / self.manifest["views"][0]["filename"]
        path.write_bytes(path.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "byte size changed|SHA-256 changed"):
            self.run_analysis()
        self.assertFalse(self.output.exists())

    def test_rejects_wrong_verification_hash(self):
        self.verification["views"][0]["actualSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "passing byte-verification"):
            self.run_analysis()

    def test_rejects_duplicate_pair_identity_and_unsafe_paths(self):
        self.manifest["views"][1]["id"] = self.manifest["views"][0]["id"]
        with self.assertRaisesRegex(ValueError, "duplicate view ID"):
            self.run_analysis()
        self.manifest, self.verification = self.fixture()
        self.manifest["views"][0]["filename"] = "../outside.jpg"
        with self.assertRaisesRegex(ValueError, "unsafe or duplicate filename"):
            self.run_analysis()

    def test_rejects_false_release_flags(self):
        self.manifest["mapReady"] = True
        with self.assertRaisesRegex(ValueError, "mapReady false"):
            self.run_analysis()


if __name__ == "__main__":
    unittest.main()
