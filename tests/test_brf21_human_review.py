from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "brf21_human_review.py"
SPEC = importlib.util.spec_from_file_location("brf21_human_review", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class Brf21HumanReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "artifacts"
        self.root.mkdir()
        self.create_evidence()
        self.template = MODULE.prepare_template(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def write_json(self, filename, payload):
        (self.root / filename).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def artifact_record(self, filename):
        path = self.root / filename
        return {"filename": filename, "byteSize": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def create_evidence(self):
        # These are synthetic test fixtures, not a review of the real BRF-14 building.
        png_header = b"\x89PNG\r\n\x1a\n"
        (self.root / "multiview-contact-sheet.png").write_bytes(png_header + b"synthetic-contact-sheet")
        (self.root / "camera-angle-coverage.png").write_bytes(png_header + b"synthetic-camera-coverage")
        (self.root / "pairwise-overlap-graph.png").write_bytes(png_header + b"synthetic-overlap-graph")
        view_ids = ["view-a", "view-b", "view-c"]
        views = []
        for view_id in view_ids:
            image_hash = hashlib.sha256(("source-image-" + view_id).encode()).hexdigest()
            views.append({"id": view_id, "filename": view_id + ".jpg",
                          "expectedSha256": image_hash, "actualSha256": image_hash,
                          "expectedByteSize": 128, "actualByteSize": 128,
                          "review": {"sameBuildingIdentity": "pending"}})
        source_manifest = {
            "schemaVersion": "1.0.0", "sampleId": "synthetic-test-only",
            "evaluationStage": "multiview-source-byte-intake-only",
            "dataset": {"sourceRepositoryCommit": "test-commit"},
            "selectionMethod": {"expectedViewCount": 3}, "expectedTotalBytes": 384,
            "views": [{"id": view["id"], "filename": view["filename"],
                       "expectedSha256": view["expectedSha256"], "expectedByteSize": 128} for view in views],
            "acceptanceEligible": False, "publicationEligible": False, "mapReady": False, "automaticApproval": False,
        }
        verification_views = [{"id": view["id"], "filename": view["filename"], "status": "passed",
                               "expectedSha256": view["expectedSha256"], "actualSha256": view["actualSha256"],
                               "expectedByteSize": 128, "actualByteSize": 128} for view in views]
        verification = {
            "schemaVersion": "1.0.0", "sampleId": "synthetic-test-only", "status": "views-byte-verified",
            "checkedAt": "2026-10-27T00:00:00Z", "dataset": {"sourceRepositoryCommit": "test-commit"},
            "selectedViewCount": 3, "declaredTotalBytes": 384, "actualTotalBytes": 384,
            "views": verification_views, "blockers": [], "candidateGlbGenerated": False,
            "independentReferenceVerified": False, "acceptanceEligible": False,
            "publicationEligible": False, "mapReady": False, "automaticApproval": False,
        }
        self.write_json("brf-14-multiview-source.json", source_manifest)
        self.write_json("multiview-source-byte-verification.json", verification)
        verification_sha = MODULE.canonical_json_sha256(verification)
        packet = {
            "schemaVersion": "1.0.0",
            "sampleId": "synthetic-test-only",
            "evaluationStage": "multiview-human-review-packet-only",
            "status": "review-packet-generated-pending-human-review",
            "dataset": {"sourceRepositoryCommit": "test-commit"},
            "sourceManifest": {"metadataCommit": "test-commit", "selectedViewCount": 3,
                               "declaredTotalBytes": 384, "actualTotalBytes": 384,
                               "byteVerificationStatus": "views-byte-verified",
                               "byteVerificationReportSha256": verification_sha},
            "sourceViews": views,
            "outputArtifacts": {
                "contactSheet": self.artifact_record("multiview-contact-sheet.png"),
                "cameraCoveragePlot": self.artifact_record("camera-angle-coverage.png"),
            },
            "rawImageBytesIncluded": False,
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        }
        self.write_json("multiview-review-manifest.json", packet)
        pairs = [
            {"viewA": "view-a", "viewB": "view-b", "filenameA": "view-a.jpg", "filenameB": "view-b.jpg",
             "sha256A": views[0]["expectedSha256"], "sha256B": views[1]["expectedSha256"], "candidateOverlapEdge": True,
             "ratioFilteredMatchCount": 40, "geometricInlierCount": 32},
            {"viewA": "view-a", "viewB": "view-c", "filenameA": "view-a.jpg", "filenameB": "view-c.jpg",
             "sha256A": views[0]["expectedSha256"], "sha256B": views[2]["expectedSha256"], "candidateOverlapEdge": False,
             "ratioFilteredMatchCount": 2, "geometricInlierCount": 0},
            {"viewA": "view-b", "viewB": "view-c", "filenameA": "view-b.jpg", "filenameB": "view-c.jpg",
             "sha256A": views[1]["expectedSha256"], "sha256B": views[2]["expectedSha256"], "candidateOverlapEdge": True,
             "ratioFilteredMatchCount": 21, "geometricInlierCount": 18},
        ]
        report = {
            "schemaVersion": "1.0.0",
            "sampleId": "synthetic-test-only",
            "evaluationStage": "pairwise-image-feature-overlap-triage-only",
            "status": "pairwise-analysis-complete-needs-human-review",
            "sourceManifest": {"metadataCommit": "test-commit", "selectedViewCount": 3,
                               "declaredTotalBytes": 384, "actualTotalBytes": 384,
                               "byteVerificationStatus": "views-byte-verified",
                               "byteVerificationReportCanonicalJsonSha256": verification_sha},
            "views": [{"id": view["id"], "filename": view["filename"], "sha256": view["actualSha256"], "byteSize": 128}
                      for view in views],
            "pairs": pairs,
            "counts": {"views": 3, "evaluatedPairs": 3},
            "graphArtifact": self.artifact_record("pairwise-overlap-graph.png"),
            "rawImageBytesIncluded": False,
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        }
        self.write_json("pairwise-overlap-report.json", report)

    def complete_record(self):
        result = json.loads(json.dumps(self.template))
        result["reviewer"] = {"name": "Synthetic Reviewer", "identifier": "test:reviewer"}
        result["reviewedAtUtc"] = "2026-10-27T15:00:00Z"
        result["overallDisposition"] = "continue-to-reconstruction-preflight"
        result["overallRationale"] = "Synthetic fixture rationale that explains the limited review decision."
        result["sameBuildingIdentity"] = {
            "decision": "confirmed",
            "rationale": "Synthetic fixtures have a deliberately shared building identity.",
        }
        result["coverageAssessment"] = {
            "decision": "adequate",
            "rationale": "Synthetic fixture covers enough views for the contract test only.",
        }
        for view in result["sourceViews"]:
            view["visibleSurfaces"] = ["roof", "facade"]
            view["occlusion"] = "none"
            view["imageQuality"] = "usable"
            view["decision"] = "include"
            view["rationale"] = "Synthetic fixture view marked usable for the test."
        for pair in result["pairReviews"]:
            key = {pair["viewA"], pair["viewB"]}
            pair["decision"] = "useful-overlap" if key in ({"view-a", "view-b"}, {"view-b", "view-c"}) else "no-useful-overlap"
            pair["rationale"] = "Synthetic pair decision is explicit and test-only."
        result["sourceUpAxis"] = {
            "decision": "confirmed", "axis": "Z", "positiveDirection": "positive",
            "interpretation": "Synthetic test convention uses positive Z as up.",
            "rationale": "Synthetic axis decision is present only to exercise validation.",
        }
        result["assetRights"] = {
            "decision": "approved-for-this-use", "termsSourceUrl": "https://example.org/synthetic-license",
            "rationale": "Synthetic test-only rights decision, not a real licence review.",
        }
        result["reviewNotes"] = "Synthetic fixture only; not a decision about the real sample."
        return result

    def test_template_is_hash_bound_and_all_review_fields_pending(self):
        self.assertEqual(self.template["status"], "pending-human-review")
        self.assertEqual(len(self.template["evidenceBindings"]), 7)
        self.assertEqual(len(self.template["sourceViews"]), 3)
        self.assertEqual(len(self.template["pairReviews"]), 3)
        for item in self.template["sourceViews"]:
            self.assertEqual(item["decision"], "pending")
        for item in self.template["pairReviews"]:
            self.assertEqual(item["decision"], "pending")
        for flag in MODULE.RELEASE_FLAGS:
            self.assertIs(self.template[flag], False)

    def test_validation_report_is_deterministic_for_identical_inputs(self):
        decision = self.complete_record()
        self.assertEqual(MODULE.validate_decision(self.root, decision), MODULE.validate_decision(self.root, decision))

    def test_complete_synthetic_record_validates_without_opening_release_gates(self):
        report = MODULE.validate_decision(self.root, self.complete_record())
        self.assertEqual(report["status"], "human-review-record-complete")
        self.assertEqual(report["overallDisposition"], "continue-to-reconstruction-preflight")
        self.assertEqual(report["reviewCounts"]["humanConfirmedUsefulOverlapPairs"], 2)
        for flag in MODULE.RELEASE_FLAGS:
            self.assertIs(report[flag], False)

    def test_pending_template_cannot_be_validated_as_complete(self):
        with self.assertRaisesRegex(ValueError, "reviewer.name|reviewedAtUtc|overallDisposition"):
            MODULE.validate_decision(self.root, self.template)

    def test_uncertain_disposition_is_preserved_and_never_promoted(self):
        decision = self.complete_record()
        decision["overallDisposition"] = "uncertain"
        decision["sameBuildingIdentity"]["decision"] = "uncertain"
        decision["coverageAssessment"]["decision"] = "uncertain"
        decision["sourceUpAxis"]["decision"] = "ambiguous"
        decision["sourceUpAxis"]["axis"] = "unknown"
        decision["sourceUpAxis"]["positiveDirection"] = "unknown"
        decision["assetRights"]["decision"] = "uncertain"
        report = MODULE.validate_decision(self.root, decision)
        self.assertEqual(report["overallDisposition"], "uncertain")
        for flag in MODULE.RELEASE_FLAGS:
            self.assertFalse(report[flag])

    def test_missing_reviewer_is_rejected(self):
        decision = self.complete_record()
        decision["reviewer"]["name"] = " "
        with self.assertRaisesRegex(ValueError, "reviewer.name"):
            MODULE.validate_decision(self.root, decision)

    def test_missing_or_non_utc_timestamp_is_rejected(self):
        decision = self.complete_record()
        decision["reviewedAtUtc"] = "2026-10-27T15:00:00+00:00"
        with self.assertRaisesRegex(ValueError, "ending in Z"):
            MODULE.validate_decision(self.root, decision)

    def test_changed_image_graph_invalidates_evidence_binding(self):
        decision = self.complete_record()
        (self.root / "pairwise-overlap-graph.png").write_bytes(b"changed-after-review")
        with self.assertRaisesRegex(ValueError, "graph bytes|Evidence binding mismatch"):
            MODULE.validate_decision(self.root, decision)

    def test_unknown_view_id_is_rejected(self):
        decision = self.complete_record()
        decision["sourceViews"][0]["id"] = "not-a-known-view"
        with self.assertRaisesRegex(ValueError, "unknown view ID"):
            MODULE.validate_decision(self.root, decision)

    def test_unknown_pair_is_rejected(self):
        decision = self.complete_record()
        decision["pairReviews"][0]["viewB"] = "unknown-view"
        with self.assertRaisesRegex(ValueError, "unknown or invalid view pair"):
            MODULE.validate_decision(self.root, decision)

    def test_confirmed_unknown_axis_is_rejected(self):
        decision = self.complete_record()
        decision["sourceUpAxis"]["axis"] = "unknown"
        with self.assertRaisesRegex(ValueError, "confirmed source up-axis"):
            MODULE.validate_decision(self.root, decision)

    def test_attempt_to_open_release_flag_is_rejected(self):
        decision = self.complete_record()
        decision["mapReady"] = True
        with self.assertRaisesRegex(ValueError, "mapReady false"):
            MODULE.validate_decision(self.root, decision)

    def test_continue_requires_connected_useful_overlap_graph(self):
        decision = self.complete_record()
        for pair in decision["pairReviews"]:
            pair["decision"] = "no-useful-overlap"
        with self.assertRaisesRegex(ValueError, "connected graph"):
            MODULE.validate_decision(self.root, decision)

    def test_path_traversal_and_symlink_artifacts_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "simple filename"):
            MODULE.safe_file(self.root, "../pairwise-overlap-report.json")
        target = self.root / "camera-angle-coverage.png"
        moved = self.root / "camera-angle-real.png"
        target.rename(moved)
        target.symlink_to(moved.name)
        with self.assertRaisesRegex(ValueError, "symlink"):
            MODULE.prepare_template(self.root)

    def test_source_manifest_hash_mismatch_is_rejected(self):
        decision = self.complete_record()
        manifest_path = self.root / "brf-14-multiview-source.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["views"][0]["expectedSha256"] = "0" * 64
        self.write_json(manifest_path.name, manifest)
        with self.assertRaisesRegex(ValueError, "BRF-20 source image hash/size disagrees"):
            MODULE.validate_decision(self.root, decision)

    def test_byte_verification_report_provenance_mismatch_is_rejected(self):
        decision = self.complete_record()
        verification_path = self.root / "multiview-source-byte-verification.json"
        verification = json.loads(verification_path.read_text(encoding="utf-8"))
        verification["views"][0]["actualSha256"] = "0" * 64
        self.write_json(verification_path.name, verification)
        with self.assertRaisesRegex(ValueError, "failed exact byte verification"):
            MODULE.validate_decision(self.root, decision)

    def test_pair_side_source_hash_mismatch_is_rejected(self):
        decision = self.complete_record()
        report_path = self.root / "pairwise-overlap-report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report["pairs"][0]["sha256A"] = "0" * 64
        self.write_json(report_path.name, report)
        with self.assertRaisesRegex(ValueError, "pair-side hash/filename"):
            MODULE.validate_decision(self.root, decision)

    def test_review_decision_cannot_change_candidate_edge_evidence(self):
        decision = self.complete_record()
        decision["pairReviews"][0]["candidateOverlapEdge"] = not decision["pairReviews"][0]["candidateOverlapEdge"]
        with self.assertRaisesRegex(ValueError, "candidateOverlapEdge was changed"):
            MODULE.validate_decision(self.root, decision)


if __name__ == "__main__":
    unittest.main()
