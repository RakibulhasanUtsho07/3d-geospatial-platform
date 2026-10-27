import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "inspect-usgs-laz-tile.py"
MANIFEST_PATH = ROOT / "benchmarks" / "building-reconstruction" / "brf-16-central-mississippi-laz-tile.json"
SPEC = importlib.util.spec_from_file_location("inspect_usgs_laz_tile", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class InspectUsgsLazTileTests(unittest.TestCase):
    def test_manifest_is_pinned_to_expected_candidate_tile_and_keeps_release_flags_false(self):
        manifest = MODULE.read_manifest(MANIFEST_PATH)
        self.assertEqual(manifest["dataset"]["sourceId"], "65078ad9d34eb6693be8c524")
        self.assertEqual(manifest["dataset"]["format"], "LAZ")
        self.assertEqual(manifest["dataset"]["expectedByteSize"], 83659396)
        self.assertFalse(manifest["acceptanceEligible"])
        self.assertFalse(manifest["publicationEligible"])
        self.assertFalse(manifest["mapReady"])
        self.assertFalse(manifest["automaticApproval"])

    def test_manifest_rejects_unpinned_or_unsafe_download_url(self):
        original = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        original["dataset"]["downloadUrl"] = "https://example.com/not-a-laz.laz"
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_text(json.dumps(original), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "allowlisted USGS LAZ"):
                MODULE.read_manifest(manifest_path)

    def test_manifest_rejects_accidentally_enabled_release_flags(self):
        original = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        original["mapReady"] = True
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_text(json.dumps(original), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "mapReady must remain false"):
                MODULE.read_manifest(manifest_path)

    def test_inspector_rejects_short_download_before_needing_las_parser(self):
        with tempfile.TemporaryDirectory() as directory:
            file_path = Path(directory) / "short.laz"
            file_path.write_bytes(b"not-a-laz")
            with self.assertRaisesRegex(ValueError, "differs from expected size"):
                MODULE.inspect_laz(MANIFEST_PATH, file_path)

    def test_inspector_rejects_symlink_input(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target.bin"
            target.write_bytes(b"x")
            link = Path(directory) / "tile.laz"
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("Symlinks are not available in this test environment.")
            with self.assertRaisesRegex(ValueError, "non-symlink"):
                MODULE.inspect_laz(MANIFEST_PATH, link)

    def test_inspector_rejects_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.laz"
            with self.assertRaises(FileNotFoundError):
                MODULE.inspect_laz(MANIFEST_PATH, missing)


if __name__ == "__main__":
    unittest.main()
