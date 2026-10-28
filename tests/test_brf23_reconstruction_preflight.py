from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFLIGHT_PATH = ROOT / "scripts" / "brf23_reconstruction_preflight.py"
PREFLIGHT_SPEC = importlib.util.spec_from_file_location("brf23_reconstruction_preflight", PREFLIGHT_PATH)
PREFLIGHT = importlib.util.module_from_spec(PREFLIGHT_SPEC)
assert PREFLIGHT_SPEC.loader is not None
PREFLIGHT_SPEC.loader.exec_module(PREFLIGHT)

BRF21_TEST_PATH = ROOT / "tests" / "test_brf21_human_review.py"
BRF21_TEST_SPEC = importlib.util.spec_from_file_location("brf21_human_review_test_fixture", BRF21_TEST_PATH)
BRF21_TESTS = importlib.util.module_from_spec(BRF21_TEST_SPEC)
assert BRF21_TEST_SPEC.loader is not None
BRF21_TEST_SPEC.loader.exec_module(BRF21_TESTS)


class Brf23ReconstructionPreflightTests(unittest.TestCase):
    def setUp(self):
        self.fixture = BRF21_TESTS.Brf21HumanReviewTests("test_template_is_hash_bound_and_all_review_fields_pending")
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root
        self.temp_root = self.root.parent
        self.images = self.temp_root / "local-images"
        self.images.mkdir()
        self.profile_path = self.temp_root / "profile.json"
        self.executable = self.temp_root / "fake-colmap"
        self._rebind_test_images()
        self._write_rights_admission()
        self.fixture.template = PREFLIGHT.brf21.prepare_template(self.root)
        self.decision = self.fixture.complete_record()
        self._write_decision(self.decision)
        self._write_fake_colmap("4.2.1")
        self._write_profile()

    def _read_json(self, name):
        return json.loads((self.root / name).read_text(encoding="utf-8"))

    def _write_json(self, path, value):
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def _rebind_test_images(self):
        source = self._read_json("brf-14-multiview-source.json")
        verification = self._read_json("multiview-source-byte-verification.json")
        packet = self._read_json("multiview-review-manifest.json")
        overlap = self._read_json("pairwise-overlap-report.json")
        quality_report = self._read_json("private-multiview-media-intake-report.json")
        by_id = {}
        for view in source["views"]:
            # Exact 128-byte synthetic JPEG-like fixture. Not real imagery.
            view["sourceUrl"] = view.get("sourceUrl") or ("https://example.test/synthetic/" + view["filename"])
            payload = (b"\xff\xd8\xff" + ("synthetic-" + view["id"]).encode("ascii"))
            payload = payload.ljust(128, b"x")[:128]
            (self.images / view["filename"]).write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            by_id[view["id"]] = {"sha256": digest, "byteSize": len(payload)}
            view["expectedSha256"] = digest
            view["expectedByteSize"] = len(payload)
        source["maximumImageBytes"] = 1024
        source["maximumTotalBytes"] = 4096
        source["expectedTotalBytes"] = sum(item["byteSize"] for item in by_id.values())
        for view in verification["views"]:
            data = by_id[view["id"]]
            view["expectedSha256"] = data["sha256"]
            view["actualSha256"] = data["sha256"]
            view["expectedByteSize"] = data["byteSize"]
            view["actualByteSize"] = data["byteSize"]
        self._write_json(self.root / "brf-14-multiview-source.json", source)
        self._write_json(self.root / "multiview-source-byte-verification.json", verification)
        packet["sourceManifest"]["byteVerificationReportSha256"] = \
            PREFLIGHT.brf21.canonical_json_sha256(verification, ensure_ascii=True)
        for view in packet["sourceViews"]:
            data = by_id[view["id"]]
            view["expectedSha256"] = data["sha256"]
            view["actualSha256"] = data["sha256"]
            view["expectedByteSize"] = data["byteSize"]
            view["actualByteSize"] = data["byteSize"]
        self._write_json(self.root / "multiview-review-manifest.json", packet)
        overlap["sourceManifest"]["byteVerificationReportCanonicalJsonSha256"] = \
            PREFLIGHT.brf21.canonical_json_sha256(verification, ensure_ascii=False)
        for view in overlap["views"]:
            data = by_id[view["id"]]
            view["sha256"] = data["sha256"]
            view["byteSize"] = data["byteSize"]
        for pair in overlap["pairs"]:
            pair["sha256A"] = by_id[pair["viewA"]]["sha256"]
            pair["sha256B"] = by_id[pair["viewB"]]["sha256"]
        self._write_json(self.root / "pairwise-overlap-report.json", overlap)

        quality_report["sourceManifest"]["manifestSha256"] = hashlib.sha256(
            (self.root / "brf-14-multiview-source.json").read_bytes()
        ).hexdigest()
        quality_report["sourceManifest"]["priorVerificationReportSha256"] = hashlib.sha256(
            (self.root / "multiview-source-byte-verification.json").read_bytes()
        ).hexdigest()
        source_url_by_id = {view["id"]: view["sourceUrl"] for view in source["views"]}
        for record in quality_report["privateMediaIntake"]["records"]:
            data = by_id[record["sourceId"]]
            record["sha256"] = data["sha256"]
            record["byteSize"] = data["byteSize"]
            record["sourceUrl"] = source_url_by_id[record["sourceId"]]
        for row in quality_report["imageQualityPreflight"]["sources"]:
            data = by_id[row["sourceId"]]
            row["sha256"] = data["sha256"]
            row["byteSize"] = data["byteSize"]
        self._write_json(self.root / "private-multiview-media-intake-report.json", quality_report)

    def _write_rights_admission(self, approved=False):
        source = self._read_json("brf-14-multiview-source.json")
        dataset = source["dataset"]
        assets = []
        for view in source["views"]:
            row = {
                "sourceId": view["id"],
                "filename": view["filename"],
                "sourceUrl": view["sourceUrl"],
                "sourceRepositoryCommit": dataset["sourceRepositoryCommit"],
                "byteSize": view["expectedByteSize"],
                "sha256": view["expectedSha256"],
                "requestedScopes": ["inspect-source", "use-for-validation", "derive-model"],
                "decision": "pending",
                "rights": None,
            }
            if approved:
                evidence_name = "rights-evidence/" + view["id"] + ".txt"
                evidence_dir = self.root / "rights-evidence"
                evidence_dir.mkdir(parents=True, exist_ok=True)
                evidence_bytes = ("Synthetic rights evidence for " + view["id"] + "; fixture only.\n").encode()
                (self.root / evidence_name).write_bytes(evidence_bytes)
                row["decision"] = "approved"
                row["rights"] = {
                    "status": "approved",
                    "rightsHolderOrGrantor": "Synthetic test grantor; not a real rights holder",
                    "authorityBasis": "Synthetic fixture only",
                    "license": {
                        "identifier": "SYNTHETIC-TEST",
                        "name": "Synthetic test license",
                        "url": "https://example.test/license",
                    },
                    "scopeDescription": "Private local reconstruction and validation of synthetic sources only.",
                    "attributionText": "Synthetic test attribution.",
                    "restrictionsText": "Fixture only; no real permission is asserted.",
                    "grantedScopes": ["inspect-source", "use-for-validation", "derive-model"],
                    "evidenceSnapshots": [{
                        "filename": evidence_name,
                        "sourceUrl": "https://example.test/rights/" + view["id"],
                        "retrievedAt": "2026-10-28T00:00:00.000Z",
                        "byteSize": len(evidence_bytes),
                        "sha256": hashlib.sha256(evidence_bytes).hexdigest(),
                        "evidenceType": "synthetic-test-grant-record",
                    }],
                    "reviewedBy": "synthetic-reviewer",
                    "reviewedAt": "2026-10-28T00:00:00.000Z",
                    "decisionId": "synthetic-rights-decision-" + view["id"],
                    "effectiveAt": "2026-10-28T00:00:00.000Z",
                    "expiresAt": None,
                    "revoked": False,
                    "explicitGrantConfirmed": True,
                }
            assets.append(row)
        manifest = {
            "schemaVersion": "1.0.0",
            "recordType": "brf-45-exact-asset-rights-admission",
            "evaluationId": "BRF-45-EXACT-ASSET-RIGHTS-ADMISSION",
            "evaluatedAt": "2026-10-28T00:00:00.000Z",
            "requestedPurpose": "private-local-reconstruction-and-validation",
            "sourceBinding": {
                "sourceManifestFilename": "brf-14-multiview-source.json",
                "sampleId": source["sampleId"],
                "sourceRepositoryCommit": dataset["sourceRepositoryCommit"],
                "declaredLicense": dataset["license"],
                "licenseScope": dataset["licenseScope"],
                "rightsStatus": dataset["rightsStatus"],
            },
            "requiredScopes": ["inspect-source", "use-for-validation", "derive-model"],
            "policy": {
                "inferPermissionFromPublicAvailability": False,
                "repositoryLicenseAloneSufficient": False,
                "requireExactAssetByteBinding": True,
                "requireHumanReview": True,
                "sourceRedistributionRequested": False,
                "publicDerivedModelDisplayRequested": False,
            },
            "assets": assets,
            "releaseFlags": {flag: False for flag in PREFLIGHT.RELEASE_FLAGS},
        }
        self._write_json(self.root / "brf-45-exact-asset-rights-admission.json", manifest)

    def _write_decision(self, decision):
        self._write_json(self.root / "review-decision.json", decision)

    def _write_fake_colmap(self, version):
        body = "#!/usr/bin/env python3\nimport sys\nif sys.argv[1:] != ['version']:\n    raise SystemExit(9)\nprint('COLMAP " + version + "')\n"
        self.executable.write_text(body, encoding="utf-8")
        self.executable.chmod(0o755)

    def _write_profile(self, **overrides):
        profile = {
            "schemaVersion": "1.0.0",
            "profileId": "synthetic-brf23-profile",
            "toolchain": {
                "name": "COLMAP",
                "executable": str(self.executable),
                "expectedVersion": "4.2.1",
                "versionCommand": ["version"]
            },
            "coordinateFrame": {
                "policy": "local-only-no-georeference",
                "frameId": "synthetic-local-frame",
                "units": "unscaled-local",
                "registrationToGps": "not-established"
            },
            "execution": {
                "preflightOnly": True,
                "runReconstruction": False,
                "generateCandidateGlb": False
            }
        }
        for key, value in overrides.items():
            profile[key] = value
        self._write_json(self.profile_path, profile)
        return profile

    def _assess(self, decision_name="review-decision.json"):
        return PREFLIGHT.assess(self.root, self.images, decision_name, self.profile_path,
                                "reconstruction-preflight-report.json")

    def test_reviewed_hash_pinned_local_inputs_can_only_pass_preflight(self):
        self._write_rights_admission(approved=True)
        report = self._assess()
        self.assertEqual(report["status"], "preflight-ready-for-local-reconstruction-attempt", report["blockers"])
        self.assertEqual(report["assessedInputs"]["sourceImages"]["verifiedCount"], 3)
        rights = report["assessedInputs"]["rightsAdmission"]
        self.assertEqual(rights["filename"], "brf-45-exact-asset-rights-admission.json")
        self.assertEqual(rights["assetCount"], 3)
        self.assertEqual(rights["pendingDecisionCount"], 0)
        self.assertEqual(rights["deniedDecisionCount"], 0)
        self.assertEqual(rights["sha256"], hashlib.sha256(
            (self.root / rights["filename"]).read_bytes()
        ).hexdigest())
        self.assertEqual(report["assessedInputs"]["imageQualityPreflight"]["status"], "all-images-decoded-and-measured")
        self.assertIs(report["assessedInputs"]["imageQualityPreflight"]["rightsApproved"], False)
        self.assertIs(report["assessedInputs"]["imageQualityPreflight"]["safeToSubmitToColmap"], False)
        self.assertEqual(report["toolchain"]["actualVersion"], "4.2.1")
        self.assertEqual(report["coordinateFrame"]["registrationToGps"], "not-established")
        self.assertFalse(report["reconstructionExecuted"])
        self.assertFalse(report["candidateGlbGenerated"])
        self.assertFalse(report["independentReferenceVerified"])
        for flag in PREFLIGHT.RELEASE_FLAGS:
            self.assertIs(report[flag], False)

    def test_pending_rights_admission_blocks_even_when_human_review_would_continue(self):
        report = self._assess()
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["assessedInputs"]["humanDecision"]["validationStatus"], "valid")
        self.assertEqual(report["assessedInputs"]["rightsAdmission"]["pendingDecisionCount"], 3)
        self.assertTrue(any("BRF-45 exact-asset rights admission has pending source rows" in item
                            for item in report["blockers"]))
        self.assertFalse(report["candidateGlbGenerated"])
        for flag in PREFLIGHT.RELEASE_FLAGS:
            self.assertFalse(report[flag])

    def test_rights_admission_must_match_all_source_hashes_and_metadata(self):
        manifest = self._read_json("brf-45-exact-asset-rights-admission.json")
        manifest["assets"][0]["sha256"] = "f" * 64
        self._write_json(self.root / "brf-45-exact-asset-rights-admission.json", manifest)
        with self.assertRaisesRegex(ValueError, "does not match the exact source bytes"):
            self._assess()

    def test_missing_rights_admission_register_blocks_preflight(self):
        (self.root / "brf-45-exact-asset-rights-admission.json").unlink()
        with self.assertRaisesRegex(ValueError, "Required artifact is missing"):
            self._assess()

    def test_blank_human_review_template_stays_blocked_even_if_other_checks_pass(self):
        self._write_json(self.root / "pending-template.json", self.fixture.template)
        report = self._assess("pending-template.json")
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["assessedInputs"]["humanDecision"]["validationStatus"], "invalid-or-pending")
        self.assertTrue(any("Human review decision failed validation" in item for item in report["blockers"]))
        self.assertFalse(report["candidateGlbGenerated"])
        for flag in PREFLIGHT.RELEASE_FLAGS:
            self.assertFalse(report[flag])

    def test_modified_source_image_hash_blocks_preflight(self):
        target = self.images / "view-a.jpg"
        target.write_bytes(b"\xff\xd8\xff" + b"tampered".ljust(125, b"z"))
        report = self._assess()
        self.assertEqual(report["status"], "blocked")
        self.assertTrue(any("SHA-256 mismatch" in item for item in report["blockers"]), repr(report["blockers"]))

    def test_source_image_symlink_is_rejected(self):
        target = self.images / "view-a.jpg"
        target.unlink()
        target.symlink_to(self.images / "view-b.jpg")
        report = self._assess()
        self.assertEqual(report["status"], "blocked")
        self.assertTrue(any("non-symlink" in item for item in report["blockers"]), repr(report["blockers"]))

    def test_missing_colmap_executable_blocks_preflight(self):
        profile = self._write_profile()
        profile["toolchain"]["executable"] = "brf23-no-such-colmap-executable"
        self._write_json(self.profile_path, profile)
        report = self._assess()
        self.assertEqual(report["status"], "blocked")
        self.assertIn("not found on PATH", report["toolchain"]["reason"])

    def test_colmap_version_mismatch_blocks_preflight(self):
        self._write_fake_colmap("4.2.0")
        report = self._assess()
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["toolchain"]["actualVersion"], "4.2.0")
        self.assertTrue(any("exact pinned version" in item for item in report["blockers"]))

    def test_unverified_world_registration_profile_is_rejected(self):
        profile = self._write_profile()
        profile["coordinateFrame"]["policy"] = "gps-registered"
        self._write_json(self.profile_path, profile)
        with self.assertRaisesRegex(ValueError, "local-only-no-georeference"):
            self._assess()

    def test_profile_cannot_enable_reconstruction_or_glb_generation(self):
        profile = self._write_profile()
        profile["execution"]["runReconstruction"] = True
        self._write_json(self.profile_path, profile)
        with self.assertRaisesRegex(ValueError, "disable reconstruction"):
            self._assess()

    def test_preflight_report_is_deterministic_except_for_external_path_metadata(self):
        first = self._assess()
        second = self._assess()
        self.assertEqual(first["status"], second["status"])
        self.assertEqual(first["blockers"], second["blockers"])
        self.assertEqual(first["assessedInputs"]["sourceImages"], second["assessedInputs"]["sourceImages"])
        self.assertEqual(first["toolchain"]["actualVersion"], second["toolchain"]["actualVersion"])


if __name__ == "__main__":
    unittest.main()
